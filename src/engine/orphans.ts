import { readdirSync } from "node:fs";
import { join, sep } from "node:path";
import type { Change } from "../util/change.ts";
import { assertInsideRoot, isAbsent } from "../util/fs.ts";

const FIXED_DEPTH: ReadonlyMap<string, number> = new Map([
  ["_local", 2],
  ["_github", 4],
]);
const GIT_MIN_DEPTH = 3;
const OWNER_DEPTH = 2;

// The directories and links under `dir`, in name order; `null` when it cannot be listed, an absent
// one silently and any other failure said.
function listedDirs(dir: string, warn: (line: string) => void): string[] | null {
  try {
    return readdirSync(dir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() || entry.isSymbolicLink())
      .map((entry) => entry.name)
      .sort();
  } catch (error) {
    if (!isAbsent(error)) {
      warn(`cannot list ${dir}: ${error instanceof Error ? error.message : String(error)}`);
    }
    return null;
  }
}

// Every entry under `root` no source in state derives, as `delete` changes. `expected` holds the
// entry paths intent derives to; an entry is kept when it is one of them, descended when one lies
// beneath it, and swept when neither. The pending root is laid out like the store, so one walk
// serves both.
export function planOrphanSweep(
  root: string,
  expected: ReadonlySet<string>,
  warn: (line: string) => void,
): Change[] {
  const changes: Change[] = [];
  const walk = (dir: string, segments: string[]): void => {
    const names = listedDirs(dir, warn);
    if (names === null) return;
    for (const name of names) {
      const path = join(dir, name);
      const here = [...segments, name];
      if (expected.has(path)) continue;
      const ancestorOfExpected = [...expected].some((entry) => entry.startsWith(`${path}${sep}`));
      if (ancestorOfExpected || !isEntryPosition(here)) {
        walk(path, here);
        continue;
      }
      changes.push({ kind: "delete", path: assertInsideRoot(root, path) });
    }
  };
  walk(root, []);
  return changes;
}

// Where an entry can sit under the store, by the naming scheme in `storePathFor`. A directory at
// any other position is a prefix and is never swept, so a stray `store/README` or an emptied owner
// folder is left as it is.
//   _local/<x>, <owner>/<repo>     -> depth 2
//   _github/<host>/<owner>/<repo>  -> depth 4
//   _git/<host>/<remote's path>    -> depth 3 or more (the remote's path is of any depth)
function isEntryPosition(segments: string[]): boolean {
  const [head] = segments;
  if (head === undefined) return false;
  if (head === "_git") return segments.length >= GIT_MIN_DEPTH;
  const fixed = FIXED_DEPTH.get(head);
  if (fixed !== undefined) return segments.length === fixed;
  if (head.startsWith("_")) return false;
  return segments.length === OWNER_DEPTH;
}
