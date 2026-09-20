import { lstatSync, readdirSync, readFileSync, readlinkSync } from "node:fs";
import { join, relative, resolve, sep } from "node:path";
import type { HarnessId, Scope } from "../../harnesses/contract.ts";
import {
  type ContentHash,
  contentHashOf,
  type MemoryName,
  parseMemoryName,
} from "../../memory/contract.ts";
import { parseBlocks } from "../../rulefile/block.ts";
import {
  buildNameIndex,
  type IndexedSource,
  type Resolution,
  resolveSourceCandidates,
  shortHash,
} from "../../rulefile/dedupe.ts";
import type { RuleLine, Staleness } from "../../rulefile/types.ts";
import { materializeLocal } from "../../sources/local.ts";
import type { Fetched, SourceEntry, SourceIntent, State } from "../../state/schema.ts";
import { serializeState, WRITTEN_BY } from "../../state/store.ts";
import type { Change, Plan } from "../../util/change.ts";
import { ExitCode, MaximsError } from "../../util/exit-codes.ts";
import { assertInsideRoot, type RootedPath } from "../../util/fs.ts";
import { storePathFor } from "../../util/home.ts";
import type { EngineIo, HarnessFilter, SyncOptions, SyncReport } from "../types.ts";
import { planBodies, planBodySweep } from "./bodies.ts";
import { agentsAllowed, type EngineContext, harnessContext } from "./context.ts";
import { type HarnessTarget, realDirOf, realKeyOf, resolveTargets } from "./destination.ts";
import { type FetchedEntry, refreshSource, storeEntryPresent } from "./fetch.ts";
import { planHooks } from "./hooks.ts";
import { readSourceMemories, type SourceMemory, type SourceTree } from "./memories.ts";
import { Notices } from "./notices.ts";
import { planOrphanSweep } from "./orphans.ts";
import { PlanBuilder } from "./plan.ts";
import { readProjectLock } from "./project-lock-io.ts";
import {
  isAbsent,
  planRuleFile,
  planRulesDirSweep,
  type RuleFile,
  type RuleFilePlan,
  readIfPresent,
} from "./rules.ts";
import { disabledNames, inSelect, renamed, selectMemories } from "./select.ts";
import { sourceSlug } from "./slug.ts";

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

export type SyncOutcome = {
  plan: Plan;
  deferred: Change[];
  report: SyncReport;
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
  await noticeLockOnlySources(state, ctx, base);
  const refreshed = await refreshAll(state, ctx, io, options, base);
  const carried = new Notices();
  const carriedFailures: SyncFailure[] = [];
  // A readable source refused by admission is planned again as if unreadable: its block stays
  // and the names that block points at stay reserved, so no newer source takes its bodies over.
  const held = new Set<string>();
  for (;;) {
    const attempt = await planInstall(state, ctx, io, options, extras, refreshed, held);
    const retry = [...attempt.refusedFresh, ...attempt.refusedKept];
    if (retry.length === 0) {
      const notices = new Notices();
      notices.absorb(base);
      for (const key of refreshed.fetchedKeys) {
        for (const line of refreshed.lines.get(key) ?? []) notices.notice(line);
      }
      // A reason the final attempt found again on its own is said once.
      const said = new Set(attempt.notices.user);
      for (const line of carried.user) if (!said.has(line)) notices.notice(line);
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
      return {
        plan: built.plan,
        deferred: built.deferred,
        report: {
          sources: attempt.sources,
          memories: attempt.memories,
          rules: attempt.rules,
          tokens: attempt.tokens,
          fetched: refreshed.fetchedKeys,
          failed: refreshed.failed,
          changed: [...new Set(built.plan.changes.map((change) => change.path))],
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
      for (const line of refusal.lines) carried.notice(line);
      carriedFailures.push(refusal.failure);
    }
  }
}

// What one source's refusal said, kept with its key so a retry carries exactly it.
type Refusal = { key: string; lines: string[]; failure: SyncFailure };

type Attempt = {
  builder: PlanBuilder;
  notices: Notices;
  failures: SyncFailure[];
  refusals: Refusal[];
  refusedFresh: string[];
  refusedKept: string[];
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
): Promise<Attempt> {
  const notices = new Notices();
  const builder = new PlanBuilder();
  const failures: SyncFailure[] = [];
  const refusals: Refusal[] = [];
  const refusedFresh: string[] = [];
  const refusedKept: string[] = [];
  const refuse = (key: string, lines: string[], failure: SyncFailure): void => {
    for (const line of lines) notices.notice(line);
    failures.push(failure);
    refusals.push({ key, lines, failure });
    if (refreshed.freshTrees.has(key)) refusedFresh.push(key);
    else refusedKept.push(key);
  };
  const read = await readTrees(
    refreshed.sources,
    refreshed.freshTrees,
    held,
    ctx,
    notices,
    builder,
  );
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
    const targets =
      work.scopeKind === "out"
        ? { targets: [], skipped: [] }
        : resolveTargets({
            intent,
            scope: work.scopeKind,
            sourceSlug: slug,
            ctx,
            harnesses: io.harnesses,
            agents: options.agents,
          });
    for (const skipped of targets.skipped) {
      notices.notice(`maxims: ${key}: skipped ${skipped.id} (${skipped.reason})`);
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
      const said = resolutionFailure(key, admission);
      refuse(key, said.lines, said.failure);
      continue;
    }
    for (const dir of allDirs) {
      const wanted = bodiesWanted.get(dir.id) ?? { ...dir, wanted: new Set<string>() };
      bodiesWanted.set(dir.id, wanted);
      for (const selected of selection.selected) wanted.wanted.add(selected.localName);
    }
    builder.add("store", refreshed.storeChanges.get(key) ?? [], key);
    for (const dir of bodiesDirsFor(work, ctx, io, options.agents)) {
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
        file: files.get(first.realKey) ?? {
          kind: "harness",
          path: first.path,
          sourceSlug: slug,
          targets: group,
          blocks: [],
        },
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
        changeLines: refreshed.changeLines.get(key) ?? [],
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
    const resolved = resolveTargets({
      intent: source.entry.intent,
      scope,
      sourceSlug: sourceSlug(source.entry.intent.from),
      ctx,
      harnesses: io.harnesses,
      agents: options.agents,
    });
    for (const skipped of resolved.skipped) {
      if (skipped.kind === "unreachable") unreachable.add(`${skipped.id}@${scope}`);
    }
    if (!source.entry.intent.rule) continue;
    for (const target of resolved.targets) {
      planned.add(target.realKey);
      keepBlock(source.key, target.realKey);
    }
  }
  const scopes: Scope[] = ctx.projectRoot === null ? ["global"] : ["global", "project"];
  addSharedFilesWithOrphans(files, scopes, ctx, io, options.agents);
  // A harness's byte budget is only known once a file is rendered. Over it, every source in that
  // file is refused whole (bodies, store swap and its blocks in every other file), the same shape
  // as the rule cap, and the remaining files are rendered again without it.
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
    const lines = [
      `x  ${error.message}`,
      ...(error.hint === undefined ? [] : [`   ${error.hint}`]),
    ];
    const failure = { code: error.code, message: error.message, hint: error.hint };
    const refused = new Set(file.blocks.map((block) => block.key));
    for (const line of lines) notices.notice(line);
    failures.push(failure);
    for (const each of files.values()) {
      for (const block of each.blocks) {
        if (refused.has(block.key)) keepBlock(block.key, fileIdentity(each));
      }
    }
    for (const key of refused) {
      builder.drop(key);
      refusals.push({ key, lines, failure });
      if (refreshed.freshTrees.has(key)) refusedFresh.push(key);
      else refusedKept.push(key);
      for (const dir of dirsByKey.get(key) ?? []) unsweepable.add(dir);
    }
    for (const each of files.values()) {
      for (const block of each.blocks) if (refused.has(block.key)) rules -= block.lines.length;
      each.blocks = each.blocks.filter((block) => !refused.has(block.key));
    }
  }
  builder.add(
    "removal",
    planRulesDirSweep({
      ctx,
      harnesses: io.harnesses,
      agents: options.agents,
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
  const entries = Object.values(refreshed.sources);
  const outRulesOff = entries.filter((entry) => !entry.intent.rule);
  builder.add("removal", removedOutRuleFiles([...extras.removed, ...outRulesOff]));
  const at = (scope: Scope, id: HarnessId) =>
    entries.filter(
      (entry) => entry.intent.destination.scope === scope && entry.intent.harnesses.includes(id),
    );
  const hooks = await planHooks({
    ctx,
    harnesses: io.harnesses,
    agents: options.agents,
    wants: (id, scope) => ({
      hook: state.hooks.includes(id) && at(scope, id).length > 0,
      rules: at(scope, id).some((entry) => entry.intent.rule),
      unreachable: unreachable.has(`${id}@${scope}`),
    }),
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
  builder.add("orphan", planOrphanSweep(ctx.home, expected, warn));
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
    hookRun,
    sources: works.length,
    memories,
    rules,
    tokens,
    nextState,
  };
}

// The identity a rule file is kept and grouped under: the real path of the target file.
function fileIdentity(file: RuleFile): string {
  return file.kind === "harness" ? (file.targets[0]?.realKey ?? file.path) : realKeyOf(file.path);
}

type RenderedFiles =
  | { ok: true; plans: RuleFilePlan[] }
  | { ok: false; file: RuleFile; error: MaximsError };

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
      if (!(error instanceof MaximsError) || error.code !== ExitCode.RuleCapExceeded) throw error;
      return { ok: false, file, error };
    }
  }
  return { ok: true, plans };
}

// The lock is a projection the CLI writes; sync only says when it names a source this machine
// never installed, and never installs from it.
async function noticeLockOnlySources(
  state: State,
  ctx: EngineContext,
  notices: Notices,
): Promise<void> {
  if (ctx.projectRoot === null) return;
  const lock = await readProjectLock(ctx.projectRoot);
  if (lock.kind === "corrupt") {
    notices.notice(`maxims: ${lock.path} could not be read: ${lock.issues.join("; ")}`);
    return;
  }
  if (lock.kind !== "parsed") return;
  const missing = lock.keys.filter((key) => !Object.hasOwn(state.sources, key));
  if (missing.length === 0) return;
  const verb = missing.length === 1 ? "is" : "are";
  notices.notice(
    `maxims: ${missing.join(", ")} ${verb} in .agents/maxims.lock but not installed here; run maxims install`,
  );
}

// `storeChanges` are held per source until admission: a fresh fetch that collides or exceeds the
// cap is refused whole, and `refuse` puts the source's previous entry back so the store and the
// state keep last-good.
type Refreshed = {
  sources: State["sources"];
  freshTrees: Map<string, SourceTree>;
  storeChanges: Map<string, Change[]>;
  changeLines: Map<string, string[]>;
  // The lines a fresh refresh earns ("refreshed", new upstream names), shown only once the
  // refresh has survived admission.
  lines: Map<string, string[]>;
  fetchedKeys: string[];
  failed: SyncReport["failed"];
  refuse(key: string): void;
};

// A failed fetch is never a stop: the source keeps last-good and the failure is reported, so the
// caller decides what a manual run's exit says about it.
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
  const changeLines = new Map<string, string[]>();
  const lines = new Map<string, string[]>();
  const fetchedKeys: string[] = [];
  const failed: SyncReport["failed"] = [];
  for (const key of Object.keys(state.sources).sort()) {
    const entry = state.sources[key];
    if (entry === undefined) continue;
    const installable = entry.intent.destination.scope !== "project" || ctx.projectRoot !== null;
    if (!isFetchedEntry(entry) || !installable) {
      sources[key] = entry;
      continue;
    }
    // A run limited to some harnesses leaves the store alone: a refresh reaches every harness's
    // rule file, and the ones outside the filter would be left pointing at bodies the swap
    // removed.
    const result = await refreshSource(key, entry, ctx, io, notices, {
      force: options.force,
      noFetch: options.noFetch || options.agents !== undefined,
    });
    sources[key] = result.entry;
    switch (result.outcome) {
      case "fresh": {
        fetchedKeys.push(key);
        freshTrees.set(key, result.tree);
        storeChanges.set(key, result.storeChanges);
        const earned = [`maxims: ${key} refreshed (${shortSha(result.tree.sha)})`];
        const after = result.entry.fetched?.memories ?? {};
        changeLines.set(key, diffLines(entry.fetched?.memories ?? {}, after));
        if (result.newUpstream.length > 0) {
          const names = result.newUpstream.join(", ");
          earned.push(`maxims: ${key} has new memories not in your selection: ${names}`);
        }
        lines.set(key, earned);
        break;
      }
      case "failed":
      case "no-valid":
        notices.trace(`${key}: fetch failed (${result.error.kind}): ${result.error.message}`);
        failed.push({ key, message: result.error.message });
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

function diffLines(before: Fetched["memories"], after: Fetched["memories"]): string[] {
  const old = new Map(Object.entries(before));
  const next = new Map(Object.entries(after));
  const lines: string[] = [];
  for (const name of [...new Set([...old.keys(), ...next.keys()])].sort()) {
    const was = old.get(name);
    const is = next.get(name);
    if (was === undefined && is !== undefined) lines.push(`+ ${name}`);
    else if (was !== undefined && is === undefined) lines.push(`- ${name}`);
    else if (was !== undefined && is !== undefined && was.content !== is.content) {
      lines.push(`~ ${name} (${shortHash(was.content)} -> ${shortHash(is.content)})`);
    }
  }
  return lines;
}

type ReadTrees = { works: SourceWork[]; unreadable: { key: string; entry: SourceEntry }[] };

// The memories every source installs from: a fresh fetch's own files, a live source's directory,
// or the store copy. A source with nothing readable keeps whatever blocks it has on disk.
async function readTrees(
  sources: State["sources"],
  freshTrees: Map<string, SourceTree>,
  held: ReadonlySet<string>,
  ctx: EngineContext,
  notices: Notices,
  builder: PlanBuilder,
): Promise<ReadTrees> {
  const works: SourceWork[] = [];
  const unreadable: ReadTrees["unreadable"] = [];
  const installInternal = ctx.env.MAXIMS_INSTALL_INTERNAL === "1";
  for (const key of Object.keys(sources).sort()) {
    const entry = sources[key];
    if (entry === undefined) continue;
    const { intent } = entry;
    const scopeKind = intent.destination.scope;
    if (scopeKind === "project" && ctx.projectRoot === null) {
      notices.trace(`${key}: project-scoped, but no project root was found; skipped`);
      continue;
    }
    const storeEntry = storePathFor(ctx.home, intent.from);
    const live = intent.from.type === "local" && intent.from.live === true;
    if (
      live &&
      intent.from.type === "local" &&
      currentLinkTarget(storeEntry) !== resolve(intent.from.path)
    ) {
      builder.add("store", materializeLocal(intent.from, ctx.home, []));
    }
    const read: TreeRead = held.has(key)
      ? { kind: "unreadable", reason: "refused this run" }
      : await treeFor(key, entry, storeEntry, freshTrees, notices);
    if (read.kind === "unreadable") {
      if (!held.has(key))
        notices.notice(`maxims: ${key}: ${read.reason}; kept whatever is installed`);
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
    });
  }
  return { works, unreadable };
}

export type TreeRead = { kind: "tree"; tree: SourceTree } | { kind: "unreadable"; reason: string };

async function treeFor(
  key: string,
  entry: SourceEntry,
  storeEntry: RootedPath,
  freshTrees: Map<string, SourceTree>,
  notices: Notices,
): Promise<TreeRead> {
  const fresh = freshTrees.get(key);
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
    return { kind: "unreadable", reason: lastError?.message ?? "not fetched yet" };
  }
  try {
    const tree = await readSourceMemories(root, intent, warn);
    // A tree whose every file fails the contract is the "layout changed" case, not an empty
    // source: what is installed stays until a valid memory is back.
    if (tree.memories.length === 0 && tree.invalid.length > 0) {
      const reasons = tree.invalid.map((file) => `${file.relPath}: ${file.reason}`).join("; ");
      return { kind: "unreadable", reason: `no valid memories (${reasons})` };
    }
    return { kind: "tree", tree };
  } catch (cause) {
    return { kind: "unreadable", reason: cause instanceof Error ? cause.message : String(cause) };
  }
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
    const span = parseBlocks(text).blocks.find((block) => block.source === key);
    if (span === undefined) continue;
    for (const match of text.slice(span.start, span.end).matchAll(DETAIL_PATH)) {
      const parsed = parseMemoryName(detailStem(match[1] ?? ""));
      if (parsed !== null) names.add(upstreamPaths ? renamed(intent.rename, parsed) : parsed);
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

// The renderer wraps a detail token holding a reference-looking `@` in backticks, comma
// included, so the path is read up to the comma with an optional fence on either side.
const DETAIL_PATH = /\(detail: `?(.+?),`? [0-9a-f]{7}\)$/gm;

// The memory name a rendered detail path ends in. The renderer turns backslashes, backticks, `<`,
// `[` and tilde runs into entities on a line holding a reference token, and a path written on
// Windows separates with backslashes, so both are undone before the last segment is taken.
function detailStem(rendered: string): string {
  const path = rendered
    .replaceAll("&#92;", "\\")
    .replaceAll("&#96;", "`")
    .replaceAll("&lt;", "<")
    .replaceAll("&#91;", "[")
    .replaceAll("&#126;", "~");
  const last = path.split(/[\\/]/).pop() ?? "";
  return last.endsWith(".md") ? last.slice(0, -".md".length) : last;
}

function retainedRuleFiles(entry: SourceEntry, ctx: EngineContext, io: EngineIo): string[] {
  const { intent } = entry;
  if (!intent.rule) return [];
  if (intent.destination.scope === "out") {
    return [join(intent.destination.path, `maxims-${sourceSlug(intent.from)}.md`)];
  }
  if (intent.destination.scope === "project" && ctx.projectRoot === null) return [];
  return resolveTargets({
    intent,
    scope: intent.destination.scope,
    sourceSlug: sourceSlug(intent.from),
    ctx,
    harnesses: io.harnesses,
    agents: undefined,
  }).targets.map((target) => target.path);
}

function removedOutRuleFiles(removed: readonly SourceEntry[]): Change[] {
  const changes: Change[] = [];
  for (const entry of removed) {
    if (entry.intent.destination.scope !== "out") continue;
    const root = entry.intent.destination.path;
    const path = join(root, `maxims-${sourceSlug(entry.intent.from)}.md`);
    if (readIfPresent(path) === null) continue;
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
  if (resolution.code === ExitCode.NameCollision) {
    const names = resolution.collisions.map((collision) => collision.name).join(", ");
    return {
      lines: resolution.collisions.map(
        (collision) =>
          `x  ${collision.name} is owned by ${collision.ownedBy}; run maxims add ${key} --rename ${collision.name}=<new>`,
      ),
      failure: {
        code: resolution.code,
        message: `${key}: name collision on ${names}`,
        hint: `run maxims add ${key} --rename <name>=<new> for each colliding memory`,
      },
    };
  }
  const message = `${key}: ${resolution.count} rule lines exceed the cap of ${resolution.cap}`;
  return {
    lines: [`x  ${message}`, `   ${resolution.hint}`],
    failure: { code: resolution.code, message, hint: resolution.hint },
  };
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
