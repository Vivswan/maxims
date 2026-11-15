import { lstatSync, readdirSync, readlinkSync, statSync } from "node:fs";
import { relative, sep } from "node:path";
import klawSync from "klaw-sync";

// klaw-sync lists a folder in the order the filesystem returns it; a digest needs one order everywhere.
const SORTED_FS = {
  readdirSync: (dir: string): string[] => readdirSync(dir).sort(),
  lstatSync,
  statSync,
};

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
  const pathOf = (absolute: string): string => relative(root, absolute).split(sep).join("/");
  const items = klawSync(root, { fs: SORTED_FS, filter: (item) => !skip.has(pathOf(item.path)) });

  return items.map((item) => {
    const path = pathOf(item.path);
    if (item.stats.isSymbolicLink())
      return { path, kind: "symlink", target: readlinkSync(item.path) };
    if (item.stats.isDirectory()) return { path, kind: "dir" };

    return { path, kind: "file" };
  });
}
