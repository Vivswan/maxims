// One install attempt over the refreshed sources: admission, bodies, rule files, hooks and the
// sweeps, as one plan. `planSync` retries it until no source is refused.

import { join, resolve } from "node:path";
import { heldForReview } from "../console/strings.ts";
import type { HarnessId } from "../contracts/harness-id.ts";
import type { Scope, SourceSlug } from "../harnesses/contract.ts";
import type { BudgetExceeded } from "../harnesses/strategies/rules-dir.ts";
import type { ContentHash, MemoryName } from "../memory/contract.ts";
import {
  buildNameIndex,
  type IndexedSource,
  type NameIndex,
  type Resolution,
  resolveSourceCandidates,
} from "../rulefile/dedupe.ts";
import { type RuleLine, staleSentence } from "../rulefile/types.ts";
import type { SourceEntry, SourceIntent, State } from "../state/schema.ts";
import { serializeState, WRITTEN_BY } from "../state/store.ts";
import { ExitCode } from "../util/exit-codes.ts";
import { assertInsideRoot, isSymlink, realKeyOf } from "../util/fs.ts";
import { homePaths, pendingPathFor, storePathFor } from "../util/home.ts";
import { planBodies, planBodySweep } from "./bodies.ts";
import { actsHere, agentsAllowed, type EngineContext } from "./context.ts";
import { type HarnessTarget, resolveTargets } from "./destination.ts";
import { destinationUnresolvable } from "./fs-probe.ts";
import { type HarnessWants, hookedAt, type LinkJudge, planHooks } from "./hooks.ts";
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
  type RuleFilePlan,
} from "./rules.ts";
import { disabledNames, type SelectedMemory, type Selection, selectMemories } from "./select.ts";
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
import type { EngineIo, HarnessFilter, SymlinkSupport, SyncOptions, SyncReport } from "./types.ts";

type Refusal = { key: string; said: Notices; failure: SyncFailure | null };

// A held rule file's reason, one object for every source frozen into it: `planSync` carries a
// reason once by comparing the `said` object itself. `frozen` names the sources refused for it.
type Hold = { said: Notices; failure: SyncFailure | null; frozen: Set<string> };

type LinkedHold = { hold: RuleFileHeld; owner: string | undefined };

type UnreadableSource = { key: string; entry: SourceEntry };

type WantedBodies = { dir: string; root: string; wanted: Set<string> };

// Every installed tree as the state as read left it, and the content hashes several of them hold:
// a copy with several owners has none, and the dedupe rule decides its name.
type InstalledSnapshot = { trees: Map<string, SourceTree | null>; ambiguous: Set<ContentHash> };

//   targets  -> the harness files `-a` lets this run write for the source
//   dirs     -> every bodies directory the source writes to, whatever `-a` limited the run to
type SelectedSource = {
  work: SourceWork;
  slug: SourceSlug;
  selection: Selection;
  targets: HarnessTarget[];
  dirs: ReturnType<typeof bodiesDirsFor>;
};

type Admitted = Extract<Resolution, { ok: true }>;

type DetailPath = (memory: SourceMemory, local: MemoryName) => string;

type FileRequest = { file: RuleFile; lines: RuleLine[] };

//   held     -> sources `planSync` plans again as unreadable after a refused admission
//   overlay  -> store trees a preview supplies in place of what is on disk
type InstallInput = {
  state: State;
  ctx: EngineContext;
  io: EngineIo;
  options: SyncOptions;
  extras: SyncExtras;
  refreshed: Refreshed;
  held: ReadonlySet<string>;
  overlay: StoreOverlay;
};

//   failed          -> live sources whose directory could not be read this run
//   awaitingReview  -> sources with a revision held for review at the end of this run, made now
//                      or earlier, with what it changes: a session hears about a waiting revision
//                      at every start, as it does about a stale source
export type Attempt = {
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

// The accumulators of one attempt, with the verbs the phases share.
//   planned       -> real paths of the rule files this run plans or keeps, the identity the sweep
//                    compares by
//   keepAt        -> blocks kept in a file this run renders none for, keyed by real path as the
//                    rule files are, so two spellings of one file agree
//   retained      -> rule files this run renders no block into although their source is still
//                    installed, kept for the sweep and the link judgment; a rules-dir file is
//                    written whole, so wherever it is visited the block is kept and the harness
//                    counted among its readers, while a `-o` file has no reader to count
//   knownCopies   -> bytes of every memory this run knows (the trees read now, the previous fetch
//                    facts, what the caller just removed): a regular file in a bodies directory
//                    is ours when it matches one
//   bodiesWanted  -> bodies to keep per directory for every admitted or refused source, whatever
//                    `-a` limited this run to, so a sweep never takes a body another harness's
//                    rule line points at
//   unsweepable   -> directories an unreadable or refused source writes to, not swept at all,
//                    since its names are unknown this run
//   dirsByKey     -> each readable source's bodies directories, for a refusal after admission
//   unreachable   -> `harness@scope` pairs whose config folder is absent, for the hook planner
//   entries       -> the entries acting here; `elsewhere` the ones installed for another project
class InstallRun {
  readonly notices: Notices;

  readonly builder = new PlanBuilder();

  readonly failures: SyncFailure[] = [];

  readonly refusals: Refusal[] = [];

  readonly refusedFresh: string[] = [];

  readonly refusedKept: string[] = [];

  readonly heldFiles: string[] = [];

  readonly stale: string[] = [];

  readonly works: SourceWork[];

  readonly unreadable: UnreadableSource[];

  readonly workKeys: Set<string>;

  readonly files = new Map<string, RuleFile>();

  readonly planned = new Set<string>();

  readonly keepAt = new Map<string, Set<string>>();

  readonly retained: Retained[] = [];

  readonly holds = new Map<string, Hold>();

  readonly linkedHolds: LinkedHold[] = [];

  readonly knownCopies: Set<ContentHash>;

  readonly bodiesWanted = new Map<string, WantedBodies>();

  readonly unsweepable = new Set<string>();

  readonly dirsByKey = new Map<string, string[]>();

  readonly unreachable = new Set<string>();

  readonly hookRun: boolean;

  readonly agents: HarnessFilter | undefined;

  readonly explicit: readonly HarnessId[];

  readonly scopes: Scope[];

  readonly entries: SourceEntry[];

  readonly elsewhere: SourceEntry[];

  memories = 0;

  tokens = 0;

  constructor(
    readonly input: InstallInput,
    notices: Notices,
    read: Awaited<ReturnType<typeof readTrees>>,
  ) {
    const { ctx, options, extras, refreshed } = input;
    this.notices = notices;
    this.works = read.works;
    this.unreadable = read.unreadable;
    this.workKeys = new Set(read.works.map((work) => work.key));
    this.knownCopies = new Set([
      ...extras.removedCopies,
      ...recordedCopies(Object.values(extras.previousState.sources)),
    ]);
    this.hookRun = extras.verb === "sync" && options.quiet;
    this.agents = widenedAgents(options.agents, refreshed);
    this.explicit = options.agents ?? [];
    this.scopes = ctx.projectRoot === null ? ["global"] : ["global", "project"];
    const sources = Object.values(refreshed.sources);
    this.entries = sources.filter((entry) => actsHere(entry, ctx));
    this.elsewhere = sources.filter((entry) => !actsHere(entry, ctx));
  }

  warn(line: string): void {
    this.notices.notice(`maxims: ${line}`);
  }

  // A source refused whole: `said` carries its lines on the channel the reason earns, `failure`
  // what the verb exits with, or null where the reason fails no verb this run. `record` alone is
  // for a reason already said, a held file several sources render into; `refuse` says it first.
  record(key: string, said: Notices, failure: SyncFailure | null): void {
    this.refusals.push({ key, said, failure });
    if (this.input.refreshed.freshTrees.has(key)) this.refusedFresh.push(key);
    else this.refusedKept.push(key);
  }

  refuse(key: string, said: Notices, failure: SyncFailure | null): void {
    this.notices.absorb(said);
    if (failure !== null) this.failures.push(failure);
    this.record(key, said, failure);
  }

  // A block kept in a file this run renders none of its source's: an unreadable or refused source
  // keeps its last-good block only where its intent still puts one, so a harness the user dropped
  // loses it like any other.
  keepBlock(key: string, realKey: string): void {
    const kept = this.keepAt.get(realKey) ?? new Set<string>();
    kept.add(key);
    this.keepAt.set(realKey, kept);
  }

  // A rule file this run renders no block into although its source is still installed: it stays
  // planned so the sweep leaves it, its block is kept, and the link judgment counts it.
  retain(kept: Retained): void {
    const realKey = kept.kind === "harness" ? kept.target.realKey : kept.realKey;
    this.planned.add(realKey);
    this.keepBlock(kept.key, realKey);
    this.retained.push(kept);
  }

  // A hold that leaves the rules current fails only the remove verb: the user asked for that
  // removal by name, and a hook run must stay exit 0. A hold over a block no run can refresh fails
  // every verb.
  private holdFailure(hold: RuleFileHeld): SyncFailure | null {
    if (this.input.extras.verb !== "remove" && hold.fails === "remove") return null;
    const failure: SyncFailure = { code: ExitCode.DestinationWriteFailed, message: hold.message };
    if (hold.hint !== undefined) failure.hint = hold.hint;
    return failure;
  }

  // A held file keeps its bytes: it stays planned so the sweep leaves it, and its lines go out
  // loud, since the block a session expects gone is still loaded.
  private openHold(realKey: string, hold: RuleFileHeld): Hold {
    this.planned.add(realKey);
    this.heldFiles.push(hold.path);
    const said = new Notices();
    said.loud(`maxims: ${hold.message}`);
    if (hold.hint !== undefined) said.loud(`maxims: ${hold.hint}`);
    const failure = this.holdFailure(hold);
    this.notices.absorb(said);
    if (failure !== null) this.failures.push(failure);
    const taken: Hold = { said, failure, frozen: new Set() };
    this.holds.set(realKey, taken);
    return taken;
  }

  // The held block's detail lines link its source's store entry, so a source with work this run
  // is refused whole, like an over-budget one, once it is frozen into the hold.
  private freeze(taken: Hold, key: string): void {
    if (!this.workKeys.has(key) || taken.frozen.has(key)) return;
    taken.frozen.add(key);
    this.record(key, taken.said, taken.failure);
  }

  // Frozen into the hold: `owner`, the source whose block the reservation's read found in the
  // file, and every source that renders into it. The reservation precedes every block request,
  // and a run limited by -a requests none outside its filter.
  takeHold(hold: RuleFileHeld, owner?: string): void {
    const realKey = realKeyOf(hold.path);
    let taken = this.holds.get(realKey);
    if (taken === undefined) taken = this.openHold(realKey, hold);
    if (owner !== undefined) this.freeze(taken, owner);
    for (const file of this.files.values()) {
      if (fileIdentity(file) !== realKey) continue;
      for (const block of file.blocks) this.freeze(taken, block.key);
    }
  }

  // A link at a rule file's path holds nothing while this run writes or deletes the path: either
  // replaces the link and never reaches the file behind it. A link no change replaces (a hook run
  // defers its deletions) stays, its block loaded, and is held like a file. Which it is is known
  // once every file is rendered.
  reserveHold(hold: RuleFileHeld, owner: string | undefined): void {
    if (isSymlink(hold.path)) this.linkedHolds.push({ hold, owner });
    else this.takeHold(hold, owner);
  }
}

// Said for every source standing held, admitted or not: a refused source keeps the very block
// the held revision would replace, so the hold is as live for it as for an admitted one.
function heldRevisions(
  refreshed: Refreshed,
  ctx: EngineContext,
  notices: Notices,
): Attempt["awaitingReview"] {
  const awaiting: Attempt["awaitingReview"] = [];
  for (const [key, entry] of Object.entries(refreshed.sources)) {
    if (!actsHere(entry, ctx) || !isFetchedEntry(entry) || entry.pending === undefined) continue;
    awaiting.push({ key, summary: entry.pending.summary });
    notices.loud(heldForReview(key, entry.pending.summary.length));
  }
  return awaiting;
}

async function installedSnapshot(run: InstallRun): Promise<InstalledSnapshot> {
  const { ctx, extras } = run.input;
  const trees = new Map<string, SourceTree | null>();
  const hashOwners = new Map<ContentHash, number>();
  for (const [key, entry] of Object.entries(extras.previousState.sources)) {
    const tree = await installedTree(installedRoot(entry, ctx), entry.intent);
    trees.set(key, tree);
    for (const hash of new Set((tree?.memories ?? []).map((memory) => memory.memory.contentHash))) {
      hashOwners.set(hash, (hashOwners.get(hash) ?? 0) + 1);
    }
  }
  const ambiguous = new Set([...hashOwners].filter(([, count]) => count > 1).map(([hash]) => hash));
  return { trees, ambiguous };
}

async function installedNames(
  run: InstallRun,
  key: string,
  snapshot: InstalledSnapshot,
): Promise<MemoryName[]> {
  const { ctx, io, extras } = run.input;
  const entry = extras.previousState.sources[key];
  if (entry === undefined) return [];
  return retainedNames({
    key,
    entry,
    ctx,
    io,
    hold: (held, owned) => run.reserveHold(held, owned ? key : undefined),
    ambiguous: snapshot.ambiguous,
    installedSnapshot: snapshot.trees.get(key) ?? null,
  });
}

// What a source holds on disk enters the name index first, dated before every source, so a memory
// another source newly ships under an installed name collides instead of taking the body over.
//   its names        the installed copy read through the selection, else the state's fetch
//                    record; plus what its blocks and its bodies directories name
//   a dropped name   leaves a block this run rewrites, and a hook run defers deletions: a
//                    linked body reserves it until an interactive run sweeps it, a copy only
//                    while the store copy still holds its bytes
async function indexNames(run: InstallRun): Promise<NameIndex> {
  const snapshot = await installedSnapshot(run);
  const installedFirst: IndexedSource[] = [];
  for (const key of [...run.works.map((work) => work.key), ...run.unreadable.map((s) => s.key)]) {
    installedFirst.push({
      key,
      addedAt: INSTALLED_FIRST,
      intent: { select: "*", rename: {} },
      names: await installedNames(run, key, snapshot),
    });
  }
  return buildNameIndex([
    ...installedFirst,
    ...run.works.map((work) => ({
      key: work.key,
      addedAt: work.entry.addedAt,
      intent: work.intent,
      names: work.ownedUpstreamNames,
    })),
  ]);
}

// The memories a source brings in this run, counted and said. The hidden-internal line goes with
// the fetch that brought them in, never repeated by a run that fetched nothing: an interactive
// sync and the log would otherwise carry it every run.
function selectSource(run: InstallRun, work: SourceWork): Selection {
  const { state, ctx, refreshed } = run.input;
  const selection = selectMemories({
    memories: work.tree.memories,
    intent: work.intent,
    installInternal: ctx.installInternal,
    disabled: disabledNames(state, work.scopeKind, ctx.projectRoot),
    detailPath: () => "",
  });
  run.memories += selection.selected.length;
  if (selection.hiddenInternal > 0 && refreshed.freshTrees.has(work.key)) {
    run.notices.notice(`maxims: ${work.key}: ${selection.hiddenInternal} internal, hidden`);
  }
  for (const memory of work.tree.memories) run.knownCopies.add(memory.memory.contentHash);
  // The one line a session hears about a stale source, the sentence the rule-file line carries.
  if (work.stale !== undefined) {
    run.stale.push(work.key);
    run.notices.loud(`maxims: ${staleSentence(`the rules from ${work.key}`, work.stale)}`);
  }
  return selection;
}

// The harness files `-a` lets this run write for the source. A target the filter leaves out is
// retained, its block kept where the file is rendered; a skipped harness is said, and one whose
// config folder is absent stays unreachable for the hook planner too.
function resolveSourceTargets(
  run: InstallRun,
  work: SourceWork,
  slug: SourceSlug,
): HarnessTarget[] {
  if (work.scopeKind === "out") return [];
  const { ctx, io } = run.input;
  const { intent, key } = work;
  const resolved = resolveTargets({
    intent,
    scope: work.scopeKind,
    sourceSlug: slug,
    ctx,
    harnesses: io.harnesses,
    agents: undefined,
    explicit: run.explicit,
  });
  if (intent.rule) {
    for (const target of resolved.targets) {
      if (!agentsAllowed(run.agents, target.def.id)) {
        run.retained.push({ key, kind: "harness", target });
      }
    }
  }
  for (const skipped of resolved.skipped) {
    if (agentsAllowed(run.agents, skipped.id)) {
      run.notices.notice(`maxims: ${key}: skipped ${skipped.id} (${skipped.reason})`);
    }
    if (skipped.kind === "unreachable") run.unreachable.add(`${skipped.id}@${work.scopeKind}`);
  }
  return resolved.targets.filter((target) => agentsAllowed(run.agents, target.def.id));
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

// A source whose names collide, or whose rule set is over the cap, is refused whole: neither
// its bodies nor its blocks land, its fresh fetch is not kept, and whatever it has on disk
// stays, bodies included, since the names it installed before are not known this run.
function refuseSource(
  run: InstallRun,
  source: SelectedSource,
  admission: Exclude<Resolution, { ok: true }>,
): void {
  const { work, slug } = source;
  const { intent, key } = work;
  for (const target of source.targets) {
    run.planned.add(target.realKey);
    run.keepBlock(key, target.realKey);
  }
  if (intent.destination.scope === "out" && intent.rule) {
    run.keepBlock(key, realKeyOf(outRuleFile(intent.destination.path, slug)));
  }
  for (const dir of source.dirs) run.unsweepable.add(dir.id);
  const refusal = resolutionFailure(key, admission);
  run.refuse(key, refusal.said, refusal.failure);
}

// The source's bodies: every directory it writes to keeps its names through the sweep, and the
// directories `-a` lets this run reach get them planned, linked from the store or copied.
function planSourceBodies(run: InstallRun, source: SelectedSource, symlink: SymlinkSupport): void {
  const { ctx, io } = run.input;
  const { work, selection } = source;
  for (const dir of source.dirs) {
    const wanted = run.bodiesWanted.get(dir.id) ?? { ...dir, wanted: new Set<string>() };
    run.bodiesWanted.set(dir.id, wanted);
    for (const selected of selection.selected) wanted.wanted.add(selected.localName);
  }
  run.builder.add("store", work.storeChanges, work.key);
  for (const dir of bodiesDirsFor(work, ctx, io, run.agents)) {
    const bodies = planBodies({
      dir: dir.dir,
      root: dir.root,
      store: ctx.paths.store,
      files: selection.selected.map((selected) => ({
        localName: selected.localName,
        storeFile: join(work.storeEntry, ...selected.memory.relPath.split("/")),
        text: selected.memory.text,
      })),
      copy: work.intent.copy,
      symlink,
      replaceCopies: !run.hookRun,
      knownCopies: run.knownCopies,
    });
    run.builder.add("destination", bodies.changes, work.key);
    for (const line of bodies.notices) run.notices.notice(`maxims: ${line}`);
  }
}

// The admitted lines carry a placeholder detail path; each target file gets its own.
function linesWithDetail(
  lines: readonly RuleLine[],
  byLocalName: ReadonlyMap<MemoryName, SelectedMemory>,
  detail: DetailPath,
): RuleLine[] {
  return lines.map((line) => {
    const selected = byLocalName.get(line.name);
    return selected === undefined
      ? line
      : { ...line, detailPath: detail(selected.memory, line.name) };
  });
}

// The source's `-o` file, the one another source already rendered into where there is one.
function outRequest(
  run: InstallRun,
  source: SelectedSource,
  outDir: string,
  linesFor: (detail: DetailPath) => RuleLine[],
): FileRequest {
  const { work, slug } = source;
  const path = assertInsideRoot(outDir, outRuleFile(outDir, slug));
  const found = run.files.get(path);
  if (found !== undefined && found.kind !== "out") {
    throw new LinkedAtRuleFile([work.key], found.path, path);
  }
  return {
    file: found ?? { kind: "out", path, blocks: [] },
    lines: linesFor((_memory, local) => outDetailPath(local)),
  };
}

// The file is registered under the key its kind is looked up by and planned under its real path;
// the block carries what the render says about its source.
function addBlock(run: InstallRun, work: SourceWork, request: FileRequest): void {
  const { file } = request;
  run.planned.add(fileIdentity(file));
  const fileKey = file.kind === "out" ? file.path : (file.targets[0]?.realKey ?? file.path);
  run.files.set(fileKey, file);
  file.blocks.push({
    key: work.key,
    sha: work.sha,
    lines: request.lines,
    stale: work.stale,
    refreshed: run.input.refreshed.fetchedKeys.includes(work.key),
    paths: work.intent.paths,
  });
}

// The source's rule lines into every file it reaches: its `-o` file, or one request per distinct
// harness file. Every request is built before any is registered.
function planSourceBlocks(run: InstallRun, source: SelectedSource, admission: Admitted): void {
  const { ctx } = run.input;
  const { work, slug, targets } = source;
  const byLocalName = new Map(
    source.selection.selected.map((selected) => [selected.localName, selected]),
  );
  const linesFor = (detail: DetailPath): RuleLine[] =>
    linesWithDetail(admission.lines, byLocalName, detail);
  const requests: FileRequest[] = [];
  if (work.intent.destination.scope === "out") {
    requests.push(outRequest(run, source, work.intent.destination.path, linesFor));
  }
  for (const group of Map.groupBy(targets, (target) => target.realKey).values()) {
    const [first] = group;
    if (first === undefined) continue;
    requests.push({
      file: harnessFile(run.files, group, first, slug, work.key),
      lines: linesFor(detailPathFor(work, group, ctx)),
    });
    if (work.intent.paths !== undefined && !supportsPathScoping(first)) {
      run.notices.notice(
        `maxims: ${work.key}: ${first.def.displayName} has no path scoping; --paths ignored there`,
      );
    }
  }
  for (const request of requests) addBlock(run, work, request);
}

function planSource(
  run: InstallRun,
  work: SourceWork,
  index: NameIndex,
  symlink: SymlinkSupport,
): void {
  const { ctx, io } = run.input;
  const { intent, key } = work;
  const selection = selectSource(run, work);
  const slug = sourceSlug(intent.from);
  const source: SelectedSource = {
    work,
    slug,
    selection,
    targets: resolveSourceTargets(run, work, slug),
    dirs: bodiesDirsFor(work, ctx, io, undefined),
  };
  run.dirsByKey.set(
    key,
    source.dirs.map((dir) => dir.id),
  );
  const admission = resolveSourceCandidates({
    source: key,
    memories: selection.selected.map((selected) => selected.candidate),
    select: intent.select,
    rename: intent.rename,
    index,
    cap: intent.rule ? ctx.ruleCap : Number.MAX_SAFE_INTEGER,
  });
  if (!admission.ok) {
    refuseSource(run, source, admission);
    return;
  }

  planSourceBodies(run, source, symlink);
  if (!intent.rule) return;

  planSourceBlocks(run, source, admission);
}

// An unreadable source keeps its files: its rule files stay off the sweep's list, its rules-dir
// files and `-o` file are owned whole, and the bodies directories it writes to are left alone. Its
// harnesses are resolved like a readable source's, so one whose config folder is absent stays
// unreachable for the hook planner too.
function keepUnreadableSource(run: InstallRun, source: UnreadableSource): void {
  const { ctx, io } = run.input;
  const { key, entry } = source;
  const { intent } = entry;
  for (const dir of bodiesDirsFor(entry, ctx, io, undefined)) run.unsweepable.add(dir.id);
  const slug = sourceSlug(intent.from);
  if (intent.destination.scope === "out") {
    if (!intent.rule) return;
    run.retain({
      key,
      kind: "out",
      realKey: realKeyOf(outRuleFile(intent.destination.path, slug)),
    });
    return;
  }

  const scope = intent.destination.scope;
  const resolved = resolveTargets({
    intent,
    scope,
    sourceSlug: slug,
    ctx,
    harnesses: io.harnesses,
    agents: undefined,
    explicit: run.explicit,
  });
  for (const skipped of resolved.skipped) {
    if (skipped.kind === "unreachable") run.unreachable.add(`${skipped.id}@${scope}`);
  }
  if (!intent.rule) return;

  for (const target of resolved.targets) run.retain({ key, kind: "harness", target });
}

// A destination that project cannot resolve (a config folder that is a symlink out of the
// checkout, a root without search permission) is that project's failure, not this run's, and
// costs the entry that one harness's targets only.
function targetsOfProject(
  intent: SourceIntent,
  id: HarnessId,
  there: EngineContext,
  io: EngineIo,
): HarnessTarget[] {
  try {
    return resolveTargets({
      intent,
      scope: "project",
      sourceSlug: sourceSlug(intent.from),
      ctx: there,
      harnesses: io.harnesses,
      agents: [id],
      explicit: [],
    }).targets;
  } catch (error) {
    if (!destinationUnresolvable(error)) throw error;
    return [];
  }
}

// Where another project's root has files this run reaches (a project rooted at the home
// directory writes the global rules directory), they are kept as an unreadable source's are.
// Where that project's sessions run is not known here, so its per-directory config layers are
// its root's alone.
function keepOtherProjectsFiles(run: InstallRun): void {
  const { ctx, io, refreshed } = run.input;
  for (const [key, entry] of Object.entries(refreshed.sources)) {
    const { intent } = entry;
    if (actsHere(entry, ctx) || intent.destination.scope !== "project" || !intent.rule) continue;
    const root = intent.destination.root;
    const there: EngineContext = { ...ctx, projectRoot: root, cwd: root };
    for (const id of intent.harnesses) {
      for (const target of targetsOfProject(intent, id, there, io)) {
        run.retain({ key, kind: "harness", target });
      }
    }
  }
}

// A retained harness file some source or the orphan visit renders counts the kept target among
// its readers, its block kept. Every file this run visits is registered by now, the orphan visit
// included; a file no source renders and no orphan strip reaches is not visited, and its blocks
// stay as they are.
function countRetainedReaders(run: InstallRun): void {
  for (const kept of run.retained) {
    switch (kept.kind) {
      case "out":
        break;
      case "harness": {
        const rendered = run.files.get(kept.target.realKey);
        if (rendered?.kind !== "harness") break;
        run.keepBlock(kept.key, kept.target.realKey);
        addReaders(rendered, [kept.target], kept.key);
        break;
      }
      default:
        throw unhandledRetained(kept);
    }
  }
}

// The real paths of the rule files this run writes or deletes: a link at one of them is replaced.
// A hook run defers its deletions, so a delete counts only on an interactive run.
function writtenRuleFiles(plans: readonly RuleFilePlan[], hookRun: boolean): Set<string> {
  const written = new Set<string>();
  for (const plan of plans) {
    for (const change of plan.writes) written.add(realKeyOf(change.path));
    for (const change of plan.removals) {
      if (!hookRun && change.kind === "delete") written.add(realKeyOf(change.path));
    }
  }
  return written;
}

// A file's notices may name a machine-wide fact (a config a tier probe could not read), so a
// line two files earn is said once.
function addRenderedPlans(run: InstallRun, plans: readonly RuleFilePlan[]): void {
  const said = new Set<string>();
  for (const plan of plans) {
    run.builder.add("destination", plan.writes);
    run.builder.add("removal", plan.removals);
    for (const line of plan.notices) {
      if (said.has(line)) continue;
      said.add(line);
      run.notices.notice(line);
    }
    for (const token of plan.tokens) {
      run.tokens += token.tokens;
      run.notices.notice(`~${token.tokens} tokens in ${token.path}`);
    }
  }
}

// The source's planned changes are taken back and its blocks leave every file, kept where the
// file already carries one; its bodies directories go unswept, since the names it installed
// before are not known this run.
function withdrawSource(run: InstallRun, key: string): void {
  run.builder.drop(key);
  for (const dir of run.dirsByKey.get(key) ?? []) run.unsweepable.add(dir);
  for (const each of run.files.values()) {
    for (const block of each.blocks) {
      if (block.key === key) run.keepBlock(key, fileIdentity(each));
    }
    each.blocks = each.blocks.filter((block) => block.key !== key);
  }
}

// The source held for a file over its byte budget: the one installed last among those whose
// block this run changes in the file, else among all its sources, since a block already on disk
// as drawn cannot make it fit. The lines go out loud: a hook session must hear that rules it
// expects are not loaded.
async function refuseOverBudget(
  run: InstallRun,
  file: RuleFile,
  error: BudgetExceeded,
): Promise<void> {
  const changingKeys = await changingBlocks(file);
  const changing = file.blocks.filter((block) => changingKeys.includes(block.key));
  const candidates = changing.length > 0 ? changing : file.blocks;
  const newest = newestBlock(candidates, run.input.refreshed.sources);
  if (newest === undefined) throw error;

  const { key } = newest;
  const message = `${key} is ${error.size - error.budget} bytes over the budget for ${error.path}`;
  const hint = `${error.hint}, or keep ${key} off ${error.displayName} with maxims unlink ${key} -a ${error.harnessId}`;
  const said = new Notices();
  said.loud(message);
  said.loud(hint);
  run.refuse(key, said, { code: error.code, message, hint });
  withdrawSource(run, key);
}

// A byte budget is only known once a file is rendered, so over it one source is held: refused
// whole, as the rule cap refuses, while its last-good block stays where the file already carries
// one. The file keeps every reader and is judged on the finished text until it fits or no source
// contributes to it. Returns the real paths of the rule files this run writes or deletes.
async function renderWithinBudgets(run: InstallRun): Promise<Set<string>> {
  for (;;) {
    const rendered = await renderFiles(run.files, run.keepAt);
    if (rendered.ok) {
      addRenderedPlans(run, rendered.plans);
      for (const hold of rendered.held) run.takeHold(hold);
      return writtenRuleFiles(rendered.plans, run.hookRun);
    }

    await refuseOverBudget(run, rendered.file, rendered.error);
  }
}

// A link no change of this run replaces stays, its block loaded, and is held like a file.
function holdUnreplacedLinks(run: InstallRun, written: ReadonlySet<string>): void {
  for (const { hold, owner } of run.linkedHolds) {
    if (!written.has(realKeyOf(hold.path))) run.takeHold(hold, owner);
  }
}

// What the admitted sources publish: a source's lines are counted once, however many files
// carry them, so the count reads as memories with a rule line, not as files times memories.
function publishedRules(files: ReadonlyMap<string, RuleFile>): number {
  const linesByKey = new Map<string, number>();
  for (const file of files.values()) {
    for (const block of file.blocks) linesByKey.set(block.key, block.lines.length);
  }
  return [...linesByKey.values()].reduce((sum, count) => sum + count, 0);
}

function sweepRulesDirs(run: InstallRun): void {
  const { ctx, io } = run.input;
  run.builder.add(
    "removal",
    planRulesDirSweep({
      ctx,
      harnesses: io.harnesses,
      agents: run.agents,
      scopes: run.scopes,
      planned: run.planned,
      warn: (line) => run.warn(line),
      hold: (held) => run.takeHold(held),
    }),
  );
}

// Every bodies directory this run can reach is swept of what no source wants there, except one
// an unreadable or refused source writes to.
function sweepBodies(run: InstallRun): void {
  const { ctx, io, extras } = run.input;
  const store = resolve(ctx.paths.store);
  const warn = (line: string): void => run.warn(line);
  for (const dir of allBodiesDirs(ctx, io, extras.removed, warn)) {
    run.bodiesWanted.set(dir.id, run.bodiesWanted.get(dir.id) ?? { ...dir, wanted: new Set() });
  }
  for (const [id, { dir, root, wanted }] of run.bodiesWanted) {
    if (run.unsweepable.has(id)) continue;
    const sweep = planBodySweep({ dir, root, store, wanted, knownCopies: run.knownCopies, warn });
    run.builder.add("removal", sweep);
  }
}

// Rule-file intent follows every entry in state, readable or not: a source whose files cannot be
// read this run still wants its switched-off `-o` file gone, as a removed source's goes.
function sweepOutRuleFiles(run: InstallRun): void {
  const outRulesOff = run.entries.filter((entry) => !entry.intent.rule);
  const removed = [...run.input.extras.removed, ...outRulesOff];
  run.builder.add(
    "removal",
    removedOutRuleFiles(removed, run.planned, (held) => run.takeHold(held)),
  );
}

function harnessWants(run: InstallRun, id: HarnessId, scope: Scope): HarnessWants {
  const { state, ctx } = run.input;
  const at = run.entries.filter(
    (entry) => entry.intent.destination.scope === scope && entry.intent.harnesses.includes(id),
  );
  return {
    hook: hookedAt(state, scope, ctx.projectRoot).includes(id) && at.length > 0,
    rules: at.some((entry) => entry.intent.rule),
    unreachable: run.unreachable.has(`${id}@${scope}`),
  };
}

// The roots of the other projects whose entries want the harness's hook.
function hookedElsewhere(run: InstallRun, id: HarnessId): string[] {
  const roots = new Set<string>();
  for (const entry of run.elsewhere) {
    const { destination, harnesses } = entry.intent;
    if (destination.scope !== "project" || !harnesses.includes(id)) continue;
    if (hookedAt(run.input.state, "project", destination.root).includes(id)) {
      roots.add(destination.root);
    }
  }
  return [...roots];
}

// Hook intent follows every entry in state, readable or not: a source whose files cannot be read
// this run still wants its hook kept. A registry this run could not read or edit is a write
// failure said loud, never a reason to stop the other harnesses.
async function planHookChanges(run: InstallRun, judgeLink: LinkJudge): Promise<void> {
  const { ctx, io } = run.input;
  const hooks = await planHooks({
    ctx,
    harnesses: io.harnesses,
    agents: run.agents,
    judgeLink,
    wants: (id, scope) => harnessWants(run, id, scope),
    elsewhere: (id) => hookedElsewhere(run, id),
  });
  run.builder.add("hook", hooks.changes);
  run.builder.add("removal", hooks.removals);
  for (const line of hooks.notices) run.notices.notice(`maxims: ${line}`);
  for (const failure of hooks.failures) {
    run.notices.loud(`maxims: ${failure.message}`);
    run.failures.push({ code: ExitCode.DestinationWriteFailed, ...failure });
  }
}

// The store keeps one entry per source in state. A held revision lands beside the store, and
// stays only while its entry still holds it: an accepted or removed source's revision is swept
// like an orphaned store entry.
function sweepStoreAndPending(run: InstallRun): void {
  const { ctx, refreshed } = run.input;
  const warn = (line: string): void => run.warn(line);
  const sources = Object.values(refreshed.sources);
  const expected = new Set(sources.map((entry) => storePathFor(ctx.home, entry.intent.from)));
  run.builder.add("orphan", planOrphanSweep(ctx.paths.store, expected, warn));
  for (const changes of refreshed.pendingChanges.values()) run.builder.add("store", changes);
  const heldExpected = new Set<string>();
  for (const entry of sources) {
    if ("pending" in entry && entry.pending !== undefined) {
      heldExpected.add(pendingPathFor(ctx.home, entry.intent.from));
    }
  }
  run.builder.add("orphan", planOrphanSweep(homePaths(ctx.home).pending, heldExpected, warn));
}

// The state write is planned when the state this run ends with differs from the one the caller
// read, whether the caller or the fetch step changed it.
function planStateWrite(run: InstallRun): State {
  const { state, ctx, extras, refreshed } = run.input;
  run.builder.add("state", extras.extraChanges);
  const nextState: State = { ...state, sources: refreshed.sources };
  if (serializeState(nextState) !== serializeState(extras.previousState)) {
    run.builder.add("state", [
      {
        kind: "write",
        path: assertInsideRoot(ctx.home, ctx.paths.state),
        content: serializeState({ ...nextState, writtenBy: WRITTEN_BY }),
        mode: 0o600,
      },
    ]);
  }
  return nextState;
}

export async function planInstall(input: InstallInput): Promise<Attempt> {
  const { ctx, io, refreshed } = input;
  const notices = new Notices();
  const awaitingReview = heldRevisions(refreshed, ctx, notices);
  const read = await readTrees(refreshed, input.held, input.overlay, ctx, notices);
  const run = new InstallRun(input, notices, read);

  const index = await indexNames(run);
  const symlink = await io.symlinkSupport();
  for (const work of run.works) planSource(run, work, index, symlink);
  for (const source of run.unreadable) keepUnreadableSource(run, source);
  keepOtherProjectsFiles(run);

  addSharedFilesWithOrphans(run.files, run.scopes, ctx, io, run.agents);
  countRetainedReaders(run);
  const judgeLink = linkJudge(run.files, run.retained);
  refuseLinksThroughRuleFiles(run.files, judgeLink);
  const written = await renderWithinBudgets(run);
  holdUnreplacedLinks(run, written);
  const rules = publishedRules(run.files);

  sweepRulesDirs(run);
  sweepBodies(run);
  sweepOutRuleFiles(run);
  await planHookChanges(run, judgeLink);
  sweepStoreAndPending(run);
  const nextState = planStateWrite(run);

  return {
    builder: run.builder,
    notices,
    failures: [...new Set(run.failures)],
    refusals: run.refusals,
    refusedFresh: run.refusedFresh,
    refusedKept: run.refusedKept,
    failed: read.failed,
    awaitingReview,
    heldFiles: run.heldFiles,
    stale: run.stale,
    hookRun: run.hookRun,
    sources: run.works.length,
    memories: run.memories,
    rules,
    tokens: run.tokens,
    nextState,
  };
}
