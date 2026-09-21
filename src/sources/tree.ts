import { createHash } from "node:crypto";
import { readdir, readFile, realpath, stat } from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { isMemoryFile } from "../memory/contract.ts";
import { ExitCode, MaximsError } from "../util/exit-codes.ts";
import type { FetchOptions } from "./contract.ts";

export type WarnSink = (message: string) => void;

export type TreeFile = { relPath: string; text: string };

export type MemoryTree = {
  scannedRoot: string;
  files: TreeFile[];
};

export type TreeScope = Pick<FetchOptions, "memoryPath" | "fullDepth">;

// `relPath` is always relative to the SOURCE root, whichever folder was scanned, so the store copy
// of a source is laid out exactly like the source and `fetched.memoryPath` finds it there.
export async function readMemoryTree(
  root: string,
  scope: TreeScope,
  warn: WarnSink,
): Promise<MemoryTree> {
  const sourceRoot = resolve(root);
  const scannedRoot = scope.fullDepth ? sourceRoot : resolve(sourceRoot, scope.memoryPath);
  const prefix = relative(sourceRoot, scannedRoot);
  if (prefix === ".." || prefix.startsWith(`..${sep}`) || isAbsolute(prefix)) {
    throw new MaximsError(
      ExitCode.SourceUnresolvable,
      `memory path ${scope.memoryPath} escapes the source ${sourceRoot}`,
    );
  }
  await assertDirectory(scannedRoot, scope, sourceRoot);
  const prefixSegments = prefix === "" ? [] : prefix.split(sep);
  const files: TreeFile[] = [];
  for (const rel of await walkRegularFiles(scannedRoot, [], warn)) {
    const name = rel[rel.length - 1] ?? "";
    if (!isMemoryFile(name)) continue;
    const text = await readFile(join(scannedRoot, ...rel), "utf8");
    files.push({ relPath: [...prefixSegments, ...rel].join("/"), text });
  }
  return { scannedRoot, files };
}

// The source root may itself be a symlink (a dotfiles checkout often is), so both ends are
// canonicalized; a link anywhere between the root and the memory folder is what must not be walked.
async function assertDirectory(dir: string, scope: TreeScope, sourceRoot: string): Promise<void> {
  const entry = await stat(dir).catch((cause: NodeJS.ErrnoException) => cause);
  if (entry instanceof Error) {
    if (entry.code !== "ENOENT") {
      throw new MaximsError(ExitCode.SourceUnresolvable, `cannot read ${dir}: ${entry.message}`);
    }
    if (dir === sourceRoot) {
      throw new MaximsError(ExitCode.SourceUnresolvable, `${dir} is not a directory`);
    }
    throw new MaximsError(
      ExitCode.SourceUnresolvable,
      `${sourceRoot} has no ${scope.memoryPath} directory`,
      {
        hint: "name the folder holding memories with --from <path>, or scan all with --full-depth",
      },
    );
  }
  if (!entry.isDirectory()) {
    throw new MaximsError(ExitCode.SourceUnresolvable, `${dir} is not a directory`);
  }
  if (dir === sourceRoot) return;
  const [realRoot, realDir] = await Promise.all([realpath(sourceRoot), realpath(dir)]);
  if (realDir !== join(realRoot, relative(sourceRoot, dir))) {
    throw new MaximsError(
      ExitCode.SourceUnresolvable,
      `${scope.memoryPath} in ${sourceRoot} is reached through a symlink; links inside a source are never followed`,
    );
  }
}

// Dirent types describe the entry itself, never its target, so a symlink is seen as a symlink even
// when it points at a regular file; that is what keeps a link named `x.md` out of the store.
async function walkRegularFiles(root: string, rel: string[], warn: WarnSink): Promise<string[][]> {
  const entries = await readdir(join(root, ...rel), { withFileTypes: true });
  entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  const out: string[][] = [];
  for (const entry of entries) {
    if (entry.name.startsWith(".")) continue;
    const path = [...rel, entry.name];
    if (entry.isSymbolicLink()) {
      warn(`skipped symlink ${path.join("/")}: links inside a source are never followed`);
    } else if (entry.isDirectory()) {
      out.push(...(await walkRegularFiles(root, path, warn)));
    } else if (entry.isFile()) {
      out.push(path);
    }
  }
  return out;
}

// Same framing as `hashDirectory` in util/fs.ts, applied to the collected memory files only, so a
// symlink, a hidden file, or an unrelated README cannot change a source's sha.
export function hashFiles(files: TreeFile[]): string {
  const hash = createHash("sha256");
  for (const file of [...files].sort((a, b) => (a.relPath < b.relPath ? -1 : 1))) {
    const content = Buffer.from(file.text);
    hash.update(file.relPath);
    hash.update("\0");
    hash.update(String(content.byteLength));
    hash.update("\0");
    hash.update(content);
    hash.update("\0");
  }
  return `sha256:${hash.digest("hex")}`;
}
