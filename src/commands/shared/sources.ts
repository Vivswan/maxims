import { statSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import {
  type HarnessContext,
  type HarnessDefinition,
  type HarnessId,
  type Scope,
  scopeRoot,
  sharedBlockFile,
} from "../../harnesses/contract.ts";
import { type ContentHash, type MemoryName, parseMemoryName } from "../../memory/contract.ts";
import {
  buildNameIndex,
  type IndexedSource,
  resolveSourceCandidates,
} from "../../rulefile/dedupe.ts";
import { type MemoryTree, readMemoryTree, type TreeScope } from "../../sources/tree.ts";
import {
  canonicalSourceKey,
  type Destination,
  parseSourceArgument,
  type RenameMap,
  type Select,
  type SourceEntry,
  type SourceFrom,
  type SourceIntent,
  type State,
} from "../../state/schema.ts";
import { ExitCode, MaximsError } from "../../util/exit-codes.ts";
import { storePathFor } from "../../util/home.ts";
import type { CliIo } from "../types.ts";
import { actsHere } from "./context.ts";
import { realpathOfExistingPrefix } from "./fs-probe.ts";
import { validateMemoryFiles } from "./memories.ts";

export function harnessContext(io: CliIo): HarnessContext {
  return { home: io.userHome, projectRoot: io.projectRoot, env: io.env };
}

// The scope a destination's harness files belong to: an `-o` folder is written like a project
// target (a rules file the harness does not own), so its harness checks read the project shape.
export function scopeOf(destination: Destination): Scope {
  return destination.scope === "global" ? "global" : "project";
}

export function harnessById(io: CliIo, id: HarnessId): HarnessDefinition {
  const def = io.harnesses.find((candidate) => candidate.id === id);
  if (def === undefined) {
    throw new MaximsError(ExitCode.Usage, `no harness definition for ${id}`, {
      hint: `known: ${io.harnesses.map((candidate) => candidate.id).join(", ")}`,
    });
  }
  return def;
}

export function detectedHarnesses(io: CliIo): HarnessId[] {
  const ctx = harnessContext(io);
  return io.harnesses.filter((def) => def.detect(ctx)).map((def) => def.id);
}

// Where a harness reads this source's rules at this destination, for the plan screen and for
// `doctor`; null when the harness has no target at that scope. A shared-block file follows the
// harness's precedence list, so the path is the file the harness will read, not the default.
export function targetPath(
  def: HarnessDefinition,
  destination: Destination,
  ctx: HarnessContext,
  sourceSlug: string,
): string | null {
  if (destination.scope === "out") return destination.path;
  const target = def.targets[destination.scope];
  if (target === null) return null;
  const root = scopeRoot(def, destination.scope, ctx);
  if (target.kind === "shared-block") return join(root, sharedBlockFile(target, root));
  return join(root, target.dir, target.fileName(sourceSlug));
}

// The memory names a recorded source currently offers: the fetch record for a fetched source, its
// own directory for a live one, walked and read with the same contract and internal-memory rule
// the fetch applies, so a name `add` would hide is not a name the index can collide on.
export async function upstreamNames(
  entry: SourceEntry,
  io: Pick<CliIo, "home" | "env">,
): Promise<MemoryName[]> {
  if ("fetched" in entry && entry.fetched !== undefined) {
    return Object.keys(entry.fetched.memories).flatMap((name) => {
      const parsed = parseMemoryName(name);
      return parsed === null ? [] : [parsed];
    });
  }
  const { from } = entry.intent;
  const root =
    from.type === "local" && from.live === true ? from.path : storePathFor(io.home, from);
  const tree = await storeTree(root, entry.intent);
  if (tree === null) return [];
  const named = new Set<string>(entry.intent.select === "*" ? [] : entry.intent.select);
  const installInternal = io.env.MAXIMS_INSTALL_INTERNAL === "1";
  return validateMemoryFiles(tree.files).memories.flatMap(({ memory }) => {
    if (memory.metadata.internal === true && !installInternal && !named.has(memory.name)) return [];
    return [memory.name];
  });
}

// The files under a store entry as the fetch would have laid them out, walked from the source
// root under `--full-depth` and from the memory folder otherwise; null only when the folder to
// walk is not there. A folder that is there but cannot be looked at fails as itself, never as an
// empty store.
export async function storeTree(root: string, scope: TreeScope): Promise<MemoryTree | null> {
  const scanned = scope.fullDepth ? root : join(root, scope.memoryPath);
  if (statSync(scanned, { throwIfNoEntry: false }) === undefined) return null;
  return readMemoryTree(root, scope, () => undefined);
}

export function localName(entry: SourceEntry, name: MemoryName): MemoryName {
  const rename = entry.intent.rename;
  return Object.hasOwn(rename, name) ? rename[name] : name;
}

export async function effectiveNames(
  entry: SourceEntry,
  io: Pick<CliIo, "home" | "env">,
): Promise<MemoryName[]> {
  const select = entry.intent.select;
  return (await upstreamNames(entry, io))
    .filter((name) => select === "*" || select.includes(name))
    .map((name) => localName(entry, name));
}

// The entries a verb judges names against: the user's, and this project's. Another project's
// entries are neither written from here nor allowed to claim a name here.
export function sourcesHere(state: State, io: Pick<CliIo, "projectRoot">): [string, SourceEntry][] {
  return Object.entries(state.sources).filter(([, entry]) => actsHere(entry, io));
}

export async function installedSources(
  state: State,
  io: Pick<CliIo, "home" | "env" | "projectRoot">,
): Promise<IndexedSource[]> {
  return Promise.all(
    sourcesHere(state, io).map(async ([key, entry]) => ({
      key,
      addedAt: entry.addedAt,
      intent: { select: entry.intent.select, rename: entry.intent.rename },
      names: await upstreamNames(entry, io),
    })),
  );
}

export type IncomingMemory = {
  name: MemoryName;
  description: string;
  contentHash: ContentHash;
};

export type ResolveIncomingInput = {
  source: string;
  memories: readonly IncomingMemory[];
  select: Select;
  rename: RenameMap;
  rule: boolean;
  cap: number;
  installed: readonly IndexedSource[];
};

export type ResolveIncomingOutcome =
  | { ok: true; names: MemoryName[] }
  | { ok: false; code: ExitCode.NameCollision; collisions: { name: MemoryName; ownedBy: string }[] }
  | { ok: false; code: ExitCode.RuleCapExceeded; count: number; cap: number; hint: string };

// The dedupe walk and the cap check a source about to be recorded is judged by, the same ones
// every sync runs: what is installed owns its names in installation order, the incoming memories
// take theirs through the rename map, and the survivors are counted against the cap. The cap
// counts rule lines, so a source that publishes none is not measured against it, as the planner
// measures it. The detail path is a rendering concern the walk carries through untouched, so it
// is blank here.
export function resolveIncoming(input: ResolveIncomingInput): ResolveIncomingOutcome {
  const resolution = resolveSourceCandidates({
    source: input.source,
    memories: input.memories.map((memory) => ({ ...memory, detailPath: "" })),
    select: input.select,
    rename: input.rename,
    index: buildNameIndex(input.installed),
    cap: input.rule ? input.cap : Number.MAX_SAFE_INTEGER,
  });
  if (resolution.ok) return { ok: true, names: resolution.lines.map((line) => line.name) };
  if (resolution.code === ExitCode.NameCollision) {
    return { ok: false, code: resolution.code, collisions: resolution.collisions };
  }
  const { code, count, cap, hint } = resolution;
  return { ok: false, code, count, cap, hint };
}

// A source argument on `remove`, `update`, `link` and `unlink` is either a recorded key as
// `list` prints it (`@owner/repo#v1` included) or a source spelling that parses to one.
// A local source's identity is its real path, at every door: `add` records it that way, so a
// lookup typed through a symlink must resolve the same way to find it.
export function realLocal<F extends SourceFrom>(from: F): F {
  if (from.type !== "local") return from;
  return { ...from, path: realpathOfExistingPrefix(from.path) };
}

export type SourceLookup =
  | { kind: "here"; key: string }
  | { kind: "elsewhere"; key: string; root: string }
  | { kind: "absent" };

// A source recorded for another project is not "installed" to a verb running here: its files
// live under a root this run never writes, so every verb that would edit it says where to run.
export function lookupSource(state: State, arg: string, io: CliIo): SourceLookup {
  const direct = findSourceKey(state, arg);
  const key =
    direct ??
    findSourceKey(
      state,
      canonicalSourceKey(realLocal(parseSourceArgument(arg, io.cwd, { ghHost: io.env.GH_HOST }))),
    );
  const entry = key === null ? undefined : state.sources[key];
  if (key === null || entry === undefined) return { kind: "absent" };
  const { destination } = entry.intent;
  if (destination.scope === "project" && destination.root !== io.projectRoot) {
    return { kind: "elsewhere", key, root: destination.root };
  }
  return { kind: "here", key };
}

export function findInstalledSource(state: State, arg: string, io: CliIo): string {
  const found = lookupSource(state, arg, io);
  if (found.kind === "here") return found.key;
  if (found.kind === "absent") throw new MaximsError(ExitCode.Usage, `${arg} is not installed`);
  throw installedElsewhere(found.key, found.root);
}

export function installedElsewhere(key: string, root: string): MaximsError {
  return new MaximsError(
    ExitCode.Usage,
    `${key} is installed ${describeScope({ scope: "project", root })}`,
    {
      hint: "run the command from that project",
    },
  );
}

// A re-add at another scope would move the source: its files at the recorded scope would leave
// with nothing said about them. The refusal names where it is and the one order that moves it.
export function installedAtOtherScope(
  key: string,
  recorded: Destination,
  wanted: Destination,
): MaximsError {
  const flag =
    wanted.scope === "global" ? "-g" : wanted.scope === "project" ? "-p" : `-o ${wanted.path}`;
  return new MaximsError(ExitCode.Usage, `${key} is installed ${describeScope(recorded)}`, {
    hint: `run maxims remove ${key} first, then add it with ${flag}`,
  });
}

function describeScope(destination: Destination): string {
  switch (destination.scope) {
    case "global":
      return "at the user scope";
    case "project":
      return `for the project at ${destination.root}`;
    case "out":
      return `into ${destination.path}`;
  }
}

// GitHub names are case-insensitive, so `@vivswan/skills` finds the entry recorded as
// `@Vivswan/skills`; every other key matches as typed.
export function findSourceKey(state: State, key: string): string | null {
  if (Object.hasOwn(state.sources, key)) return key;
  const folded = foldGithubKey(key);
  for (const [candidate, entry] of Object.entries(state.sources)) {
    if (entry.intent.from.type === "github" && foldGithubKey(candidate) === folded)
      return candidate;
  }
  return null;
}

// Only the repository coordinate folds; a `#ref` pin is a git ref and `V1` and `v1` name
// different sources.
export function foldGithubKey(key: string): string {
  const pin = key.indexOf("#");
  if (pin === -1) return key.toLowerCase();
  return `${key.slice(0, pin).toLowerCase()}${key.slice(pin)}`;
}

// The identity two records share when they name one source: a GitHub key folds as above, while a
// local path and a git URL are the keys they are (`Rules.git` and `rules.git` are two repositories).
export function sourceIdentity(from: SourceFrom): string {
  const key = canonicalSourceKey(from);
  return from.type === "github" ? foldGithubKey(key) : key;
}

export type ResolvedMemory = { key: string; name: MemoryName };

// A bare name is looked up across every source's effective set; two owners make it ambiguous and
// the qualified `@owner/repo/name` forms are the way out. A qualified name looks up one source.
export async function resolveMemoryName(
  state: State,
  io: Pick<CliIo, "home" | "env" | "projectRoot">,
  raw: string,
): Promise<ResolvedMemory> {
  const qualified = /^(@.+)\/([a-z0-9-]+)$/.exec(raw);
  if (qualified !== null && qualified[1] !== undefined && qualified[2] !== undefined) {
    const key = findSourceKey(state, qualified[1]);
    const name = parseMemoryName(qualified[2]);
    if (key === null) throw new MaximsError(ExitCode.Usage, `${qualified[1]} is not installed`);
    if (name === null)
      throw new MaximsError(ExitCode.Usage, `"${qualified[2]}" is not a memory name`);
    const entry = state.sources[key];
    if (entry === undefined || !actsHere(entry, io)) {
      throw new MaximsError(ExitCode.Usage, `${qualified[1]} is not installed`);
    }
    if (!(await effectiveNames(entry, io)).includes(name)) {
      throw new MaximsError(ExitCode.Usage, `${key} does not provide ${name}`);
    }
    return { key, name };
  }
  const name = parseMemoryName(raw);
  if (name === null)
    throw new MaximsError(ExitCode.Usage, `"${raw}" is not a kebab-case memory name`);
  const owners: string[] = [];
  for (const [key, entry] of sourcesHere(state, io)) {
    if ((await effectiveNames(entry, io)).includes(name)) owners.push(key);
  }
  if (owners.length === 0)
    throw new MaximsError(ExitCode.Usage, `no installed memory is named ${name}`);
  if (owners.length > 1) {
    throw new MaximsError(
      ExitCode.Usage,
      `${name} is provided by ${owners.length} sources; name one of ${owners.map((key) => `${key}/${name}`).join(", ")}`,
    );
  }
  const owner = owners[0];
  if (owner === undefined) throw new Error("unreachable: owners has one element");
  return { key: owner, name };
}

export function tildify(path: string, userHome: string): string {
  const rel = relative(userHome, path);
  if (rel === "") return "~";
  if (rel.startsWith("..") || resolve(userHome, rel) !== path) return path;
  return `~/${rel.split("\\").join("/")}`;
}

// Every intent field but `from`, which names the entry's variant and is never edited.
export type IntentFields = Omit<SourceIntent, "from">;

// An intent edit on any variant of a source entry: the fields are edited apart from `from`, then
// rejoined to the entry's own `from`; everything else the entry carries (its fetch record, a
// revision held for review) rides along untouched. The variant is narrowed first so the checker
// never pairs a live `from` with a fetch record.
export function withIntent(
  entry: SourceEntry,
  edit: (fields: IntentFields) => IntentFields,
): SourceEntry {
  const { from: _from, ...fields } = entry.intent;
  const edited = edit(fields);
  if (isLiveEntry(entry)) return { ...entry, intent: { ...edited, from: entry.intent.from } };
  if (isCopiedEntry(entry)) return { ...entry, intent: { ...edited, from: entry.intent.from } };
  return { ...entry, intent: { ...edited, from: entry.intent.from } };
}

// Sharing is set or cleared on a project-scope entry; the field is absent, never false, so a
// private entry reads as it did before sharing existed.
export function withShared(entry: SourceEntry, shared: boolean): SourceEntry {
  return withIntent(entry, ({ shared: _previous, ...rest }) =>
    shared ? { ...rest, shared: true } : rest,
  );
}

type LiveEntry = Extract<SourceEntry, { intent: { from: { live: true } } }>;
type CopiedEntry = Extract<SourceEntry, { intent: { from: { type: "local"; live?: false } } }>;

function isLiveEntry(entry: SourceEntry): entry is LiveEntry {
  return entry.intent.from.type === "local" && entry.intent.from.live === true;
}

function isCopiedEntry(entry: SourceEntry): entry is CopiedEntry {
  return entry.intent.from.type === "local" && entry.intent.from.live !== true;
}

export function knownHarnessIds(io: Pick<CliIo, "harnesses">): HarnessId[] {
  return io.harnesses.map((def) => def.id);
}
