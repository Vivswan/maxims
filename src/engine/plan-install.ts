// One install attempt over the refreshed sources: admission, bodies, rule files, hooks and the
// sweeps, as one plan. `planSync` retries it until no source is refused.

import { join, resolve } from "node:path";
import { heldForReview } from "../console/strings.ts";
import type { HarnessId } from "../contracts/harness-id.ts";
import type { Scope } from "../harnesses/contract.ts";
import type { ContentHash, MemoryName } from "../memory/contract.ts";
import {
  buildNameIndex,
  type IndexedSource,
  type Resolution,
  resolveSourceCandidates,
} from "../rulefile/dedupe.ts";
import { type RuleLine, staleSentence } from "../rulefile/types.ts";
import type { State } from "../state/schema.ts";
import { serializeState, WRITTEN_BY } from "../state/store.ts";
import { ExitCode } from "../util/exit-codes.ts";
import { assertInsideRoot, isSymlink, realKeyOf } from "../util/fs.ts";
import { homePaths, pendingPathFor, storePathFor } from "../util/home.ts";
import { planBodies, planBodySweep } from "./bodies.ts";
import { actsHere, agentsAllowed, type EngineContext } from "./context.ts";
import { resolveTargets } from "./destination.ts";
import { destinationUnresolvable } from "./fs-probe.ts";
import { hookedAt, planHooks } from "./hooks.ts";
import type { SourceMemory, SourceTree } from "./memories.ts";
import { Notices } from "./notices.ts";
import { planOrphanSweep } from "./orphans.ts";
import { PlanBuilder } from "./plan.ts";
import type { SyncExtras, SyncFailure } from "./plan-sync.ts";
import {
  changingBlocks,
  LinkedAtRuleFile,
  planRulesDirSweep,
  type RuleFile,
  type RuleFileHeld,
} from "./rules.ts";
import { disabledNames, selectMemories } from "./select.ts";
import { sourceSlug } from "./slug.ts";
import { allBodiesDirs, bodiesDirsFor, outDetailPath, outRuleFile } from "./sync-dirs.ts";
import {
  linkJudge,
  type Retained,
  refuseLinksThroughRuleFiles,
  unhandledRetained,
} from "./sync-links.ts";
import { isFetchedEntry, type Refreshed, recordedCopies, widenedAgents } from "./sync-refresh.ts";
import { INSTALLED_FIRST, retainedNames } from "./sync-retained.ts";
import {
  addReaders,
  addSharedFilesWithOrphans,
  detailPathFor,
  fileIdentity,
  harnessFile,
  newestBlock,
  removedOutRuleFiles,
  renderFiles,
  supportsPathScoping,
} from "./sync-rule-files.ts";
import {
  installedRoot,
  installedTree,
  readTrees,
  type SourceWork,
  type StoreOverlay,
} from "./sync-trees.ts";
import type { EngineIo, SyncOptions, SyncReport } from "./types.ts";

type Refusal = { key: string; said: Notices; failure: SyncFailure | null };

//   failed          -> live sources whose directory could not be read this run
//   awaitingReview  -> sources with a revision held for review at the end of this run, made now
//                      or earlier, with what it changes: a session hears about a waiting revision
//                      at every start, as it does about a stale source
type Attempt = {
  builder: PlanBuilder;
  notices: Notices;
  failures: SyncFailure[];
  refusals: Refusal[];
  refusedFresh: string[];
  refusedKept: string[];
  failed: SyncReport["failed"];
  awaitingReview: { key: string; summary: string[] }[];
  heldFiles: string[];
  stale: string[];
  hookRun: boolean;
  sources: number;
  memories: number;
  rules: number;
  tokens: number;
  nextState: State;
};

export async function planInstall(
  state: State,
  ctx: EngineContext,
  io: EngineIo,
  options: SyncOptions,
  extras: SyncExtras,
  refreshed: Refreshed,
  held: ReadonlySet<string>,
  overlay: StoreOverlay,
): Promise<Attempt> {
  const notices = new Notices();
  const builder = new PlanBuilder();
  const failures: SyncFailure[] = [];
  const refusals: Refusal[] = [];
  const refusedFresh: string[] = [];
  const refusedKept: string[] = [];
  // Said for every source standing held, admitted or not: a refused source keeps the very block
  // the held revision would replace, so the hold is as live for it as for an admitted one.
  const awaitingReview: Attempt["awaitingReview"] = [];
  const heldFiles: string[] = [];
  const stale: string[] = [];
  for (const [key, entry] of Object.entries(refreshed.sources)) {
    if (!actsHere(entry, ctx) || !isFetchedEntry(entry) || entry.pending === undefined) continue;
    awaitingReview.push({ key, summary: entry.pending.summary });
    notices.loud(heldForReview(key, entry.pending.summary.length));
  }
  // A source refused whole: `said` carries its lines on the channel the reason earns, `failure`
  // what the verb exits with, or null where the reason fails no verb this run. `record` alone
  // is for a reason already said, a held file several sources render into.
  const record = (key: string, said: Notices, failure: SyncFailure | null): void => {
    refusals.push({ key, said, failure });
    if (refreshed.freshTrees.has(key)) refusedFresh.push(key);
    else refusedKept.push(key);
  };
  const refuse = (key: string, said: Notices, failure: SyncFailure | null): void => {
    notices.absorb(said);
    if (failure !== null) failures.push(failure);
    record(key, said, failure);
  };
  const read = await readTrees(refreshed, held, overlay, ctx, notices);
  const { works } = read;
  // Blocks kept in a file this run renders none for: an unreadable or refused source keeps its
  // last-good block only where its intent still puts one, so a harness the user dropped loses it
  // like any other. Keyed by real path, as the rule files are, so two spellings of one file agree.
  const keepAt = new Map<string, Set<string>>();
  const keepBlock = (key: string, realKey: string): void => {
    const kept = keepAt.get(realKey) ?? new Set<string>();
    kept.add(key);
    keepAt.set(realKey, kept);
  };
  const files = new Map<string, RuleFile>();
  // Real paths of the rule files this run plans (or keeps), the identity the sweep compares by.
  const planned = new Set<string>();
  // A held file keeps its bytes: it stays planned so the sweep leaves it, and its lines go out
  // loud, since the block a session expects gone is still loaded. A hold that leaves the rules
  // current fails only the remove verb: the user asked for that removal by name, and a hook run
  // must stay exit 0. A hold over a block no run can refresh fails every verb.
  //
  // The held block's detail lines link its source's store entry, so a source with work this run
  // is refused whole, like an over-budget one, when it has a block in the file (`owner`, set only
  // then by the reservation's read) or renders into it (`files`, the render's). The reservation
  // precedes every block request, and a run limited by -a requests none outside its filter.
  const workKeys = new Set(works.map((work) => work.key));
  const holds = new Map<string, Pick<Refusal, "said" | "failure"> & { frozen: Set<string> }>();
  const takeHold = (hold: RuleFileHeld, owner?: string): void => {
    const realKey = realKeyOf(hold.path);
    let taken = holds.get(realKey);
    if (taken === undefined) {
      planned.add(realKey);
      heldFiles.push(hold.path);
      const said = new Notices();
      said.loud(`maxims: ${hold.message}`);
      if (hold.hint !== undefined) said.loud(`maxims: ${hold.hint}`);
      const failure: SyncFailure | null =
        extras.verb !== "remove" && hold.fails === "remove"
          ? null
          : {
              code: ExitCode.DestinationWriteFailed,
              message: hold.message,
              ...(hold.hint === undefined ? {} : { hint: hold.hint }),
            };
      notices.absorb(said);
      if (failure !== null) failures.push(failure);
      taken = { said, failure, frozen: new Set() };
      holds.set(realKey, taken);
    }
    const frozen = taken;
    const freeze = (key: string): void => {
      if (!workKeys.has(key) || frozen.frozen.has(key)) return;
      frozen.frozen.add(key);
      record(key, frozen.said, frozen.failure);
    };
    if (owner !== undefined) freeze(owner);
    for (const file of files.values()) {
      if (fileIdentity(file) !== realKey) continue;
      for (const block of file.blocks) freeze(block.key);
    }
  };
  // A link at a rule file's path holds nothing while this run writes or deletes the path: either
  // replaces the link and never reaches the file behind it. A link no change replaces (a hook run
  // defers its deletions) stays, its block loaded, and is held like a file. Which it is is known
  // once every file is rendered.
  const linkedHolds: { hold: RuleFileHeld; owner: string | undefined }[] = [];
  const reserveHold = (hold: RuleFileHeld, owner: string | undefined): void => {
    if (isSymlink(hold.path)) linkedHolds.push({ hold, owner });
    else takeHold(hold, owner);
  };
  // What a source holds on disk enters the name index first, dated before every source, so a memory
  // another source newly ships under an installed name collides instead of taking the body over.
  // Ambiguity and ownership read one snapshot: every installed tree as the state as read left it.
  //   its names        the installed copy read through the selection, else the state's fetch
  //                    record; plus what its blocks and its bodies directories name
  //   a dropped name   leaves a block this run rewrites, and a hook run defers deletions: a
  //                    linked body reserves it until an interactive run sweeps it, a copy only
  //                    while the store copy still holds its bytes
  //   shared bytes     a copy several sources hold installed has no owner; the dedupe rule decides
  const installedTrees = new Map<string, SourceTree | null>();
  const hashOwners = new Map<ContentHash, number>();
  for (const [key, entry] of Object.entries(extras.previousState.sources)) {
    const tree = await installedTree(installedRoot(entry, ctx), entry.intent);
    installedTrees.set(key, tree);
    for (const hash of new Set((tree?.memories ?? []).map((memory) => memory.memory.contentHash))) {
      hashOwners.set(hash, (hashOwners.get(hash) ?? 0) + 1);
    }
  }
  const ambiguous = new Set([...hashOwners].filter(([, count]) => count > 1).map(([hash]) => hash));
  const installedFirst: IndexedSource[] = [];
  for (const key of [...works.map((work) => work.key), ...read.unreadable.map((s) => s.key)]) {
    const entry = extras.previousState.sources[key];
    installedFirst.push({
      key,
      addedAt: INSTALLED_FIRST,
      intent: { select: "*", rename: {} },
      names:
        entry === undefined
          ? []
          : await retainedNames(
              key,
              entry,
              ctx,
              io,
              (held, owned) => reserveHold(held, owned ? key : undefined),
              ambiguous,
              installedTrees.get(key) ?? null,
            ),
    });
  }
  const index = buildNameIndex([
    ...installedFirst,
    ...works.map((work) => ({
      key: work.key,
      addedAt: work.entry.addedAt,
      intent: work.intent,
      names: work.ownedUpstreamNames,
    })),
  ]);
  const unreachable = new Set<string>();
  // Bodies to keep per directory: every admitted or refused source's, whatever `-a` limited this
  // run to, so a sweep never takes a body another harness's rule line points at. A directory an
  // unreadable source writes to is not swept at all, since its names are unknown this run.
  const bodiesWanted = new Map<string, { dir: string; root: string; wanted: Set<string> }>();
  const unsweepable = new Set<string>();
  const dirsByKey = new Map<string, string[]>();
  // A regular file in a bodies directory is ours when its bytes match a memory this run knows:
  // the trees read now, the previous fetch facts (a copy written before upstream changed), and
  // what the caller just removed.
  const knownCopies = new Set<ContentHash>([
    ...extras.removedCopies,
    ...recordedCopies(Object.values(extras.previousState.sources)),
  ]);
  const symlink = await io.symlinkSupport();
  const hookRun = extras.verb === "sync" && options.quiet;
  const agents = widenedAgents(options.agents, refreshed);
  const explicit = options.agents ?? [];
  // Rule files this run renders no block into although their source is still installed, kept for
  // the sweep and the link judgment. A rules-dir file is written whole, so wherever it is visited
  // the block is kept and the harness counted among its readers; a `-o` file has no reader to count.
  const retained: Retained[] = [];
  let memories = 0;

  for (const work of works) {
    const { intent, key } = work;
    const disabled = disabledNames(state, work.scopeKind, ctx.projectRoot);
    const selection = selectMemories({
      memories: work.tree.memories,
      intent,
      installInternal: ctx.installInternal,
      disabled,
      detailPath: () => "",
    });
    memories += selection.selected.length;
    // Said with the fetch that brought the memories in, never repeated by a run that fetched
    // nothing: an interactive sync and the log would otherwise carry it every run.
    if (selection.hiddenInternal > 0 && refreshed.freshTrees.has(key)) {
      notices.notice(`maxims: ${key}: ${selection.hiddenInternal} internal, hidden`);
    }
    for (const memory of work.tree.memories) knownCopies.add(memory.memory.contentHash);
    if (work.stale !== undefined) stale.push(key);
    staleNotices(work, notices);
    const slug = sourceSlug(intent.from);
    const resolved =
      work.scopeKind === "out"
        ? { targets: [], skipped: [] }
        : resolveTargets({
            intent,
            scope: work.scopeKind,
            sourceSlug: slug,
            ctx,
            harnesses: io.harnesses,
            agents: undefined,
            explicit,
          });
    const targets = {
      targets: resolved.targets.filter((target) => agentsAllowed(agents, target.def.id)),
      skipped: resolved.skipped.filter((skipped) => agentsAllowed(agents, skipped.id)),
    };
    if (intent.rule) {
      for (const target of resolved.targets) {
        if (!agentsAllowed(agents, target.def.id)) retained.push({ key, kind: "harness", target });
      }
    }
    for (const skipped of targets.skipped) {
      notices.notice(`maxims: ${key}: skipped ${skipped.id} (${skipped.reason})`);
    }
    for (const skipped of resolved.skipped) {
      if (skipped.kind === "unreachable") unreachable.add(`${skipped.id}@${work.scopeKind}`);
    }
    const allDirs = bodiesDirsFor(work, ctx, io, undefined);
    dirsByKey.set(
      key,
      allDirs.map((dir) => dir.id),
    );
    // A source whose names collide, or whose rule set is over the cap, is refused whole: neither
    // its bodies nor its blocks land, its fresh fetch is not kept, and whatever it has on disk
    // stays, bodies included, since the names it installed before are not known this run.
    const admission = resolveSourceCandidates({
      source: key,
      memories: selection.selected.map((selected) => selected.candidate),
      select: intent.select,
      rename: intent.rename,
      index,
      cap: intent.rule ? ctx.ruleCap : Number.MAX_SAFE_INTEGER,
    });
    if (!admission.ok) {
      for (const target of targets.targets) {
        planned.add(target.realKey);
        keepBlock(key, target.realKey);
      }
      if (intent.destination.scope === "out" && intent.rule) {
        keepBlock(key, realKeyOf(outRuleFile(intent.destination.path, slug)));
      }
      for (const dir of allDirs) unsweepable.add(dir.id);
      const refusal = resolutionFailure(key, admission);
      refuse(key, refusal.said, refusal.failure);
      continue;
    }
    for (const dir of allDirs) {
      const wanted = bodiesWanted.get(dir.id) ?? { ...dir, wanted: new Set<string>() };
      bodiesWanted.set(dir.id, wanted);
      for (const selected of selection.selected) wanted.wanted.add(selected.localName);
    }
    builder.add("store", work.storeChanges, key);
    for (const dir of bodiesDirsFor(work, ctx, io, agents)) {
      const bodies = planBodies({
        dir: dir.dir,
        root: dir.root,
        store: ctx.paths.store,
        files: selection.selected.map((selected) => ({
          localName: selected.localName,
          storeFile: join(work.storeEntry, ...selected.memory.relPath.split("/")),
          text: selected.memory.text,
        })),
        copy: intent.copy,
        symlink,
        replaceCopies: !hookRun,
        knownCopies,
      });
      builder.add("destination", bodies.changes, key);
      for (const line of bodies.notices) notices.notice(`maxims: ${line}`);
    }
    if (!intent.rule) continue;

    // The admitted lines carry a placeholder detail path; each target file gets its own.
    const byLocalName = new Map(
      selection.selected.map((selected) => [selected.localName, selected]),
    );
    const linesFor = (detail: (memory: SourceMemory, local: MemoryName) => string): RuleLine[] =>
      admission.lines.map((line) => {
        const selected = byLocalName.get(line.name);
        return selected === undefined
          ? line
          : { ...line, detailPath: detail(selected.memory, line.name) };
      });
    const requests: { file: RuleFile; lines: RuleLine[] }[] = [];
    if (intent.destination.scope === "out") {
      const outDir = intent.destination.path;
      const path = assertInsideRoot(outDir, outRuleFile(outDir, slug));
      const found = files.get(path);
      if (found !== undefined && found.kind !== "out") {
        throw new LinkedAtRuleFile([key], found.path, path);
      }
      requests.push({
        file: found ?? { kind: "out", path, blocks: [] },
        lines: linesFor((_memory, local) => outDetailPath(local)),
      });
    }
    for (const group of Map.groupBy(targets.targets, (target) => target.realKey).values()) {
      const [first] = group;
      if (first === undefined) continue;
      requests.push({
        file: harnessFile(files, group, first, slug, key),
        lines: linesFor(detailPathFor(work, group, ctx)),
      });
      if (intent.paths !== undefined && !supportsPathScoping(first)) {
        notices.notice(
          `maxims: ${key}: ${first.def.displayName} has no path scoping; --paths ignored there`,
        );
      }
    }
    for (const request of requests) {
      planned.add(fileIdentity(request.file));
      const fileKey =
        request.file.kind === "out"
          ? request.file.path
          : (request.file.targets[0]?.realKey ?? request.file.path);
      files.set(fileKey, request.file);
      request.file.blocks.push({
        key,
        sha: work.sha,
        lines: request.lines,
        stale: work.stale,
        refreshed: refreshed.fetchedKeys.includes(key),
        paths: intent.paths,
      });
    }
  }

  // An unreadable source keeps its files: its rule files stay off the sweep's list, its rules-dir
  // files and `-o` file are owned whole, and the bodies directories it writes to are left alone. Its
  // harnesses are resolved like a readable source's, so one whose config folder is absent stays
  // unreachable for the hook planner too.
  for (const source of read.unreadable) {
    const { intent } = source.entry;
    for (const dir of bodiesDirsFor(source.entry, ctx, io, undefined)) unsweepable.add(dir.id);
    const slug = sourceSlug(intent.from);
    if (intent.destination.scope === "out") {
      if (!intent.rule) continue;
      const realKey = realKeyOf(outRuleFile(intent.destination.path, slug));
      planned.add(realKey);
      keepBlock(source.key, realKey);
      retained.push({ key: source.key, kind: "out", realKey });
      continue;
    }
    const scope = intent.destination.scope;
    const resolved = resolveTargets({
      intent,
      scope,
      sourceSlug: slug,
      ctx,
      harnesses: io.harnesses,
      agents: undefined,
      explicit,
    });
    for (const skipped of resolved.skipped) {
      if (skipped.kind === "unreachable") unreachable.add(`${skipped.id}@${scope}`);
    }
    if (!intent.rule) continue;
    for (const target of resolved.targets) {
      planned.add(target.realKey);
      keepBlock(source.key, target.realKey);
      retained.push({ key: source.key, kind: "harness", target });
    }
  }
  // Where another project's root has files this run reaches (a project rooted at the home
  // directory writes the global rules directory), they are kept as an unreadable source's are. A
  // destination that project cannot resolve (a config folder that is a symlink out of the checkout,
  // a root without search permission) is that project's failure, not this run's, and costs the
  // entry that one harness's targets only.
  for (const [key, entry] of Object.entries(refreshed.sources)) {
    const { intent } = entry;
    if (actsHere(entry, ctx) || intent.destination.scope !== "project" || !intent.rule) continue;
    // Where that project's sessions run is not known here, so its per-directory config layers are
    // its root's alone.
    const root = intent.destination.root;
    const there: EngineContext = { ...ctx, projectRoot: root, cwd: root };
    for (const id of intent.harnesses) {
      let resolved: ReturnType<typeof resolveTargets>;
      try {
        resolved = resolveTargets({
          intent,
          scope: "project",
          sourceSlug: sourceSlug(intent.from),
          ctx: there,
          harnesses: io.harnesses,
          agents: [id],
          explicit: [],
        });
      } catch (error) {
        if (!destinationUnresolvable(error)) throw error;
        continue;
      }
      for (const target of resolved.targets) {
        planned.add(target.realKey);
        keepBlock(key, target.realKey);
        retained.push({ key, kind: "harness", target });
      }
    }
  }
  const scopes: Scope[] = ctx.projectRoot === null ? ["global"] : ["global", "project"];
  addSharedFilesWithOrphans(files, scopes, ctx, io, agents);
  // Every file this run visits is registered by now, the orphan visit included; a file no source
  // renders and no orphan strip reaches is not visited, and its blocks stay as they are.
  for (const kept of retained) {
    switch (kept.kind) {
      case "out":
        break;
      case "harness": {
        const rendered = files.get(kept.target.realKey);
        if (rendered?.kind !== "harness") break;
        keepBlock(kept.key, kept.target.realKey);
        addReaders(rendered, [kept.target], kept.key);
        break;
      }
      default:
        throw unhandledRetained(kept);
    }
  }
  const judgeLink = linkJudge(files, retained);
  refuseLinksThroughRuleFiles(files, judgeLink);
  // A byte budget is only known once a file is rendered, so over it one source is held: refused
  // whole, as the rule cap refuses, while its last-good block stays where the file already carries
  // one. The lines go out loud: a hook session must hear that rules it expects are not loaded.
  //   held first   the source installed last among those whose block this run changes in the file
  //   then         among all its sources, since a block already on disk as drawn cannot make it fit
  //   again        the file keeps every reader and is judged on the finished text until it fits or
  //                no source contributes to it
  let tokens = 0;
  const written = new Set<string>();
  for (;;) {
    const rendered = await renderFiles(files, keepAt);
    if (rendered.ok) {
      // A file's notices may name a machine-wide fact (a config a tier probe could not read), so a
      // line two files earn is said once.
      const said = new Set<string>();
      for (const filePlan of rendered.plans) {
        builder.add("destination", filePlan.writes);
        builder.add("removal", filePlan.removals);
        for (const change of filePlan.writes) written.add(realKeyOf(change.path));
        for (const change of filePlan.removals) {
          if (!hookRun && change.kind === "delete") written.add(realKeyOf(change.path));
        }
        for (const line of filePlan.notices) {
          if (said.has(line)) continue;
          said.add(line);
          notices.notice(line);
        }
        for (const token of filePlan.tokens) {
          tokens += token.tokens;
          notices.notice(`~${token.tokens} tokens in ${token.path}`);
        }
      }
      for (const hold of rendered.held) takeHold(hold);
      break;
    }
    const { error, file } = rendered;
    const changingKeys = await changingBlocks(file);
    const changing = file.blocks.filter((block) => changingKeys.includes(block.key));
    const newest = newestBlock(changing.length > 0 ? changing : file.blocks, refreshed.sources);
    if (newest === undefined) throw error;
    const { key } = newest;
    const message = `${key} is ${error.size - error.budget} bytes over the budget for ${error.path}`;
    const hint = `${error.hint}, or keep ${key} off ${error.displayName} with maxims unlink ${key} -a ${error.harnessId}`;
    const said = new Notices();
    said.loud(message);
    said.loud(hint);
    refuse(key, said, { code: error.code, message, hint });
    builder.drop(key);
    for (const dir of dirsByKey.get(key) ?? []) unsweepable.add(dir);
    for (const each of files.values()) {
      for (const block of each.blocks) {
        if (block.key === key) keepBlock(key, fileIdentity(each));
      }
      each.blocks = each.blocks.filter((block) => block.key !== key);
    }
  }
  for (const { hold, owner } of linkedHolds) {
    if (!written.has(realKeyOf(hold.path))) takeHold(hold, owner);
  }
  // What the admitted sources publish: a source's lines are counted once, however many files
  // carry them, so the count reads as memories with a rule line, not as files times memories.
  const linesByKey = new Map<string, number>();
  for (const file of files.values()) {
    for (const block of file.blocks) linesByKey.set(block.key, block.lines.length);
  }
  const rules = [...linesByKey.values()].reduce((sum, count) => sum + count, 0);
  builder.add(
    "removal",
    planRulesDirSweep({
      ctx,
      harnesses: io.harnesses,
      agents,
      scopes,
      planned,
      warn: (line) => notices.notice(`maxims: ${line}`),
      hold: takeHold,
    }),
  );
  const store = resolve(ctx.paths.store);
  const warn = (line: string): void => notices.notice(`maxims: ${line}`);
  for (const dir of allBodiesDirs(ctx, io, extras.removed, warn)) {
    bodiesWanted.set(dir.id, bodiesWanted.get(dir.id) ?? { ...dir, wanted: new Set() });
  }
  for (const [id, { dir, root, wanted }] of bodiesWanted) {
    if (unsweepable.has(id)) continue;
    builder.add("removal", planBodySweep({ dir, root, store, wanted, knownCopies, warn }));
  }
  // Rule-file and hook intent follows every entry in state, readable or not: a source whose files
  // cannot be read this run still wants its hook kept and its switched-off rule file gone.
  const entries = Object.values(refreshed.sources).filter((entry) => actsHere(entry, ctx));
  const elsewhere = Object.values(refreshed.sources).filter((entry) => !actsHere(entry, ctx));
  const outRulesOff = entries.filter((entry) => !entry.intent.rule);
  builder.add(
    "removal",
    removedOutRuleFiles([...extras.removed, ...outRulesOff], planned, takeHold),
  );
  const at = (scope: Scope, id: HarnessId) =>
    entries.filter(
      (entry) => entry.intent.destination.scope === scope && entry.intent.harnesses.includes(id),
    );
  const hooks = await planHooks({
    ctx,
    harnesses: io.harnesses,
    agents,
    judgeLink,
    wants: (id, scope) => ({
      hook: hookedAt(state, scope, ctx.projectRoot).includes(id) && at(scope, id).length > 0,
      rules: at(scope, id).some((entry) => entry.intent.rule),
      unreachable: unreachable.has(`${id}@${scope}`),
    }),
    elsewhere: (id) => [
      ...new Set(
        elsewhere.flatMap((entry) => {
          const { destination } = entry.intent;
          return destination.scope === "project" &&
            entry.intent.harnesses.includes(id) &&
            hookedAt(state, "project", destination.root).includes(id)
            ? [destination.root]
            : [];
        }),
      ),
    ],
  });
  builder.add("hook", hooks.changes);
  builder.add("removal", hooks.removals);
  for (const line of hooks.notices) notices.notice(`maxims: ${line}`);
  for (const failure of hooks.failures) {
    notices.loud(`maxims: ${failure.message}`);
    failures.push({ code: ExitCode.DestinationWriteFailed, ...failure });
  }
  const expected = new Set(
    Object.values(refreshed.sources).map((entry) => storePathFor(ctx.home, entry.intent.from)),
  );
  builder.add("orphan", planOrphanSweep(ctx.paths.store, expected, warn));
  // A held revision lands beside the store, and stays only while its entry still holds it: an
  // accepted or removed source's revision is swept like an orphaned store entry.
  for (const changes of refreshed.pendingChanges.values()) builder.add("store", changes);
  const heldExpected = new Set(
    Object.values(refreshed.sources).flatMap((entry) =>
      "pending" in entry && entry.pending !== undefined
        ? [pendingPathFor(ctx.home, entry.intent.from)]
        : [],
    ),
  );
  builder.add("orphan", planOrphanSweep(homePaths(ctx.home).pending, heldExpected, warn));
  builder.add("state", extras.extraChanges);

  const nextState: State = { ...state, sources: refreshed.sources };
  if (serializeState(nextState) !== serializeState(extras.previousState)) {
    builder.add("state", [
      {
        kind: "write",
        path: assertInsideRoot(ctx.home, ctx.paths.state),
        content: serializeState({ ...nextState, writtenBy: WRITTEN_BY }),
        mode: 0o600,
      },
    ]);
  }
  return {
    builder,
    notices,
    failures: [...new Set(failures)],
    refusals,
    refusedFresh,
    refusedKept,
    failed: read.failed,
    awaitingReview,
    heldFiles,
    stale,
    hookRun,
    sources: works.length,
    memories,
    rules,
    tokens,
    nextState,
  };
}

// The one line a session hears about a stale source, the sentence the rule-file line carries.
function staleNotices(work: SourceWork, notices: Notices): void {
  if (work.stale === undefined) return;
  notices.loud(`maxims: ${staleSentence(`the rules from ${work.key}`, work.stale)}`);
}

function resolutionFailure(
  key: string,
  resolution: Exclude<Resolution, { ok: true }>,
): Omit<Refusal, "key"> {
  const said = new Notices();
  if (resolution.code === ExitCode.NameCollision) {
    const names = resolution.collisions.map((collision) => collision.name).join(", ");
    for (const collision of resolution.collisions) {
      said.notice(
        `${collision.name} is owned by ${collision.ownedBy}; run maxims add ${key} --rename ${collision.name}=<new>`,
      );
    }
    return {
      said,
      failure: {
        code: resolution.code,
        message: `${key}: name collision on ${names}`,
        hint: `run maxims add ${key} --rename <name>=<new> for each colliding memory`,
      },
    };
  }
  const message = `${key}: ${resolution.count} rule lines exceed the cap of ${resolution.cap}`;
  said.notice(message);
  said.notice(resolution.hint);
  return { said, failure: { code: resolution.code, message, hint: resolution.hint } };
}
