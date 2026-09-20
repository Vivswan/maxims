import { readFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import {
  type HarnessContext,
  type HarnessDefinition,
  type HarnessId,
  type Scope,
  scopeRoot,
  sharedBlockFile,
} from "../../harnesses/contract.ts";
import {
  type ContentHash,
  type MemoryName,
  parseMemory,
  parseMemoryName,
} from "../../memory/contract.ts";
import {
  buildNameIndex,
  type IndexedSource,
  resolveSourceCandidates,
} from "../../rulefile/dedupe.ts";
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
import { readDirIfPresent, realpathOfExistingPrefix } from "./fs-probe.ts";

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

// The memory names a recorded source currently offers: the fetch record for a fetched source, the
// store entry's tree for a live one, read with the same contract and internal-memory rule `add`
// applies, so a name `add` would hide is not a name the index can collide on.
export function upstreamNames(entry: SourceEntry, io: Pick<CliIo, "home" | "env">): MemoryName[] {
  if ("fetched" in entry && entry.fetched !== undefined) {
    return Object.keys(entry.fetched.memories).flatMap((name) => {
      const parsed = parseMemoryName(name);
      return parsed === null ? [] : [parsed];
    });
  }
  const dir = join(storePathFor(io.home, entry.intent.from), entry.intent.memoryPath);
  const named = new Set<string>(entry.intent.select === "*" ? [] : entry.intent.select);
  const installInternal = io.env.MAXIMS_INSTALL_INTERNAL === "1";
  return (markdownFiles(dir, entry.intent.fullDepth) ?? []).flatMap((file) => {
    const parsed = parseMemory(file, readFileSync(file, "utf8"));
    if (!parsed.ok) return [];
    const memory = parsed.memory;
    if (memory.metadata.internal === true && !installInternal && !named.has(memory.name)) return [];
    return [memory.name];
  });
}

// Null when the folder is absent; the caller decides what an absent folder means.
export function markdownFiles(dir: string, recursive: boolean): string[] | null {
  const entries = readDirIfPresent(dir);
  if (entries === null) return null;
  return entries
    .sort((a, b) => a.name.localeCompare(b.name))
    .flatMap((entry) => {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) return recursive ? (markdownFiles(path, recursive) ?? []) : [];
      return entry.isFile() && entry.name.endsWith(".md") ? [path] : [];
    });
}

export function localName(entry: SourceEntry, name: MemoryName): MemoryName {
  const rename = entry.intent.rename;
  return Object.hasOwn(rename, name) ? rename[name] : name;
}

export function effectiveNames(entry: SourceEntry, io: Pick<CliIo, "home" | "env">): MemoryName[] {
  const select = entry.intent.select;
  return upstreamNames(entry, io)
    .filter((name) => select === "*" || select.includes(name))
    .map((name) => localName(entry, name));
}

export function installedSources(state: State, io: Pick<CliIo, "home" | "env">): IndexedSource[] {
  return Object.entries(state.sources).map(([key, entry]) => ({
    key,
    addedAt: entry.addedAt,
    intent: { select: entry.intent.select, rename: entry.intent.rename },
    names: upstreamNames(entry, io),
  }));
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
  cap: number;
  installed: readonly IndexedSource[];
};

export type ResolveIncomingOutcome =
  | { ok: true; names: MemoryName[] }
  | { ok: false; code: ExitCode.NameCollision; collisions: { name: MemoryName; ownedBy: string }[] }
  | { ok: false; code: ExitCode.RuleCapExceeded; count: number; cap: number; hint: string };

// The dedupe walk and the cap check a source about to be recorded is judged by, the same ones
// every sync runs: what is installed owns its names in installation order, the incoming memories
// take theirs through the rename map, and the survivors are counted against the cap. The detail
// path is a rendering concern the walk carries through untouched, so it is blank here.
export function resolveIncoming(input: ResolveIncomingInput): ResolveIncomingOutcome {
  const resolution = resolveSourceCandidates({
    source: input.source,
    memories: input.memories.map((memory) => ({ ...memory, detailPath: "" })),
    select: input.select,
    rename: input.rename,
    index: buildNameIndex(input.installed),
    cap: input.cap,
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

export function findInstalledSource(state: State, arg: string, io: CliIo): string {
  const direct = findSourceKey(state, arg);
  if (direct !== null) return direct;
  const from = realLocal(parseSourceArgument(arg, io.cwd, { ghHost: io.env.GH_HOST }));
  const key = findSourceKey(state, canonicalSourceKey(from));
  if (key === null) throw new MaximsError(ExitCode.Usage, `${arg} is not installed`);
  return key;
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

export type ResolvedMemory = { key: string; name: MemoryName };

// A bare name is looked up across every source's effective set; two owners make it ambiguous and
// the qualified `@owner/repo/name` forms are the way out. A qualified name looks up one source.
export function resolveMemoryName(
  state: State,
  io: Pick<CliIo, "home" | "env">,
  raw: string,
): ResolvedMemory {
  const qualified = /^(@.+)\/([a-z0-9-]+)$/.exec(raw);
  if (qualified !== null && qualified[1] !== undefined && qualified[2] !== undefined) {
    const key = findSourceKey(state, qualified[1]);
    const name = parseMemoryName(qualified[2]);
    if (key === null) throw new MaximsError(ExitCode.Usage, `${qualified[1]} is not installed`);
    if (name === null)
      throw new MaximsError(ExitCode.Usage, `"${qualified[2]}" is not a memory name`);
    const entry = state.sources[key];
    if (entry === undefined || !effectiveNames(entry, io).includes(name)) {
      throw new MaximsError(ExitCode.Usage, `${key} does not provide ${name}`);
    }
    return { key, name };
  }
  const name = parseMemoryName(raw);
  if (name === null)
    throw new MaximsError(ExitCode.Usage, `"${raw}" is not a kebab-case memory name`);
  const owners = Object.entries(state.sources)
    .filter(([, entry]) => effectiveNames(entry, io).includes(name))
    .map(([key]) => key);
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

// One-field intent edits on either variant of a source entry; the live variant carries no fetch
// record and the fetched one keeps its own.
export function withIntent(
  entry: SourceEntry,
  patch: Partial<Pick<SourceIntent, "harnesses" | "rename">>,
): SourceEntry {
  if (isLiveEntry(entry)) return { intent: { ...entry.intent, ...patch }, addedAt: entry.addedAt };
  if (isCopiedEntry(entry)) {
    const intent = { ...entry.intent, ...patch };
    return entry.fetched === undefined
      ? { intent, addedAt: entry.addedAt }
      : { intent, fetched: entry.fetched, addedAt: entry.addedAt };
  }
  const intent = { ...entry.intent, ...patch };
  return entry.fetched === undefined
    ? { intent, addedAt: entry.addedAt }
    : { intent, fetched: entry.fetched, addedAt: entry.addedAt };
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
