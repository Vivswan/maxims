import { agentsOnMemory, memories, notInstalled, STRINGS } from "../console/strings.ts";
import { actsHere, type EngineContext, loadContext } from "../engine/context.ts";
import { prunedHooks } from "../engine/hooks.ts";
import type { SourceTree } from "../engine/memories.ts";
import { planSync } from "../engine/plan-sync.ts";
import type { RuleFileHeld } from "../engine/rules.ts";
import { selectMemories } from "../engine/select.ts";
import { recordedCopies } from "../engine/sync-refresh.ts";
import { retainedNames } from "../engine/sync-retained.ts";
import { readInstalledTree } from "../engine/sync-trees.ts";
import type { EngineIo, RemoveOptions, RemoveTargetSpec, SyncReport } from "../engine/types.ts";
import { type ContentHash, type MemoryName, parseMemoryName } from "../memory/contract.ts";
import type { SourceEntry, State } from "../state/schema.ts";
import { withStateLock } from "../state/store.ts";
import type { Change } from "../util/change.ts";
import { ExitCode, MaximsError } from "../util/exit-codes.ts";
import { storePathFor } from "../util/home.ts";
import { installedSourceOrNull, withIntent } from "./frame/lookup.ts";
import { projectLockChange } from "./frame/project-lock-io.ts";
import {
  EMPTY_REPORT,
  emptyDocument,
  finishSync,
  previewState,
  reportedUnderJson,
  unusableStateLine,
} from "./frame/report.ts";

// Intent mutation, then the same convergence that installs: with the entry gone the regenerated
// output no longer carries its lines and its links have no owner. Deletions apply even under
// `--quiet`; only the sync verb defers them.
export async function runRemove(options: RemoveOptions, io: EngineIo): Promise<SyncReport> {
  try {
    return await runRemoveChecked(options, io);
  } catch (error) {
    throw reportedUnderJson(error, io, options.json);
  }
}

// The lines before the sync are the verb's own frame, in the shape the interactive console
// draws: a step glyph on a step, a warning glyph on a notice, a note body indented under it.
type Frame = {
  say: (line: string) => void;
  step: (line: string) => void;
  warn: (line: string) => void;
};

function frameFor(options: RemoveOptions, io: EngineIo): Frame {
  const say = (line: string): void => {
    if (!options.json && !options.quiet) io.stdout(`${line}\n`);
  };
  return { say, step: (line) => say(`o  ${line}`), warn: (line) => say(`!  ${line}`) };
}

// A removal that finds nothing still answers `--json` with one document.
function nothingToRemove(
  notices: string[],
  frame: Frame,
  options: RemoveOptions,
  io: EngineIo,
): SyncReport {
  for (const line of notices) frame.warn(line);
  frame.step("No memories found to remove.");
  const lines = [...notices, "No memories found to remove."];
  if (options.json) io.stdout(emptyDocument(lines));
  return { ...EMPTY_REPORT, notices: lines };
}

// A harness drop is reported by what left: each label names the source and the harness,
// whether or not the source itself went with its last harness.
function reportRemoved(labels: string[], options: RemoveOptions, frame: Frame): void {
  if (options.dryRun) return;
  if (options.agents === undefined) {
    frame.step(`Removed ${memories(labels.length)}`);
    return;
  }
  for (const label of labels) frame.step(`Removed ${label}`);
}

async function removeFrom(
  state: State,
  options: RemoveOptions,
  ctx: EngineContext,
  io: EngineIo,
  frame: Frame,
): Promise<SyncReport> {
  const removal = await resolveRemoval(state, options, ctx, io);
  if (removal.labels.length === 0) return nothingToRemove(removal.notices, frame, options, io);
  for (const line of removal.notices) frame.warn(line);
  frame.step("Memories to remove:");
  for (const label of removal.labels) frame.say(`   - ${label}`);
  if (!options.confirmed) {
    frame.step("Removal cancelled");
    throw new MaximsError(ExitCode.Usage, "Removal cancelled", { hint: "pass -y to confirm" });
  }
  const extraChanges: Change[] = [];
  if (removal.projectTouched && ctx.projectRoot !== null) {
    const lock = await projectLockChange(ctx.projectRoot, state, removal.nextState, ctx);
    if (lock !== null) extraChanges.push(lock);
  }
  const outcome = await planSync(
    removal.nextState,
    ctx,
    io,
    { ...options, agents: undefined, fetch: "none" },
    {
      verb: "remove",
      previousState: state,
      extraChanges,
      removed: removal.removed,
      removedCopies: removal.removedCopies,
    },
  );
  const report = await finishSync(outcome, ctx, io, { ...options, verb: "remove" });
  reportRemoved(removal.labels, options, frame);
  return report;
}

async function runRemoveChecked(options: RemoveOptions, io: EngineIo): Promise<SyncReport> {
  const ctx = await loadContext(io, { readHookStdin: false });
  const frame = frameFor(options, io);
  const remove = (state: State): Promise<SyncReport> => removeFrom(state, options, ctx, io, frame);
  const nothing = (): SyncReport => nothingToRemove([], frame, options, io);
  // A dry run reads without the lock and settles nothing, like a listing.
  if (options.dryRun) {
    const preview = await previewState(ctx.home);
    if (preview.kind === "loaded") return remove(preview.state);
    if (preview.kind === "absent") return nothing();
    throw new MaximsError(ExitCode.Usage, preview.line);
  }
  return withStateLock(ctx.home, "manual", async (lock) => {
    const loaded = await lock.read();
    if (loaded.kind === "absent") return nothing();
    if (loaded.kind !== "loaded") throw new MaximsError(ExitCode.Usage, unusableStateLine(loaded));
    return remove(loaded.state);
  });
}

type Removal = {
  nextState: State;
  labels: string[];
  notices: string[];
  projectTouched: boolean;
  removed: SourceEntry[];
  removedCopies: Set<ContentHash>;
};

// One installed memory as `remove` sees it: the upstream name the source ships and the local name
// it is installed under. From the tree when the source is readable, else from its recorded names.
type Pair = { upstreamName: MemoryName; localName: MemoryName; hash: ContentHash | null };

type Installed = { key: string; entry: SourceEntry; tree: SourceTree | null; pairs: Pair[] };

// The picture `remove` edits target by target: what is still installed, the sources that remain,
// the keys a target named as a whole source (so one named twice is matched once), and what left.
type Picture = {
  installed: Installed[];
  sources: State["sources"];
  taken: string[];
  labels: string[];
  notices: string[];
  removed: SourceEntry[];
  removedCopies: Set<ContentHash>;
};

// With `-a`, only the named harnesses leave the source. True when none remains, so the source
// itself is to leave; false when it stays, trimmed, or untouched with a notice.
function dropHarnesses(
  picture: Picture,
  item: Installed,
  agents: NonNullable<RemoveOptions["agents"]>,
): boolean {
  const { key, entry } = item;
  const dropped = entry.intent.harnesses.filter((id) => agents.includes(id));
  if (dropped.length === 0) {
    picture.notices.push(`${notInstalled(key)} for ${agents.join(", ")}`);
    return false;
  }
  for (const id of dropped) picture.labels.push(`${key} from ${id}`);
  const remaining = entry.intent.harnesses.filter((id) => !dropped.includes(id));
  if (remaining.length === 0) return true;
  const next = withIntent(entry, (fields) => ({ ...fields, harnesses: remaining }));
  picture.sources[key] = next;
  item.entry = next;
  return false;
}

// A source leaves whole with its installed copies; without `-a` a label per memory it installed
// (its key when it installed none).
function takeOutSource(picture: Picture, item: Installed, labelMemories: boolean): void {
  const { key, entry } = item;
  delete picture.sources[key];
  picture.removed.push(entry);
  picture.installed.splice(picture.installed.indexOf(item), 1);
  for (const memory of item.tree?.memories ?? []) {
    picture.removedCopies.add(memory.memory.contentHash);
  }
  for (const hash of recordedCopies([entry])) picture.removedCopies.add(hash);
  if (!labelMemories) return;
  if (item.pairs.length === 0) picture.labels.push(key);
  for (const pair of item.pairs) picture.labels.push(pair.localName);
}

function takeOut(picture: Picture, item: Installed, agents: RemoveOptions["agents"]): void {
  if (agents !== undefined && !dropHarnesses(picture, item, agents)) return;
  takeOutSource(picture, item, agents === undefined);
}

// The one source providing the name: among every installed source for a bare name, the named
// source for `source/memory`. Two providers are refused; none is null.
function memoryOwner(
  installed: Installed[],
  target: RemoveTargetSpec,
  key: string | null,
  name: MemoryName,
): Installed | null {
  const candidates =
    typeof target === "string" ? installed : installed.filter((item) => item.key === key);
  if (typeof target !== "string" && candidates.length === 0) {
    throw new MaximsError(ExitCode.Usage, notInstalled(target.source));
  }
  const owners = candidates.filter((item) => item.pairs.some((pair) => pair.localName === name));
  if (owners.length > 1) {
    const qualified = owners.map((item) => `${item.key}/${name}`).join(", ");
    throw new MaximsError(
      ExitCode.Usage,
      `${name} is provided by more than one source: ${qualified}`,
      { hint: "remove the whole source instead, or narrow it with maxims add --memory" },
    );
  }
  return owners[0] ?? null;
}

// A single memory leaves by regenerating its source's block without it, which needs the source's
// memories; a source that cannot be read here keeps its whole block, so the removal is refused
// rather than recorded as done while the rule stays live.
function removeMemory(
  picture: Picture,
  target: RemoveTargetSpec,
  key: string | null,
  agents: RemoveOptions["agents"],
): void {
  const spelled = typeof target === "string" ? target : `${target.source}/${target.memory}`;
  const name = typeof target === "string" ? parseMemoryName(target) : target.memory;
  if (name === null) {
    throw new MaximsError(
      ExitCode.Usage,
      `${spelled} is neither an installed source nor a memory name`,
    );
  }
  if (agents !== undefined) {
    throw new MaximsError(ExitCode.Usage, agentsOnMemory(name), {
      hint: STRINGS.agentsOnMemoryHint,
    });
  }
  const owner = memoryOwner(picture.installed, target, key, name);
  if (owner === null) {
    picture.notices.push(notInstalled(spelled));
    return;
  }
  if (owner.tree === null) {
    throw new MaximsError(
      ExitCode.SourceUnresolvable,
      `${owner.key} cannot be read here, so ${name} cannot be removed on its own`,
      {
        hint: `run maxims update to refetch it, or remove the whole source: maxims remove ${owner.key}`,
      },
    );
  }
  const next = withoutMemory(owner, name);
  if (next === null) {
    picture.notices.push(
      `${owner.key} has no memories left after removing ${name}; removing the source`,
    );
    takeOutSource(picture, owner, true);
    return;
  }
  picture.sources[owner.key] = next.entry;
  owner.entry = next.entry;
  owner.pairs = owner.pairs.filter((pair) => pair.localName !== name);
  if (next.hash !== null) picture.removedCopies.add(next.hash);
  picture.labels.push(name);
}

// A bare target that names an installed source edits that source; one that already left is
// skipped rather than looked up as a memory name. Anything else is a memory name.
function removeTarget(
  picture: Picture,
  target: RemoveTargetSpec,
  key: string | null,
  agents: RemoveOptions["agents"],
): void {
  if (typeof target === "string" && key !== null) {
    const bySource = picture.installed.find((item) => item.key === key);
    if (bySource !== undefined) {
      picture.taken.push(key);
      takeOut(picture, bySource, agents);
      return;
    }
    if (picture.taken.includes(key)) return;
  }
  removeMemory(picture, target, key, agents);
}

// Each target edits the picture the next one is matched against, so two memories removed from
// one source both leave and a source removed twice is found once.
async function resolveRemoval(
  state: State,
  options: RemoveOptions,
  ctx: EngineContext,
  io: EngineIo,
): Promise<Removal> {
  const picture: Picture = {
    installed: await readInstalled(state, ctx, io),
    sources: { ...state.sources },
    taken: [],
    labels: [],
    notices: [],
    removed: [],
    removedCopies: new Set<ContentHash>(),
  };
  const targets: RemoveTargetSpec[] = options.all
    ? picture.installed.map((item) => item.key)
    : options.targets;
  for (const target of targets) {
    // The lookup every verb resolves a source argument through; a source recorded for another
    // project is refused there, since its files live under a root this run never writes.
    const named = typeof target === "string" ? target : target.source;
    const key = installedSourceOrNull(state, named, ctx);
    removeTarget(picture, target, key, options.agents);
  }
  const nextState = prunedHooks({ ...state, sources: picture.sources });
  // Every edit above replaces the entry object, so the lock is rewritten exactly when a
  // project-scoped entry changed; a target that was only looked at leaves it alone.
  const projectTouched = Object.entries(state.sources).some(
    ([key, entry]) =>
      entry.intent.destination.scope === "project" && picture.sources[key] !== entry,
  );
  const { labels, notices, removed, removedCopies } = picture;
  return { nextState, labels, notices, projectTouched, removed, removedCopies };
}

// The installed picture `remove` matches against: each source's memories from the store or its
// live directory, and when neither can be read, the local names its retained rules still hold
// (the recorded fetch through the selection and renames, and the retained blocks on disk), so a
// source whose files are gone is still found by the names it installed and told apart from a name
// nobody provides. A retained block the grammar refuses may hold the name asked for: the removal
// is refused by that file before anything is recorded.
async function readInstalled(state: State, ctx: EngineContext, io: EngineIo): Promise<Installed[]> {
  const installed: Installed[] = [];
  const hold = (held: RuleFileHeld): never => {
    throw new MaximsError(ExitCode.DestinationWriteFailed, held.message, {
      ...(held.hint === undefined ? {} : { hint: held.hint }),
    });
  };
  for (const key of Object.keys(state.sources).sort()) {
    const entry = state.sources[key];
    if (entry === undefined || !actsHere(entry, ctx)) continue;
    const read = await readInstalledTree(
      entry,
      storePathFor(ctx.home, entry.intent.from),
      () => undefined,
    );
    const tree = read.kind === "tree" ? read.tree : null;
    const pairs =
      tree === null
        ? (await retainedNames({ key, entry, ctx, io, hold })).map((localName) => ({
            upstreamName: localName,
            localName,
            hash: null,
          }))
        : selectMemories({
            memories: tree.memories,
            intent: entry.intent,
            installInternal: ctx.installInternal,
            disabled: new Set(),
            detailPath: () => "",
          }).selected.map((selected) => ({
            upstreamName: selected.upstreamName,
            localName: selected.localName,
            hash: selected.memory.memory.contentHash,
          }));
    installed.push({ key, entry, tree, pairs });
  }
  return installed;
}

// A `*` selection becomes the explicit list of what remains, so a later refresh cannot bring
// the memory back; a rename mapping onto the removed name goes with it. The memory is found by
// the local name it is installed under, so a rename map upstream has since outgrown cannot point
// the removal at a name that is no longer there.
function withoutMemory(
  owner: Installed,
  local: MemoryName,
): { entry: SourceEntry; hash: ContentHash | null } | null {
  const { entry } = owner;
  const removedMemory = owner.pairs.find((pair) => pair.localName === local);
  if (removedMemory === undefined) return null;
  const upstream = removedMemory.upstreamName;
  const remaining = owner.pairs
    .map((pair) => pair.upstreamName)
    .filter((name) => name !== upstream);
  if (remaining.length === 0) return null;
  const rename = Object.fromEntries(
    Object.entries(entry.intent.rename).filter(([from, to]) => from !== upstream && to !== local),
  );
  return {
    entry: withIntent(entry, (fields) => ({ ...fields, select: remaining, rename })),
    hash: removedMemory.hash,
  };
}
