import { type ContentHash, type MemoryName, parseMemoryName } from "../memory/contract.ts";
import {
  canonicalSourceKey,
  parseSourceArgument,
  type SourceEntry,
  type SourceIntent,
  type State,
} from "../state/schema.ts";
import { withStateLock } from "../state/store.ts";
import type { Change } from "../util/change.ts";
import { ExitCode, MaximsError } from "../util/exit-codes.ts";
import { storePathFor } from "../util/home.ts";
import { actsHere, type EngineContext, loadContext } from "./shared/context.ts";
import { isFetchedEntry, planSync, readInstalledTree, retainedNames } from "./shared/engine.ts";
import { isRemoteEntry } from "./shared/fetch.ts";
import type { SourceTree } from "./shared/memories.ts";
import { projectLockChange } from "./shared/project-lock-io.ts";
import {
  countOf,
  EMPTY_REPORT,
  emptyDocument,
  finishSync,
  previewState,
  reportedUnderJson,
  unusableStateLine,
} from "./shared/report.ts";
import { selectMemories } from "./shared/select.ts";
import type { EngineIo, RemoveOptions, RemoveTargetSpec, SyncReport } from "./types.ts";

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

async function runRemoveChecked(options: RemoveOptions, io: EngineIo): Promise<SyncReport> {
  const ctx = await loadContext(io, { readHookStdin: false });
  const say = (line: string): void => {
    if (!options.json && !options.quiet) io.stdout(`${line}\n`);
  };
  // A removal that finds nothing still answers `--json` with one document.
  const nothing = (lines: string[]): SyncReport => {
    for (const line of lines) say(line);
    if (options.json) io.stdout(emptyDocument(lines));
    return { ...EMPTY_REPORT, notices: lines };
  };
  const remove = async (state: State): Promise<SyncReport> => {
    const removal = await resolveRemoval(state, options, ctx, io);
    if (removal.labels.length === 0) {
      return nothing([...removal.notices, "No memories found to remove."]);
    }
    for (const line of removal.notices) say(line);
    say("Memories to remove:");
    for (const label of removal.labels) say(`  - ${label}`);
    if (!options.confirmed) {
      say("Removal cancelled");
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
    outcome.notices.notice(`Removed ${countOf(removal.labels.length, "memory", "memories")}`);
    return finishSync(outcome, ctx, io, { ...options, verb: "remove" });
  };
  // A dry run reads without the lock and settles nothing, like a listing.
  if (options.dryRun) {
    const preview = await previewState(ctx.home);
    if (preview.kind === "loaded") return remove(preview.state);
    if (preview.kind === "absent") return nothing(["No memories found to remove."]);
    throw new MaximsError(ExitCode.Usage, preview.line);
  }
  return withStateLock(ctx.home, "manual", async (lock) => {
    const loaded = await lock.read();
    if (loaded.kind === "absent") return nothing(["No memories found to remove."]);
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

// Each target edits the picture the next one is matched against, so two memories removed from
// one source both leave and a source removed twice is found once.
async function resolveRemoval(
  state: State,
  options: RemoveOptions,
  ctx: EngineContext,
  io: EngineIo,
): Promise<Removal> {
  const installInternal = ctx.env.MAXIMS_INSTALL_INTERNAL === "1";
  const installed = await readInstalled(state, ctx, io, installInternal);
  const sources = { ...state.sources };
  const labels: string[] = [];
  const notices: string[] = [];
  const removed: SourceEntry[] = [];
  const removedCopies = new Set<ContentHash>();
  const takeOut = (item: Installed): void => {
    const { key, entry } = item;
    if (options.agents !== undefined) {
      const dropped = entry.intent.harnesses.filter((id) => options.agents?.includes(id));
      if (dropped.length === 0) {
        notices.push(`${key} is not installed for ${options.agents.join(", ")}`);
        return;
      }
      for (const id of dropped) labels.push(`${key} from ${id}`);
      const remaining = entry.intent.harnesses.filter((id) => !dropped.includes(id));
      if (remaining.length > 0) {
        const next = withIntent(entry, { harnesses: remaining });
        sources[key] = next;
        item.entry = next;
        return;
      }
    }
    delete sources[key];
    removed.push(entry);
    installed.splice(installed.indexOf(item), 1);
    for (const memory of item.tree?.memories ?? []) removedCopies.add(memory.memory.contentHash);
    const fetched = isFetchedEntry(entry) ? entry.fetched : undefined;
    for (const facts of Object.values(fetched?.memories ?? {})) removedCopies.add(facts.content);
    if (options.agents === undefined) {
      if (item.pairs.length === 0) labels.push(key);
      for (const pair of item.pairs) labels.push(pair.localName);
    }
  };
  const taken: string[] = [];
  const targets: RemoveTargetSpec[] = options.all
    ? installed.map((item) => item.key)
    : options.targets;
  // A source recorded for another project is not this run's to remove: its files live under a
  // root this run never writes, so the removal is refused rather than half done.
  const elsewhere = Object.entries(state.sources).filter(([, entry]) => !actsHere(entry, ctx));
  for (const target of targets) {
    const named = typeof target === "string" ? target : target.source;
    const other = elsewhere.find(([key]) => sameSource(key, named, ctx));
    if (other !== undefined) {
      const { destination } = other[1].intent;
      const root = destination.scope === "project" ? destination.root : "";
      throw new MaximsError(ExitCode.Usage, `${other[0]} is installed for the project at ${root}`, {
        hint: `run maxims remove ${other[0]} from that project`,
      });
    }
    if (typeof target === "string") {
      const bySource = installed.find((item) => sameSource(item.key, target, ctx));
      if (bySource !== undefined) {
        taken.push(bySource.key);
        takeOut(bySource);
        continue;
      }
      if (taken.some((key) => sameSource(key, target, ctx))) continue;
    }
    const spelled = typeof target === "string" ? target : `${target.source}/${target.memory}`;
    const name = typeof target === "string" ? parseMemoryName(target) : target.memory;
    if (name === null) {
      throw new MaximsError(
        ExitCode.Usage,
        `${spelled} is neither an installed source nor a memory name`,
      );
    }
    if (options.agents !== undefined) {
      throw new MaximsError(ExitCode.Usage, `-a applies to a source, not to the memory ${name}`, {
        hint: "name the source to drop a harness from, or drop the name without -a",
      });
    }
    const candidates =
      typeof target === "string"
        ? installed
        : installed.filter((item) => sameSource(item.key, target.source, ctx));
    if (typeof target !== "string" && candidates.length === 0) {
      throw new MaximsError(ExitCode.Usage, `${target.source} is not installed`);
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
    const [owner] = owners;
    if (owner === undefined) {
      notices.push(`${spelled} is not installed`);
      continue;
    }
    // A single memory leaves by regenerating its source's block without it, which needs the
    // source's memories; a source that cannot be read here keeps its whole block, so the removal
    // is refused rather than recorded as done while the rule stays live.
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
      notices.push(`${owner.key} has no memories left after removing ${name}; removing the source`);
      takeOut(owner);
      continue;
    }
    sources[owner.key] = next.entry;
    owner.entry = next.entry;
    owner.pairs = owner.pairs.filter((pair) => pair.localName !== name);
    if (next.hash !== null) removedCopies.add(next.hash);
    labels.push(name);
  }
  const nextState: State = {
    ...state,
    sources,
    hooks: Object.keys(sources).length === 0 ? [] : state.hooks,
  };
  // Every edit above replaces the entry object, so the lock is rewritten exactly when a
  // project-scoped entry changed; a target that was only looked at leaves it alone.
  const projectTouched = Object.entries(state.sources).some(
    ([key, entry]) => entry.intent.destination.scope === "project" && sources[key] !== entry,
  );
  return { nextState, labels, notices, projectTouched, removed, removedCopies };
}

// The installed picture `remove` matches against: each source's memories from the store or its
// live directory, and when neither can be read, the local names its retained rules still hold
// (the recorded fetch through the selection and renames, and the retained blocks on disk), so a
// source whose files are gone is still found by the names it installed and told apart from a name
// nobody provides.
async function readInstalled(
  state: State,
  ctx: EngineContext,
  io: EngineIo,
  installInternal: boolean,
): Promise<Installed[]> {
  const installed: Installed[] = [];
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
        ? (await retainedNames(key, entry, ctx, io)).map((localName) => ({
            upstreamName: localName,
            localName,
            hash: null,
          }))
        : selectMemories({
            memories: tree.memories,
            intent: entry.intent,
            installInternal,
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

// A source argument matches its state key exactly, or, for a GitHub repository, whose names
// GitHub treats as one, case-insensitively on the `@owner/repo` part with the pin compared as
// typed, since a git ref is case-sensitive. A key spelled with its `#pin` is not a source
// argument the parser accepts, so it is compared as the key it is.
function sameSource(key: string, argument: string, ctx: EngineContext): boolean {
  if (key === argument) return true;
  let candidate: string;
  try {
    candidate = canonicalSourceKey(
      parseSourceArgument(argument, ctx.cwd, { ghHost: ctx.env.GH_HOST }),
    );
  } catch (error) {
    if (!(error instanceof MaximsError && error.code === ExitCode.Usage)) throw error;
    if (!argument.startsWith("@") || !argument.includes("#")) return false;
    candidate = argument;
  }
  if (candidate === key) return true;
  if (!candidate.startsWith("@")) return false;
  const [candidateRepo, ...candidatePin] = candidate.split("#");
  const [keyRepo, ...keyPin] = key.split("#");
  return (
    keyRepo?.toLowerCase() === candidateRepo?.toLowerCase() &&
    keyPin.join("#") === candidatePin.join("#")
  );
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
  return { entry: withIntent(entry, { select: remaining, rename }), hash: removedMemory.hash };
}

// The entry keeps its variant (remote, copied local or live) through the intent edit; a spread
// over the union would let the type checker pair a live `from` with a fetched record.
function withIntent(
  entry: SourceEntry,
  patch: Partial<Pick<SourceIntent, "select" | "rename" | "harnesses">>,
): SourceEntry {
  if (!isFetchedEntry(entry)) return { ...entry, intent: { ...entry.intent, ...patch } };
  if (isRemoteEntry(entry)) return { ...entry, intent: { ...entry.intent, ...patch } };
  return { ...entry, intent: { ...entry.intent, ...patch } };
}
