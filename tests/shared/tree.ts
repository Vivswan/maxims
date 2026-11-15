import { lstatSync, readdirSync, readlinkSync } from "node:fs";
import { join } from "node:path";

export type TreeEntry =
  | { path: string; kind: "file" }
  | { path: string; kind: "dir" }
  | { path: string; kind: "symlink"; target: string };

/**
 * Returns every entry under `root`, depth first and sorted by name within a folder; `path` is
 * relative to `root` and spelled with `/` on every platform. An entry whose path is in `skip` is
 * left out, with everything under it.
 */
// A symlink is reported and never followed: a link to a folder outside the tree, or a link loop,
// is one entry. The platform's recursive `readdirSync` walks through such a link.
export function walkTree(root: string, skip: ReadonlySet<string> = new Set()): TreeEntry[] {
  const entries: TreeEntry[] = [];

  const walk = (dir: string, prefix: string): void => {
    for (const name of readdirSync(dir).sort()) {
      const path = prefix === "" ? name : `${prefix}/${name}`;
      if (skip.has(path)) continue;

      const absolute = join(dir, name);
      const stat = lstatSync(absolute);

      if (stat.isSymbolicLink()) {
        entries.push({ path, kind: "symlink", target: readlinkSync(absolute) });
        continue;
      }

      if (!stat.isDirectory()) {
        entries.push({ path, kind: "file" });
        continue;
      }

      entries.push({ path, kind: "dir" });
      walk(absolute, path);
    }
  };

  walk(root, "");
  return entries;
}
