import { existsSync, lstatSync, realpathSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

// The path's longest existing prefix goes through realpath, so a symlink or a /proc alias whose
// lexical form lies elsewhere still compares against where the bytes would land. A dangling link
// is refused outright: realpath cannot follow it, yet a write would. The native realpath asks the
// OS for the final name; on Windows that expands 8.3 short names and junctions, which the
// JavaScript walk keeps, so two spellings of one temp directory agree.
export function whereBytesLand(path: string, refuse: (message: string) => never): string {
  let existing = resolve(path);
  const missing: string[] = [];
  let entry = lstatSync(existing, { throwIfNoEntry: false });
  while (entry === undefined) {
    const parent = dirname(existing);
    // An absent root (a drive letter with no volume) has no real name; the lexical form stands.
    if (parent === existing) return join(existing, ...missing);
    missing.unshift(basename(existing));
    existing = parent;
    entry = lstatSync(existing, { throwIfNoEntry: false });
  }
  if (entry.isSymbolicLink() && !existsSync(existing)) {
    refuse(`refusing to write through the dangling symlink ${existing}`);
  }
  return join(realpathSync.native(existing), ...missing);
}

// relative() folds case on win32, so two spellings of one NTFS path agree; a common prefix that is
// not a whole segment does not count.
export function isInside(root: string, path: string): boolean {
  const rel = relative(root, path);
  return rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
}
