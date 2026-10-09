import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join, sep } from "node:path";

// A symlink inside a source could point at a secret elsewhere on the machine, so the hash covers
// only regular files; the same skip keeps a live tree's hash equal to its copied twin's.
export async function hashDirectory(dir: string): Promise<string> {
  const files = [
    ...new Bun.Glob("**/*").scanSync({
      cwd: dir,
      dot: true,
      onlyFiles: true,
      followSymlinks: false,
    }),
  ].map((rel) => rel.split(sep).join("/"));
  files.sort();
  const hash = createHash("sha256");
  for (const relPath of files) {
    const content = await readFile(join(dir, relPath));
    hash.update(relPath);
    hash.update("\0");
    hash.update(String(content.byteLength));
    hash.update("\0");
    hash.update(content);
    hash.update("\0");
  }
  return `sha256:${hash.digest("hex")}`;
}
