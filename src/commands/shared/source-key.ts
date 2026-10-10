import { statSync } from "node:fs";
import { join } from "node:path";
import type { SourceFrom } from "../../contracts/source.ts";
import { type MemoryTree, readMemoryTree, type TreeScope } from "../../sources/tree.ts";
import { canonicalSourceKey, type State } from "../../state/schema.ts";

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

// The files under a store entry as the fetch would have laid them out, walked from the source
// root under `--full-depth` and from the memory folder otherwise; null only when the folder to
// walk is not there. A folder that is there but cannot be looked at fails as itself, never as an
// empty store.
export async function storeTree(root: string, scope: TreeScope): Promise<MemoryTree | null> {
  const scanned = scope.fullDepth ? root : join(root, scope.memoryPath);
  if (statSync(scanned, { throwIfNoEntry: false }) === undefined) return null;
  return readMemoryTree(root, scope, () => undefined);
}
