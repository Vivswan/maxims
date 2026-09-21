import type { MemoryName } from "../memory/contract.ts";
import type { RenameMap, Select, SourceIntent } from "../state/schema.ts";
import { ExitCode } from "../util/exit-codes.ts";
import { compareSourceKeys } from "./block.ts";
import { type CapCheck, checkCap } from "./budget.ts";
import type { RuleLine } from "./types.ts";

export type NameIndex = ReadonlyMap<MemoryName, string>;

export type IndexedSource = {
  key: string;
  addedAt: string;
  intent: Pick<SourceIntent, "select" | "rename">;
  names: readonly MemoryName[];
};

export type Installed = Pick<IndexedSource, "key" | "addedAt">;

// Installation order, the one ordering every consumer of `addedAt` shares. It compares instants,
// not strings: `...:00Z` and `...:00.001Z` are both valid spellings and their string order is
// not their time order. The key breaks a tie so two machines order the same.
export function compareInstalled(a: Installed, b: Installed): number {
  return Date.parse(a.addedAt) - Date.parse(b.addedAt) || compareSourceKeys(a.key, b.key);
}

// Derived on every run from intent plus each source's current memory names, which the caller
// resolves because a live local source has no fetched record to read them from. Sources are
// walked in installation order, so when an upstream later ships a name another source already
// carries, the source installed first keeps it and the newer one is the one asked to rename.
export function buildNameIndex(sources: readonly IndexedSource[]): NameIndex {
  const index = new Map<MemoryName, string>();
  const ordered = [...sources].sort(compareInstalled);
  for (const source of ordered) {
    for (const name of localNames(source.intent, source.names)) {
      if (!index.has(name)) index.set(name, source.key);
    }
  }
  return index;
}

function localNames(
  intent: Pick<SourceIntent, "select" | "rename">,
  names: readonly MemoryName[],
): MemoryName[] {
  return applySelect(names, intent.select, (name) => name).map((name) =>
    renamed(intent.rename, name),
  );
}

function applySelect<T>(items: readonly T[], select: Select, nameOf: (item: T) => MemoryName): T[] {
  if (select === "*") return [...items];
  const wanted = new Set<string>(select);
  return items.filter((item) => wanted.has(nameOf(item)));
}

// A plain object lookup would hand back Object.prototype members for a memory named
// `constructor` or `to-string`-like keys that exist on the prototype chain.
function renamed(rename: RenameMap, name: MemoryName): MemoryName {
  return Object.hasOwn(rename, name) ? rename[name] : name;
}

export type Candidate = {
  name: MemoryName;
  description: string;
  contentHash: string;
  detailPath: string;
};

export type Collision = {
  name: MemoryName;
  ownedBy: string;
};

export type Resolution =
  | { ok: true; lines: RuleLine[] }
  | { ok: false; code: ExitCode.NameCollision; collisions: Collision[] }
  | Exclude<CapCheck, { ok: true }>;

export type ResolveInput = {
  source: string;
  memories: readonly Candidate[];
  select: Select;
  rename: RenameMap;
  index: NameIndex;
  cap: number;
};

export function resolveSourceCandidates(input: ResolveInput): Resolution {
  const candidates = applySelect(input.memories, input.select, (memory) => memory.name)
    .map((memory) => ({ memory, name: renamed(input.rename, memory.name) }))
    .sort((a, b) => compare(a.name, b.name));
  const collisions: Collision[] = [];
  const lines: RuleLine[] = [];
  const taken = new Set<MemoryName>();
  for (const { memory, name } of candidates) {
    const owner = input.index.get(name);
    if ((owner !== undefined && owner !== input.source) || taken.has(name)) {
      collisions.push({ name, ownedBy: owner ?? input.source });
      continue;
    }
    taken.add(name);
    lines.push({
      name,
      description: memory.description,
      detailPath: memory.detailPath,
      shortHash: shortHash(memory.contentHash),
    });
  }
  if (collisions.length > 0) return { ok: false, code: ExitCode.NameCollision, collisions };
  const cap = checkCap(lines.length, input.cap);
  return cap.ok ? { ok: true, lines } : cap;
}

function compare(a: string, b: string): number {
  if (a < b) return -1;
  return a > b ? 1 : 0;
}

const CONTENT_HASH = /^sha256:([0-9a-f]{64})$/;

// The display prefix of `fetched.memories[].content`; long enough to make a change visible in a
// diff line, never stored, never part of identity.
export function shortHash(contentHash: string): string {
  const match = CONTENT_HASH.exec(contentHash);
  if (match === null) throw new Error(`not a sha256 content hash: ${contentHash}`);
  return match[1].slice(0, 7);
}

export function pruneRenames(rename: RenameMap, upstreamNames: Iterable<MemoryName>): RenameMap {
  const live = new Set<string>(upstreamNames);
  return Object.fromEntries(Object.entries(rename).filter(([from]) => live.has(from)));
}
