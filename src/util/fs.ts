import { createHash, randomBytes } from "node:crypto";
import {
  closeSync,
  fsyncSync,
  mkdirSync,
  openSync,
  renameSync,
  unlinkSync,
  writeSync,
} from "node:fs";
import { chmod, readdir, readFile } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { ExitCode, MaximsError } from "./exit-codes.ts";

export type WriteFileAtomicOptions = {
  mode?: number;
};

// Every destination write is temp + rename so a reader in another process sees the old file or the
// new one, never a partial one; the memory-file and rule-file guarantees in sync rely on this.
export function writeFileAtomic(
  path: string,
  data: string | Uint8Array,
  options: WriteFileAtomicOptions = {},
): void {
  const dir = dirname(path);
  const tempPath = join(dir, `.${randomBytes(6).toString("hex")}.tmp`);
  try {
    mkdirSync(dir, { recursive: true });
    const fd = openSync(tempPath, "w", options.mode ?? 0o644);
    try {
      writeSync(fd, typeof data === "string" ? Buffer.from(data) : data);
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    renameSync(tempPath, path);
  } catch (cause) {
    try {
      unlinkSync(tempPath);
    } catch {
      // The temp file was never created or the rename already consumed it; either way nothing to
      // clean up, and the original error below is the one worth reporting.
    }
    throw new MaximsError(
      ExitCode.DestinationWriteFailed,
      `cannot write ${path}: ${describe(cause)}`,
      {
        cause,
      },
    );
  }
}

export function assertInsideRoot(root: string, candidate: string): string {
  const resolvedRoot = resolve(root);
  const resolved = resolve(candidate);
  const rel = relative(resolvedRoot, resolved);
  if (rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
    throw new MaximsError(
      ExitCode.DestinationWriteFailed,
      `refusing to write outside ${resolvedRoot}: ${resolved}`,
    );
  }
  return resolved;
}

export function sha256(text: string | Uint8Array): string {
  return `sha256:${createHash("sha256").update(text).digest("hex")}`;
}

// A symlink inside a source could point at a secret elsewhere on the machine, so the hash covers
// only regular files; the same skip keeps a live tree's hash equal to its copied twin's.
export async function hashDirectory(dir: string): Promise<string> {
  const files = await collectRegularFiles(dir, "");
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

async function collectRegularFiles(root: string, relDir: string): Promise<string[]> {
  const entries = await readdir(join(root, relDir), { withFileTypes: true });
  const out: string[] = [];
  for (const entry of entries) {
    const rel = relDir === "" ? entry.name : `${relDir}/${entry.name}`;
    if (entry.isDirectory()) out.push(...(await collectRegularFiles(root, rel)));
    else if (entry.isFile()) out.push(rel);
  }
  return out;
}

export async function ensureDir0700(dir: string): Promise<void> {
  try {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    if (process.platform !== "win32") await chmod(dir, 0o700);
  } catch (cause) {
    throw new MaximsError(
      ExitCode.DestinationWriteFailed,
      `cannot create ${dir}: ${describe(cause)}`,
      {
        cause,
      },
    );
  }
}

function describe(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}
