import { lstatSync, readdirSync, readFileSync, readlinkSync } from "node:fs";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { heldForReview } from "../../console/strings.ts";
import type { HarnessId, Scope } from "../../harnesses/contract.ts";
import { BudgetExceeded } from "../../harnesses/strategies/rules-dir.ts";
import {
  type ContentHash,
  contentHashOf,
  type MemoryName,
  parseMemoryName,
} from "../../memory/contract.ts";
import {
  buildNameIndex,
  compareInstalled,
  type IndexedSource,
  type Resolution,
  resolveSourceCandidates,
} from "../../rulefile/dedupe.ts";
import type { RuleLine, Staleness } from "../../rulefile/types.ts";
import { type LocalSourceFrom, materializeLocal } from "../../sources/local.ts";
import { hashFiles, type TreeFile } from "../../sources/tree.ts";
import type { Fetched, LastError, SourceEntry, SourceIntent, State } from "../../state/schema.ts";
import { serializeState, WRITTEN_BY } from "../../state/store.ts";
import type { Change, Plan } from "../../util/change.ts";
import { ExitCode, MaximsError } from "../../util/exit-codes.ts";
import { assertInsideRoot, type RootedPath } from "../../util/fs.ts";
import { homePaths, pendingPathFor, storePathFor } from "../../util/home.ts";
import type {
  EngineIo,
  FetchIntent,
  HarnessFilter,
  SyncOptions,
  SyncPreview,
  SyncReport,
} from "../types.ts";
import { parseRuleBlocks } from "./blocks.ts";
import { planBodies, planBodySweep } from "./bodies.ts";
import { actsHere, agentsAllowed, type EngineContext, harnessContext } from "./context.ts";
import { type HarnessTarget, realDirOf, realKeyOf, resolveTargets } from "./destination.ts";
import { type FetchedEntry, refreshSource, storeEntryPresent } from "./fetch.ts";
import { destinationUnresolvable } from "./fs-probe.ts";
import { hookedAt, planHooks } from "./hooks.ts";
import {
  readSourceMemories,
  type SourceMemory,
  type SourceTree,
  validateMemoryFiles,
} from "./memories.ts";
import { Notices } from "./notices.ts";
import { planOrphanSweep } from "./orphans.ts";
import { PlanBuilder } from "./plan.ts";
import { readProjectLock } from "./project-lock-io.ts";
import {
  type BlockRequest,
  claimedByMaxims,
  isAbsent,
  planRuleFile,
  planRulesDirSweep,
  type RuleFile,
  type RuleFilePlan,
  readIfPresent,
} from "./rules.ts";
import { disabledNames, inSelect, renamed, selectMemories } from "./select.ts";
import { sourceSlug } from "./slug.ts";
import { findSourceKey } from "./sources.ts";

export type ScopeKind = SourceIntent["destination"]["scope"];

export type SyncFailure = { code: ExitCode; message: string; hint?: string };

export type SyncExtras = {
  verb: "sync" | "remove";
  // The state as the caller read it under the lock; the state write is planned when the state
  // this run ends with differs from it, whether the caller or the fetch step changed it.
  previousState: State;
  extraChanges: readonly Change[];
  // Entries the caller took out of intent: their `-o` folders are swept (no harness sweep
  // reaches them), and the content hashes of their bodies let a copied body under a project be
  // told from the user's own file with the same name.
  removed: readonly SourceEntry[];
  removedCopies: ReadonlySet<ContentHash>;
};

// `changed` is known only once the plan has been applied, so the outcome's report lacks it.
export type SyncOutcome = {
  plan: Plan;
  deferred: Change[];
  report: Omit<SyncReport, "changed">;
  nextState: State;
  failures: SyncFailure[];
  notices: Notices;
};

export type SourceWork = {
  key: string;
  entry: SourceEntry;
  intent: SourceIntent;
  scopeKind: ScopeKind;
  storeEntry: RootedPath;
  tree: SourceTree;
  sha: string;
  stale: Staleness | undefined;
  ownedUpstreamNames: MemoryName[];
  // The store swap or link this source lands with, planned only once admission has passed.
  storeChanges: Change[];
};

const STALE_AFTER_MS = 7 * 24 * 60 * 60 * 1000;
// Earlier than any source's `addedAt`: the name index places what is installed first.
const INSTALLED_FIRST = "1970-01-01T00:00:00.000Z";

const STALE_REASON: Record<Staleness["kind"], string> = {
  age: "no successful fetch",
  network: "network unreachable",
  ratelimit: "rate limited",
  missing: "source repository gone or unreadable",
  auth: "authentication failed",
  invalid: "source content invalid",
};

export function isFetchedEntry(entry: SourceEntry): entry is FetchedEntry {
  return !(entry.intent.from.type === "local" && entry.intent.from.live === true);
}

// The content hashes a set of entries recorded at their last fetch: what a copy of theirs in a
// bodies directory would hash to, so it is told from the user's own file with the same name.
export function recordedCopies(entries: readonly SourceEntry[]): Set<ContentHash> {
  const copies = new Set<ContentHash>();
  for (const entry of entries) {
    const fetched = isFetchedEntry(entry) ? entry.fetched : undefined;
    for (const facts of Object.values(fetched?.memories ?? {})) copies.add(facts.content);
  }
  return copies;
}

export function shortSha(sha: string): string {
  return sha.replace(/^sha256:/, "").slice(0, 7);
}

// Steps 2 to 5 of a sync over a state already read under the lock, as one plan: store swaps,
// bodies, rule files, hook and config reconciliation, the orphan sweep and the state write.
// A fresh refresh that is refused (collision, cap, byte budget) is rolled back to the source's
// last-good copy and the whole installation is planned again from it, so what the retained rules
// point at is what the name index and the sweeps see; the refusal's own lines are carried over.
export async function planSync(
  state: State,
  ctx: EngineContext,
  io: EngineIo,
  options: SyncOptions,
  extras: SyncExtras,
): Promise<SyncOutcome> {
  const base = new Notices();
  if (ctx.configIssue !== null) base.notice(`maxims: ${ctx.configIssue}`);
  await noticeLockOnlySources(state, ctx, base, [
    ...extras.extraChanges,
    ...(options.preview?.changes ?? []),
  ]);
  const refreshed = await refreshAll(state, ctx, io, options, base);
  const overlay = previewStoreTrees(options.preview, ctx);
  const carried = new Notices();
  const carriedFailures: SyncFailure[] = [];
  // A readable source refused by admission is planned again as if unreadable: its block stays
  // and the names that block points at stay reserved, so no newer source takes its bodies over.
  const held = new Set<string>();
  for (;;) {
    const attempt = await planInstall(state, ctx, io, options, extras, refreshed, held, overlay);
    const retry = [...attempt.refusedFresh, ...attempt.refusedKept];
    if (retry.length === 0) {
      const notices = new Notices();
      notices.absorb(base);
      for (const key of refreshed.fetchedKeys) {
        for (const line of refreshed.lines.get(key) ?? []) notices.notice(line);
        for (const line of refreshed.changeLines.get(key) ?? []) notices.notice(line);
      }
      // A reason is said once, whether the final attempt found it again on its own or a source
      // earned it twice (refused fresh, then again from last-good), and on the channel it was
      // first said on: a held source's lines stay loud so a hook session hears them.
      const said = new Set(attempt.notices.user);
      const loud = new Set(carried.quietStdout);
      for (const line of carried.user) {
        if (said.has(line)) continue;
        said.add(line);
        if (loud.has(line)) notices.loud(line);
        else notices.notice(line);
      }
      notices.absorb(attempt.notices);
      const found = new Set(attempt.failures.map((failure) => failure.message));
      const failures = [
        ...carriedFailures.filter((failure) => !found.has(failure.message)),
        ...attempt.failures,
      ];
      const built = attempt.builder.build({
        deferDeletions: attempt.hookRun,
        notices: notices.user,
      });
      if (built.deferred.length > 0) {
        notices.trace(`deferred ${built.deferred.length} deletion(s) until an interactive sync`);
      }
      const failed = [...refreshed.failed, ...attempt.failed].sort((a, b) =>
        a.key < b.key ? -1 : a.key > b.key ? 1 : 0,
      );
      return {
        plan: built.plan,
        deferred: built.deferred,
        report: {
          sources: attempt.sources,
          memories: attempt.memories,
          rules: attempt.rules,
          tokens: attempt.tokens,
          fetched: refreshed.fetchedKeys,
          held: attempt.awaitingReview.map((source) => source.key),
          upstreamChanges: Object.fromEntries([
            ...refreshed.fetchedKeys.map((key) => [key, refreshed.changeLines.get(key) ?? []]),
            ...attempt.awaitingReview.map((source) => [source.key, source.summary]),
          ]),
          failed,
          notices: notices.user,
          plan: built.plan,
        },
        nextState: attempt.nextState,
        failures,
        notices,
      };
    }
    for (const key of attempt.refusedFresh) refreshed.refuse(key);
    for (const key of attempt.refusedKept) held.add(key);
    // Only the refused sources' own refusals travel: an unrelated failure is found again by the
    // next attempt, and would otherwise be reported twice.
    const seen = new Set<SyncFailure>();
    for (const refusal of attempt.refusals) {
      if (!retry.includes(refusal.key) || seen.has(refusal.failure)) continue;
      seen.add(refusal.failure);
      carried.absorb(refusal.said);
      carriedFailures.push(refusal.failure);
    }
  }
}

// What one source's refusal said, on the channel it said it, kept with its key so a retry
// carries exactly it.
type Refusal = { key: string; said: Notices; failure: SyncFailure };

type Attempt = {
  builder: PlanBuilder;
  notices: Notices;
  failures: SyncFailure[];
  refusals: Refusal[];
  refusedFresh: string[];
  refusedKept: string[];
  // Live sources whose directory could not be read this run.
  failed: SyncReport["failed"];
  // Sources with a revision held for review at the end of this run, made now or earlier, with
  // what it changes: a session hears about a waiting revision at every start, as it does about a
  // stale source.
  awaitingReview: { key: string; summary: string[] }[];
  hookRun: boolean;
  sources: number;
  memories: number;
  rules: number;
  tokens: number;
  nextState: State;
};

async function planInstall(
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
  for (const [key, entry] of Object.entries(refreshed.sources)) {
    if (!actsHere(entry, ctx) || !isFetchedEntry(entry) || entry.pending === undefined) continue;
    awaitingReview.push({ key, summary: entry.pending.summary });
    notices.loud(heldForReview(key, entry.pending.summary.length));
  }
  // A source refused whole: `said` carries its lines on the channel the reason earns.
  const refuse = (key: string, said: Notices, failure: SyncFailure): void => {
    notices.absorb(said);
    failures.push(failure);
    refusals.push({ key, said, failure });
    if (refreshed.freshTrees.has(key)) refusedFresh.push(key);
    else refusedKept.push(key);
  };
  const read = await readTrees(refreshed, held, overlay, ctx, notices);
  const { works } = read;
  // Blocks that must survive in a file even though this run renders none for their source: an
  // unreadable or refused source keeps its last-good block, but only where its intent still puts
  // one, so a harness the user dropped from the source loses the block like any other. Files are
  // identified by real path, as the rule files are, so two spellings of one file agree.
  const keepAt = new Map<string, Set<string>>();
  const keepBlock = (key: string, realKey: string): void => {
    const kept = keepAt.get(realKey) ?? new Set<string>();
    kept.add(key);
    keepAt.set(realKey, kept);
  };
  // What a source already holds on disk keeps its names ahead of anything shipped this run: the
  // names the state as read recorded for it and the ones its blocks name (a live source records
  // nothing else) enter the index first, dated before every source, so a memory another source
  // newly ships under an installed name collides instead of taking the installed body over. A
  // name a source has dropped leaves its block this run and is free from the next run on.
  // A copy whose bytes several sources hold installed names no owner; the dedupe rule decides
  // it. Ambiguity and ownership read the same snapshot: every source's installed tree as the
  // state as read left it, held and unreadable sources included.
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
          : await retainedNames(key, entry, ctx, io, ambiguous, installedTrees.get(key) ?? null),
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
  const files = new Map<string, RuleFile>();
  // Real paths of the rule files this run plans (or keeps), the identity the sweep compares by.
  const planned = new Set<string>();
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
  const knownCopies = new Set<ContentHash>(extras.removedCopies);
  for (const entry of Object.values(extras.previousState.sources)) {
    const fetched = isFetchedEntry(entry) ? entry.fetched : undefined;
    for (const facts of Object.values(fetched?.memories ?? {})) knownCopies.add(facts.content);
  }
  const symlink = await io.symlinkSupport();
  const installInternal = ctx.env.MAXIMS_INSTALL_INTERNAL === "1";
  const hookRun = extras.verb === "sync" && options.quiet;
  const agents = widenedAgents(options.agents, refreshed);
  const explicit = options.agents ?? [];
  // Targets this run renders no block for although their source is still installed: a readable
  // source's harness outside the filter, or an unreadable source's. Wherever the file is visited
  // this run, the block is kept and the harness counted among the readers, since a file is
  // written whole and judged against every reader's budget.
  const retained: { key: string; target: HarnessTarget }[] = [];
  let rules = 0;
  let memories = 0;

  for (const work of works) {
    const { intent, key } = work;
    const disabled = disabledNames(state, work.scopeKind, ctx.projectRoot);
    const selection = selectMemories({
      memories: work.tree.memories,
      intent,
      installInternal,
      disabled,
      detailPath: () => "",
    });
    memories += selection.selected.length;
    if (selection.hiddenInternal > 0) {
      notices.notice(`maxims: ${key}: ${selection.hiddenInternal} internal, hidden`);
    }
    for (const memory of work.tree.memories) knownCopies.add(memory.memory.contentHash);
    staleNotices(work, selection.selected.length, notices);
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
        if (!agentsAllowed(agents, target.def.id)) retained.push({ key, target });
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
        keepBlock(key, realKeyOf(join(intent.destination.path, `maxims-${slug}.md`)));
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
      const path = assertInsideRoot(outDir, join(outDir, `maxims-${slug}.md`));
      requests.push({
        file: files.get(path) ?? { kind: "out", path, blocks: [] },
        lines: linesFor((_memory, local) => `memories/${local}.md`),
      });
    }
    for (const group of groupTargets(targets.targets)) {
      const [first] = group;
      if (first === undefined) continue;
      requests.push({
        file: harnessFile(files, group, first, slug),
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
      rules += request.lines.length;
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

  // An unreadable source keeps its files: its rule files stay off the sweep's list and the
  // bodies directories it writes to are left alone. Its harnesses are resolved like a readable
  // source's, so one whose config folder is absent stays unreachable for the hook planner too.
  for (const source of read.unreadable) {
    const scope = source.entry.intent.destination.scope;
    for (const dir of bodiesDirsFor(source.entry, ctx, io, undefined)) unsweepable.add(dir.id);
    if (scope === "out") continue;
    const slug = sourceSlug(source.entry.intent.from);
    const resolved = resolveTargets({
      intent: source.entry.intent,
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
    if (!source.entry.intent.rule) continue;
    for (const target of resolved.targets) {
      planned.add(target.realKey);
      keepBlock(source.key, target.realKey);
      retained.push({ key: source.key, target });
    }
  }
  // Another project's entries render at their own root. Where that root's files are ones this
  // run reaches (a project rooted at the home directory writes the global rules directory), their
  // rule files stay off the sweep's list and their blocks are kept, as an unreadable source's are;
  // a path this run never visits is inert on the list. A destination that project cannot resolve
  // (a config folder that is a symlink out of the checkout, a root without search permission) is
  // that project's failure, not this run's, and costs the entry that one harness's targets only.
  for (const [key, entry] of Object.entries(refreshed.sources)) {
    const { intent } = entry;
    if (actsHere(entry, ctx) || intent.destination.scope !== "project" || !intent.rule) continue;
    const there: EngineContext = { ...ctx, projectRoot: intent.destination.root };
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
        retained.push({ key, target });
      }
    }
  }
  const scopes: Scope[] = ctx.projectRoot === null ? ["global"] : ["global", "project"];
  addSharedFilesWithOrphans(files, scopes, ctx, io, agents);
  // Every file this run visits is registered by now, the orphan visit included; a file no source
  // renders and no orphan strip reaches is not visited, and its blocks stay as they are.
  for (const { key, target } of retained) {
    const rendered = files.get(target.realKey);
    if (rendered?.kind !== "harness") continue;
    keepBlock(key, target.realKey);
    addReaders(rendered, [target]);
  }
  // A harness's byte budget is only known once a file is rendered. Over it, the source installed
  // last is held: refused whole (bodies, store swap and its blocks in every other file), the same
  // shape as the rule cap, while its last-good block stays where the file already carries one.
  // The file keeps every reader and is judged again on the finished text, one hold at a time,
  // until it fits or no source contributes to it. The lines go out loud: a hook session must
  // hear that rules it expects are not loaded.
  let tokens = 0;
  for (;;) {
    const rendered = await renderFiles(files, ctx, keepAt);
    if (rendered.ok) {
      for (const filePlan of rendered.plans) {
        builder.add("destination", filePlan.writes);
        builder.add("removal", filePlan.removals);
        for (const line of filePlan.notices) notices.notice(line);
        for (const token of filePlan.tokens) {
          tokens += token.tokens;
          notices.notice(`~${token.tokens} tokens in ${token.path}`);
        }
      }
      break;
    }
    const { error, file } = rendered;
    const newest = newestBlock(file.blocks, refreshed.sources);
    if (newest === undefined) throw error;
    const { key } = newest;
    const message = `${key} is ${error.size - error.budget} bytes over the budget for ${error.path}`;
    const hint = `${error.hint}, or keep ${key} off ${error.displayName} with maxims unlink ${key} -a ${error.harnessId}`;
    const said = new Notices();
    said.loud(`x  ${message}`);
    said.loud(`   ${hint}`);
    refuse(key, said, { code: error.code, message, hint });
    builder.drop(key);
    for (const dir of dirsByKey.get(key) ?? []) unsweepable.add(dir);
    for (const each of files.values()) {
      for (const block of each.blocks) {
        if (block.key !== key) continue;
        keepBlock(key, fileIdentity(each));
        rules -= block.lines.length;
      }
      each.blocks = each.blocks.filter((block) => block.key !== key);
    }
  }
  builder.add(
    "removal",
    planRulesDirSweep({
      ctx,
      harnesses: io.harnesses,
      agents,
      scopes,
      planned,
      warn: (line) => notices.notice(`maxims: ${line}`),
    }),
  );
  const store = resolve(ctx.paths.store);
  for (const dir of allBodiesDirs(ctx, io, extras.removed)) {
    bodiesWanted.set(dir.id, bodiesWanted.get(dir.id) ?? { ...dir, wanted: new Set() });
  }
  const warn = (line: string): void => notices.notice(`maxims: ${line}`);
  for (const [id, { dir, root, wanted }] of bodiesWanted) {
    if (unsweepable.has(id)) continue;
    builder.add("removal", planBodySweep({ dir, root, store, wanted, knownCopies, warn }));
  }
  // Rule-file and hook intent follows every entry in state, readable or not: a source whose files
  // cannot be read this run still wants its hook kept and its switched-off rule file gone.
  const entries = Object.values(refreshed.sources).filter((entry) => actsHere(entry, ctx));
  const elsewhere = Object.values(refreshed.sources).filter((entry) => !actsHere(entry, ctx));
  const outRulesOff = entries.filter((entry) => !entry.intent.rule);
  builder.add("removal", removedOutRuleFiles([...extras.removed, ...outRulesOff], planned));
  const at = (scope: Scope, id: HarnessId) =>
    entries.filter(
      (entry) => entry.intent.destination.scope === scope && entry.intent.harnesses.includes(id),
    );
  const hooks = await planHooks({
    ctx,
    harnesses: io.harnesses,
    agents,
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
    hookRun,
    sources: works.length,
    memories,
    rules,
    tokens,
    nextState,
  };
}

function harnessFile(
  files: Map<string, RuleFile>,
  group: HarnessTarget[],
  first: HarnessTarget,
  slug: string,
): Extract<RuleFile, { kind: "harness" }> {
  const existing = files.get(first.realKey);
  const file: Extract<RuleFile, { kind: "harness" }> =
    existing?.kind === "harness"
      ? existing
      : { kind: "harness", path: first.path, sourceSlug: slug, targets: [], blocks: [] };
  addReaders(file, group);
  return file;
}

// Sources sharing one file each bring their own readers; the file carries the union, so its
// rendering and its byte budget answer to every harness that reads it, not the first source's.
function addReaders(file: Extract<RuleFile, { kind: "harness" }>, group: HarnessTarget[]): void {
  for (const target of group) {
    const seen = file.targets.some(
      (known) => known.def.id === target.def.id && known.scope === target.scope,
    );
    if (!seen) file.targets.push(target);
  }
}

// The identity a rule file is kept and grouped under: the real path of the target file.
function fileIdentity(file: RuleFile): string {
  return file.kind === "harness" ? (file.targets[0]?.realKey ?? file.path) : realKeyOf(file.path);
}

// The block whose source was installed last, so the sources that were there first keep loading.
function newestBlock(
  blocks: readonly BlockRequest[],
  sources: State["sources"],
): BlockRequest | undefined {
  const installed = blocks.map((block) => ({
    block,
    key: block.key,
    addedAt: sources[block.key]?.addedAt ?? INSTALLED_FIRST,
  }));
  return installed.sort(compareInstalled).at(-1)?.block;
}

type RenderedFiles =
  | { ok: true; plans: RuleFilePlan[] }
  | { ok: false; file: RuleFile; error: BudgetExceeded };

async function renderFiles(
  files: Map<string, RuleFile>,
  ctx: EngineContext,
  keepAt: ReadonlyMap<string, ReadonlySet<string>>,
): Promise<RenderedFiles> {
  const plans: RuleFilePlan[] = [];
  for (const file of files.values()) {
    try {
      const keep = keepAt.get(fileIdentity(file)) ?? new Set<string>();
      plans.push(await planRuleFile(file, { ctx, keep }));
    } catch (error) {
      if (!(error instanceof BudgetExceeded)) throw error;
      return { ok: false, file, error };
    }
  }
  return { ok: true, plans };
}

// The lock is a projection the CLI writes; sync only says when it names a source this machine
// never installed, and never installs from it. The lock judged is the one this run leaves behind:
// a rewrite the caller planned beside the state edit counts before it lands.
async function noticeLockOnlySources(
  state: State,
  ctx: EngineContext,
  notices: Notices,
  planned: readonly Change[],
): Promise<void> {
  if (ctx.projectRoot === null) return;
  const lock = await readProjectLock(ctx.projectRoot, planned);
  if (lock.kind === "corrupt") {
    notices.notice(`maxims: ${lock.path} could not be read: ${lock.issues.join("; ")}`);
    return;
  }
  if (lock.kind !== "parsed") return;
  const missing = lock.keys.filter((key) => !installedHere(state, key, ctx));
  if (missing.length === 0) return;
  const verb = missing.length === 1 ? "is" : "are";
  notices.notice(
    `maxims: ${missing.join(", ")} ${verb} in .agents/maxims.lock but not installed here; run maxims install`,
  );
}

// `storeChanges` are held per source until admission: a fresh fetch that collides or exceeds the
// cap is refused whole, and `refuse` puts the source's previous entry back so the store and the
// state keep last-good. `pendingChanges` lay a reviewed source's held revision under the pending
// root; they answer to no admission, since the store copy the run installs from is unchanged, and
// what the revision changes stays out of `changeLines`, the lines an applied refresh is reported
// with, once per source.
type Refreshed = {
  sources: State["sources"];
  freshTrees: Map<string, SourceTree>;
  storeChanges: Map<string, Change[]>;
  pendingChanges: Map<string, Change[]>;
  changeLines: Map<string, string[]>;
  // The lines a fresh refresh earns ("refreshed", new upstream names), shown only once the
  // refresh has survived admission.
  lines: Map<string, string[]>;
  fetchedKeys: string[];
  failed: SyncReport["failed"];
  refuse(key: string): void;
};

// A failed fetch is never a stop: the source keeps last-good and the failure is reported, so the
// caller decides what a manual run's exit says about it. A hold is traced line by line here; the
// install pass says it to the user, since a standing hold is said at every run.
async function refreshAll(
  state: State,
  ctx: EngineContext,
  io: EngineIo,
  options: SyncOptions,
  notices: Notices,
): Promise<Refreshed> {
  const sources: State["sources"] = {};
  const freshTrees = new Map<string, SourceTree>();
  const storeChanges = new Map<string, Change[]>();
  const pendingChanges = new Map<string, Change[]>();
  const changeLines = new Map<string, string[]>();
  const lines = new Map<string, string[]>();
  const fetchedKeys: string[] = [];
  const failed: SyncReport["failed"] = [];
  for (const key of Object.keys(state.sources).sort()) {
    const entry = state.sources[key];
    if (entry === undefined) continue;
    if (!isFetchedEntry(entry) || !actsHere(entry, ctx)) {
      sources[key] = entry;
      continue;
    }
    const result = await refreshSource(key, entry, ctx, io, notices, {
      fetch: fetchIntentFor(key, options),
    });
    sources[key] = result.entry;
    switch (result.outcome) {
      case "fresh": {
        fetchedKeys.push(key);
        freshTrees.set(key, result.tree);
        storeChanges.set(key, result.storeChanges);
        const earned = [`maxims: ${key} refreshed (${shortSha(result.tree.sha)})`];
        changeLines.set(key, result.changeLines);
        if (result.newUpstream.length > 0) {
          const names = result.newUpstream.join(", ");
          earned.push(`maxims: ${key} has new memories not in your selection: ${names}`);
        }
        lines.set(key, earned);
        break;
      }
      case "held": {
        pendingChanges.set(key, result.storeChanges);
        for (const line of result.summary) notices.trace(`${key}: held ${line}`);
        break;
      }
      case "failed":
      case "no-valid":
        notices.trace(`${key}: fetch failed (${result.error.kind}): ${result.error.message}`);
        failed.push({ key, message: result.error.message, kind: result.error.kind });
        break;
      case "skipped":
      case "not-due":
      case "unchanged":
        break;
    }
  }
  return {
    sources,
    freshTrees,
    storeChanges,
    pendingChanges,
    changeLines,
    lines,
    fetchedKeys,
    failed,
    refuse(key) {
      if (!freshTrees.has(key)) return;
      const previous = state.sources[key];
      if (previous !== undefined) sources[key] = previous;
      freshTrees.delete(key);
      storeChanges.delete(key);
      changeLines.delete(key);
      lines.delete(key);
      fetchedKeys.splice(fetchedKeys.indexOf(key), 1);
      notices.trace(`${key}: refresh refused; last-good kept`);
    },
  };
}

// A lock entry is installed here when state holds it for this project (or the user), not merely
// for some other checkout. A teammate's `@Acme/rules` is this machine's `@acme/rules`, the same
// identity the lock merge uses.
export function installedHere(
  state: State,
  key: string,
  ctx: { projectRoot: string | null },
): boolean {
  const recorded = findSourceKey(state, key);
  const entry = recorded === null ? undefined : state.sources[recorded];
  return entry !== undefined && actsHere(entry, ctx);
}

// A store swap removes the bodies every rule file of the source points at, so a run limited by
// `-a` that refreshed a source writes every harness that source lists.
function widenedAgents(
  agents: HarnessFilter | undefined,
  refreshed: Refreshed,
): HarnessFilter | undefined {
  if (agents === undefined) return undefined;
  const widened = new Set<HarnessId>(agents);
  for (const key of refreshed.freshTrees.keys()) {
    for (const id of refreshed.sources[key]?.intent.harnesses ?? []) widened.add(id);
  }
  const [first, ...rest] = widened;
  return first === undefined ? agents : [first, ...rest];
}

// A source outside `only` is left alone; a `due` run limited to some harnesses fetches nothing,
// since a refresh reaches every harness's rule file. A forced one fetches, and the planner then
// widens the filter to the refreshed sources' harnesses.
function fetchIntentFor(key: string, options: SyncOptions): FetchIntent {
  if (options.only !== undefined && !options.only.includes(key)) return "none";
  if (options.fetch === "due" && options.agents !== undefined) return "none";
  return options.fetch;
}

type ReadTrees = {
  works: SourceWork[];
  unreadable: { key: string; entry: SourceEntry }[];
  failed: SyncReport["failed"];
};

// The memories every source installs from: a fresh fetch's own files, a live source's directory,
// or the store copy. A source with nothing readable keeps whatever blocks it has on disk; a live
// source's read is its refresh, so one that fails is reported like a failed fetch.
async function readTrees(
  refreshed: Refreshed,
  held: ReadonlySet<string>,
  overlay: StoreOverlay,
  ctx: EngineContext,
  notices: Notices,
): Promise<ReadTrees> {
  const works: SourceWork[] = [];
  const unreadable: ReadTrees["unreadable"] = [];
  const failed: ReadTrees["failed"] = [];
  const installInternal = ctx.env.MAXIMS_INSTALL_INTERNAL === "1";
  for (const key of Object.keys(refreshed.sources).sort()) {
    const entry = refreshed.sources[key];
    if (entry === undefined) continue;
    const { intent } = entry;
    const { from } = intent;
    const scopeKind = intent.destination.scope;
    if (!actsHere(entry, ctx)) {
      notices.trace(`${key}: installed for another project; skipped`);
      continue;
    }
    if (held.has(key)) {
      unreadable.push({ key, entry });
      continue;
    }
    const storeEntry = storePathFor(ctx.home, from);
    const live = from.type === "local" && from.live === true;
    const read = await treeFor(key, entry, storeEntry, refreshed.freshTrees, overlay, notices);
    if (read.kind === "unreadable") {
      notices.notice(`maxims: ${key}: ${read.reason}; kept whatever is installed`);
      if (live) failed.push({ key, message: read.reason, kind: read.cause });
      unreadable.push({ key, entry });
      continue;
    }
    const fetched = isFetchedEntry(entry) ? entry.fetched : undefined;
    works.push({
      key,
      entry,
      intent,
      scopeKind,
      storeEntry,
      tree: read.tree,
      sha: !live && fetched !== undefined ? fetched.sha : read.tree.sha,
      stale: staleness(fetched, ctx.now),
      ownedUpstreamNames: selectMemories({
        memories: read.tree.memories,
        intent,
        installInternal,
        disabled: new Set(),
        detailPath: () => "",
      }).ownedUpstreamNames,
      storeChanges:
        from.type === "local" && from.live === true
          ? liveStoreChanges(from, storeEntry, ctx.home)
          : (refreshed.storeChanges.get(key) ?? []),
    });
  }
  return { works, unreadable, failed };
}

function liveStoreChanges(from: LocalSourceFrom, storeEntry: string, home: string): Change[] {
  if (currentLinkTarget(storeEntry) === resolve(from.path)) return [];
  return materializeLocal(from, home, []);
}

// `cause` classifies an unreadable source the way a failed fetch is classified, so the report
// tells a directory that is gone from one that holds nothing valid to install.
export type TreeRead =
  | { kind: "tree"; tree: SourceTree }
  | { kind: "unreadable"; reason: string; cause: LastError["kind"] };

async function treeFor(
  key: string,
  entry: SourceEntry,
  storeEntry: RootedPath,
  freshTrees: Map<string, SourceTree>,
  overlay: StoreOverlay,
  notices: Notices,
): Promise<TreeRead> {
  const fresh = freshTrees.get(key) ?? overlay.get(storeEntry);
  if (fresh !== undefined) return { kind: "tree", tree: fresh };
  const warn = (line: string): void => notices.notice(`maxims: ${key}: ${line}`);
  return readInstalledTree(entry, storeEntry, warn);
}

// What a source installs from right now: a live source's own directory, else the store copy.
export async function readInstalledTree(
  entry: SourceEntry,
  storeEntry: string,
  warn: (line: string) => void,
): Promise<TreeRead> {
  const { intent } = entry;
  const live = intent.from.type === "local" && intent.from.live === true;
  const root = live && intent.from.type === "local" ? intent.from.path : storeEntry;
  if (!live && !(await storeEntryPresent(storeEntry))) {
    const lastError = isFetchedEntry(entry) ? entry.fetched?.lastError : undefined;
    return {
      kind: "unreadable",
      reason: lastError?.message ?? "not fetched yet",
      cause: lastError?.kind ?? "missing",
    };
  }
  try {
    const tree = await readSourceMemories(root, intent, warn);
    // A tree holding no valid memory is a layout that changed or a folder emptied by hand, never
    // an empty source to install: what is installed stays until a valid memory is back. The
    // fetch path refuses the same tree before it reaches the store.
    if (tree.memories.length === 0) {
      const reasons = tree.invalid.map((file) => `${file.relPath}: ${file.reason}`).join("; ");
      const reason = tree.invalid.length === 0 ? "no memories" : `no valid memories (${reasons})`;
      return { kind: "unreadable", reason, cause: "invalid" };
    }
    return { kind: "tree", tree };
  } catch (cause) {
    return {
      kind: "unreadable",
      reason: cause instanceof Error ? cause.message : String(cause),
      cause: "missing",
    };
  }
}

// A store entry as a dry run's caller would have written it, keyed by the entry path: the files
// its planned writes carry are read in place of the copy that is not on disk. Only writes under
// the store count; a state, config or manifest write in the same preview says nothing about
// memories.
type StoreOverlay = ReadonlyMap<string, SourceTree>;

function previewStoreTrees(preview: SyncPreview | undefined, ctx: EngineContext): StoreOverlay {
  const overlay = new Map<string, SourceTree>();
  if (preview === undefined) return overlay;
  for (const entry of Object.values(preview.state.sources)) {
    const path = storePathFor(ctx.home, entry.intent.from);
    const files: TreeFile[] = [];
    for (const change of preview.changes) {
      if (change.kind !== "write") continue;
      const rel = relative(path, change.path);
      if (rel === "" || rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) continue;
      files.push({ relPath: rel.split(sep).join("/"), text: change.content });
    }
    if (files.length > 0)
      overlay.set(path, { sha: hashFiles(files), ...validateMemoryFiles(files) });
  }
  return overlay;
}

function currentLinkTarget(path: string): string | null {
  const entry = lstatSync(path, { throwIfNoEntry: false });
  if (entry === undefined || !entry.isSymbolicLink()) return null;
  return resolve(readlinkSync(path));
}

// Stale means fetching has been failing: immediately for a gone repository, after seven days for
// anything else. A source merely past its cooldown that fetches fine is not stale.
export function staleness(fetched: Fetched | undefined, now: Date): Staleness | undefined {
  if (fetched === undefined || fetched.lastError === null) return undefined;
  const { kind } = fetched.lastError;
  if (kind === "missing") return { since: fetched.at, kind };
  if (now.getTime() - Date.parse(fetched.at) >= STALE_AFTER_MS) return { since: fetched.at, kind };
  return undefined;
}

function staleNotices(work: SourceWork, ruleCount: number, notices: Notices): void {
  const fetched = isFetchedEntry(work.entry) ? work.entry.fetched : undefined;
  if (fetched === undefined || fetched.lastError === null) return;
  const since = fetched.at.slice(0, "2026-01-01".length);
  const { kind } = fetched.lastError;
  if (kind === "missing") {
    notices.loud(
      `maxims: ${work.key} offline, kept last-good from ${since} (${ruleCount} rules); source repository gone or unreadable`,
    );
  } else if (kind === "invalid") {
    notices.loud(`maxims: ${work.key}: ${fetched.lastError.message}; kept last-good`);
  } else if (work.stale !== undefined) {
    notices.loud(
      `maxims: ${work.key} has not refreshed since ${since} (${STALE_REASON[kind]}); rules may be out of date`,
    );
  }
}

// `id` is the directory's real path, the identity two spellings of one folder share.
type BodiesDir = { id: string; dir: string; root: string };

// Every distinct memory directory the source's harnesses read at this scope; the user scope
// links nothing (rule lines point into the store) and `-o` gets `<folder>/memories`.
function bodiesDirsFor(
  work: Pick<SourceWork, "intent">,
  ctx: EngineContext,
  io: EngineIo,
  agents: HarnessFilter | undefined,
): BodiesDir[] {
  const { intent } = work;
  if (intent.destination.scope === "out") {
    const root = intent.destination.path;
    return [bodiesDir(join(root, "memories"), root)];
  }
  if (intent.destination.scope === "global" || ctx.projectRoot === null) return [];
  const projectRoot = ctx.projectRoot;
  const harnessCtx = { ...harnessContext(ctx), projectRoot };
  const dirs = new Map<string, BodiesDir>();
  for (const id of intent.harnesses) {
    if (!agentsAllowed(agents, id)) continue;
    const def = io.harnesses.find((candidate) => candidate.id === id);
    const dir = def?.bodiesDir("project", harnessCtx);
    if (dir === undefined || dir === null) continue;
    const entry = bodiesDir(resolve(dir), projectRoot);
    dirs.set(entry.id, entry);
  }
  return [...dirs.values()];
}

// Every bodies directory this run can reach, whatever `-a` limited it to, so a source that left
// intent has its links and copies swept even when no surviving source shares the directory; a
// removed `-o` source contributes its own memories folder.
function allBodiesDirs(
  ctx: EngineContext,
  io: EngineIo,
  removed: readonly SourceEntry[],
): BodiesDir[] {
  const dirs = new Map<string, BodiesDir>();
  if (ctx.projectRoot !== null) {
    const projectRoot = ctx.projectRoot;
    const harnessCtx = { ...harnessContext(ctx), projectRoot };
    for (const def of io.harnesses) {
      const dir = def.bodiesDir("project", harnessCtx);
      if (dir === null) continue;
      const entry = bodiesDir(resolve(dir), projectRoot);
      dirs.set(entry.id, entry);
    }
  }
  for (const entry of removed) {
    if (entry.intent.destination.scope !== "out") continue;
    const root = entry.intent.destination.path;
    const out = bodiesDir(join(root, "memories"), root);
    dirs.set(out.id, out);
  }
  return [...dirs.values()];
}

function bodiesDir(dir: string, root: string): BodiesDir {
  return { id: realDirOf(dir), dir, root };
}

// The local names a source holds installed right now, read from what the last run left behind:
// the store copy on disk (the tree that run installed from, through the selection, so a hidden
// internal memory is not counted) or, with no copy, the recorded fetch through selection and
// renames; the memory each rule line's detail path names in its blocks; and in its bodies
// directories the links that point into its store entry and the copies whose bytes are one of
// its own memories and nobody else's (`ambiguous` holds the hashes several sources ship). A copy
// carries no owner of its own: one whose bytes match no current memory, because the memory has
// since changed, names no owner either, and the dedupe rule decides the name. At user scope a
// detail path names the store file, so it carries the upstream name and goes through the rename
// map too; at project scope it names the body, already local.
export async function retainedNames(
  key: string,
  entry: SourceEntry,
  ctx: EngineContext,
  io: EngineIo,
  ambiguous: ReadonlySet<ContentHash> = new Set(),
  installedSnapshot?: SourceTree | null,
): Promise<MemoryName[]> {
  const names = new Set<MemoryName>();
  const { intent } = entry;
  const storeEntry = storePathFor(ctx.home, intent.from);
  const live = intent.from.type === "local" && intent.from.live === true;
  const installed =
    installedSnapshot === undefined
      ? await installedTree(installedRoot(entry, ctx), intent)
      : installedSnapshot;
  if (installed !== null && !live) {
    for (const selected of selectMemories({
      memories: installed.memories,
      intent,
      installInternal: ctx.env.MAXIMS_INSTALL_INTERNAL === "1",
      disabled: new Set(),
      detailPath: () => "",
    }).selected) {
      names.add(selected.localName);
    }
  } else {
    const fetched = isFetchedEntry(entry) ? entry.fetched : undefined;
    for (const upstream of Object.keys(fetched?.memories ?? {})) {
      const parsed = parseMemoryName(upstream);
      if (parsed !== null && inSelect(intent.select, parsed)) {
        names.add(renamed(intent.rename, parsed));
      }
    }
  }
  const upstreamPaths = intent.destination.scope === "global";
  for (const path of retainedRuleFiles(entry, ctx, io)) {
    const text = readIfPresent(path);
    if (text === null) continue;
    const block = parseRuleBlocks(text).find((candidate) => candidate.source === key);
    for (const name of block?.names ?? []) {
      names.add(upstreamPaths ? renamed(intent.rename, name) : name);
    }
  }
  const entryReal = join(realDirOf(ctx.paths.store), relative(ctx.paths.store, storeEntry));
  const own = new Set(
    (installed?.memories ?? [])
      .map((memory) => memory.memory.contentHash)
      .filter((hash) => !ambiguous.has(hash)),
  );
  for (const dir of bodiesDirsFor(entry, ctx, io, undefined)) {
    for (const name of installedBodies(dir.dir, entryReal, own)) names.add(name);
  }
  return [...names];
}

// Where a source's installed memories are read from: a live source's own directory, else its
// store copy.
function installedRoot(entry: SourceEntry, ctx: EngineContext): string {
  const { from } = entry.intent;
  return from.type === "local" && from.live === true ? from.path : storePathFor(ctx.home, from);
}

async function installedTree(root: string, intent: SourceIntent): Promise<SourceTree | null> {
  if (!(await storeEntryPresent(root))) return null;
  try {
    return await readSourceMemories(root, intent, () => undefined);
  } catch {
    return null;
  }
}

// The memory names in a bodies directory that belong to one source: links resolving into its
// store entry, and copies whose bytes are one of its memories (`own` holds their content hashes).
// A directory that exists but cannot be listed stops the run: read as empty, it would hand every
// installed name to whichever source is older and let a write repoint another source's body.
function installedBodies(
  dir: string,
  entryReal: string,
  own: ReadonlySet<ContentHash>,
): MemoryName[] {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch (error) {
    if (isAbsent(error)) return [];
    const reason = error instanceof Error ? error.message : String(error);
    throw new MaximsError(ExitCode.DestinationWriteFailed, `cannot list ${dir}: ${reason}`, {
      hint: "fix the directory's permissions and run maxims sync again",
    });
  }
  const names: MemoryName[] = [];
  for (const name of entries) {
    if (!name.endsWith(".md")) continue;
    const path = join(dir, name);
    const stat = lstatSync(path, { throwIfNoEntry: false });
    if (stat === undefined) continue;
    const parsed = parseMemoryName(name.slice(0, -".md".length));
    if (parsed === null) continue;
    if (stat.isSymbolicLink()) {
      const target = resolve(realDirOf(dir), readlinkSync(path));
      if (target === entryReal || target.startsWith(`${entryReal}${sep}`)) names.push(parsed);
    } else if (stat.isFile() && own.has(contentHashOf(readFileSync(path, "utf8")))) {
      names.push(parsed);
    }
  }
  return names;
}

function retainedRuleFiles(entry: SourceEntry, ctx: EngineContext, io: EngineIo): string[] {
  const { intent } = entry;
  if (!intent.rule) return [];
  if (intent.destination.scope === "out") {
    return [join(intent.destination.path, `maxims-${sourceSlug(intent.from)}.md`)];
  }
  if (!actsHere(entry, ctx)) return [];
  return resolveTargets({
    intent,
    scope: intent.destination.scope,
    sourceSlug: sourceSlug(intent.from),
    ctx,
    harnesses: io.harnesses,
    agents: undefined,
    explicit: [],
  }).targets.map((target) => target.path);
}

// The `-o` rule files of sources that left intent or switched rules off, taken only when the file
// carries maxims markers: the name is derived, and a user's own file at it stays theirs. A file
// this run plans (an `-o` folder that is also a harness's rules directory) is kept: it is the
// current destination's, written moments before.
function removedOutRuleFiles(
  removed: readonly SourceEntry[],
  planned: ReadonlySet<string>,
): Change[] {
  const changes: Change[] = [];
  for (const entry of removed) {
    if (entry.intent.destination.scope !== "out") continue;
    const root = entry.intent.destination.path;
    const path = join(root, `maxims-${sourceSlug(entry.intent.from)}.md`);
    if (planned.has(realKeyOf(path))) continue;
    const text = readIfPresent(path);
    if (text === null || !claimedByMaxims(text)) continue;
    changes.push({ kind: "delete", path: assertInsideRoot(root, path) });
  }
  return changes;
}

function groupTargets(targets: HarnessTarget[]): HarnessTarget[][] {
  const groups = new Map<string, HarnessTarget[]>();
  for (const target of targets) {
    const group = groups.get(target.realKey) ?? [];
    group.push(target);
    groups.set(target.realKey, group);
  }
  return [...groups.values()];
}

// The detail path a rule line carries: absolute into the store at user scope, project-relative
// into the bodies directory at project scope so the committed file is machine-independent.
function detailPathFor(
  work: SourceWork,
  group: HarnessTarget[],
  ctx: EngineContext,
): (memory: SourceMemory, local: MemoryName) => string {
  if (work.scopeKind !== "project" || ctx.projectRoot === null) {
    return (memory) => join(work.storeEntry, ...memory.relPath.split("/"));
  }
  const projectRoot = ctx.projectRoot;
  const harnessCtx = { ...harnessContext(ctx), projectRoot };
  const bodiesDir =
    group
      .map((target) => target.def.bodiesDir("project", harnessCtx))
      .find((dir) => dir !== null) ?? join(projectRoot, ".agents", "memories");
  return (_memory, local) =>
    relative(projectRoot, join(bodiesDir, `${local}.md`))
      .split(sep)
      .join("/");
}

function supportsPathScoping(target: HarnessTarget): boolean {
  if (target.target.kind !== "rules-dir") return false;
  return target.target.frontmatter !== undefined || target.def.scopeFrontmatter !== undefined;
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
        `x  ${collision.name} is owned by ${collision.ownedBy}; run maxims add ${key} --rename ${collision.name}=<new>`,
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
  said.notice(`x  ${message}`);
  said.notice(`   ${resolution.hint}`);
  return { said, failure: { code: resolution.code, message, hint: resolution.hint } };
}

// Shared files this run planned no block for may still hold blocks of sources that left intent;
// they are visited so the orphan strip reaches them.
function addSharedFilesWithOrphans(
  files: Map<string, RuleFile>,
  scopes: Scope[],
  ctx: EngineContext,
  io: EngineIo,
  agents: HarnessFilter | undefined,
): void {
  for (const def of io.harnesses) {
    if (!agentsAllowed(agents, def.id)) continue;
    for (const scope of scopes) {
      const target = def.targets[scope];
      if (target === null || target.kind !== "shared-block") continue;
      const [only] = resolveTargets({
        intent: { harnesses: [def.id] },
        scope,
        sourceSlug: "",
        ctx,
        harnesses: io.harnesses,
        agents: undefined,
        explicit: [],
      }).targets;
      if (only === undefined || files.has(only.realKey)) continue;
      if (readIfPresent(only.path) === null) continue;
      files.set(only.realKey, {
        kind: "harness",
        path: only.path,
        sourceSlug: "",
        targets: [only],
        blocks: [],
      });
    }
  }
}
