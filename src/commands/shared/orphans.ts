import { readdirSync } from "node:fs";
import { join, sep } from "node:path";
import type { Change } from "../../util/change.ts";
import { assertInsideRoot } from "../../util/fs.ts";

// Where an entry can sit under the store, by the naming scheme in `storePathFor`: `_local/<x>`
// and `<owner>/<repo>` at depth 2, `_github/<host>/<owner>/<repo>` at depth 4, and `_git/<host>/`
// followed by a remote's path of any depth. A directory at any other position is a prefix and
// is never swept, so a stray `store/README` or an emptied owner folder is left as it is. The
// pending root is laid out the same way, so one walk serves both.
const FIXED_DEPTH: ReadonlyMap<string, number> = new Map([
  ["_local", 2],
  ["_github", 4],
]);
const GIT_MIN_DEPTH = 3;
const OWNER_DEPTH = 2;

// Every entry under `root` no source in state derives, as `delete` changes. `expected` holds the
// entry paths intent derives to; an entry is kept when it is one of them, descended when one lies
// beneath it, and swept when neither.
export function planOrphanSweep(
  root: string,
  expected: ReadonlySet<string>,
  warn: (line: string) => void,
): Change[] {
  const changes: Change[] = [];
  const walk = (dir: string, segments: string[]): void => {
    let names: string[];
    try {
      names = readdirSync(dir, { withFileTypes: true })
        .filter((entry) => entry.isDirectory() || entry.isSymbolicLink())
        .map((entry) => entry.name);
    } catch (error) {
      const code = error instanceof Error && "code" in error ? error.code : undefined;
      if (code !== "ENOENT" && code !== "ENOTDIR") {
        warn(`cannot list ${dir}: ${error instanceof Error ? error.message : String(error)}`);
      }
      return;
    }
    for (const name of names.sort()) {
      const path = join(dir, name);
      const here = [...segments, name];
      if (expected.has(path)) continue;
      const ancestorOfExpected = [...expected].some((entry) => entry.startsWith(`${path}${sep}`));
      if (ancestorOfExpected) {
        walk(path, here);
        continue;
      }
      if (isEntryPosition(here))
        changes.push({ kind: "delete", path: assertInsideRoot(root, path) });
      else walk(path, here);
    }
  };
  walk(root, []);
  return changes;
}

function isEntryPosition(segments: string[]): boolean {
  const [head] = segments;
  if (head === undefined) return false;
  if (head === "_git") return segments.length >= GIT_MIN_DEPTH;
  const fixed = FIXED_DEPTH.get(head);
  if (fixed !== undefined) return segments.length === fixed;
  if (head.startsWith("_")) return false;
  return segments.length === OWNER_DEPTH;
}
