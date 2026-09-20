// A content snapshot of a directory tree, so a row can prove a verb wrote nothing outside the
// paths it is allowed to touch.
import { existsSync, readdirSync, readFileSync, readlinkSync } from "node:fs";
import { join, relative } from "node:path";
import { sha256 } from "../../src/util/fs.ts";

// Every entry under `root` by its path relative to the root: a file as its content hash, a
// symlink as its target, a directory as `dir`, so an empty folder or a dangling link a verb left
// behind shows up as well as a changed byte. `skip` lists the relative paths a run may touch.
export function snapshot(root: string, skip: string[] = []): Map<string, string> {
  const entries = new Map<string, string>();
  const skipped = new Set(skip.map((path) => join(...path.split("/"))));
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      const rel = relative(root, path);
      if (skipped.has(rel)) continue;
      if (entry.isSymbolicLink()) entries.set(rel, `link:${readlinkSync(path)}`);
      else if (entry.isDirectory()) {
        entries.set(rel, "dir");
        walk(path);
      } else entries.set(rel, sha256(readFileSync(path)));
    }
  };
  if (existsSync(root)) walk(root);
  return entries;
}
