import { createHash, randomBytes } from "node:crypto";
import {
  closeSync,
  fchmodSync,
  fsyncSync,
  mkdirSync,
  openSync,
  realpathSync,
  renameSync,
  unlinkSync,
  writeSync,
} from "node:fs";
import { chmod, readdir, readFile } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { ExitCode, MaximsError } from "./exit-codes.ts";

export type WriteFileAtomicOptions = {
  mode?: number;
};

declare const rootedPathBrand: unique symbol;

// A path that `assertInsideRoot` has resolved and proven to lie under its destination root. It is
// the only path type a `Change` accepts, so a planner cannot hand `applyChanges` a path it never
// checked; the brand is erased at runtime and the value is the resolved absolute path.
export type RootedPath = string & { readonly [rootedPathBrand]: true };

// Every destination write is temp + rename so a reader in another process sees the old file or the
// new one, never a partial one; the memory-file and rule-file guarantees in sync rely on this. A
// requested mode is set on the descriptor because the open mode is masked by the umask.
export function writeFileAtomic(
  path: RootedPath,
  data: string | Uint8Array,
  options: WriteFileAtomicOptions = {},
): void {
  const dir = dirname(path);
  const tempPath = join(dir, `.${randomBytes(6).toString("hex")}.tmp`);
  try {
    mkdirSync(dir, { recursive: true });
    const fd = openSync(tempPath, "w", options.mode ?? 0o644);
    try {
      writeAll(fd, typeof data === "string" ? Buffer.from(data) : data);
      if (options.mode !== undefined) fchmodSync(fd, options.mode);
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

// A single write may stop short of the buffer's end on a nearly full disk; renaming that partial
// temp file into place would publish a truncated destination as if it were complete.
function writeAll(fd: number, data: Uint8Array): void {
  let offset = 0;
  while (offset < data.byteLength) {
    const written = writeSync(fd, data, offset, data.byteLength - offset);
    if (written <= 0) throw new Error(`short write at byte ${offset} of ${data.byteLength}`);
    offset += written;
  }
}

// Containment is checked on real paths, not lexical ones: a symlinked directory planted under the
// root would otherwise carry a write or delete to wherever it points. The deepest existing
// ancestor of the candidate is resolved and the not-yet-created tail appended to it.
export function assertInsideRoot(root: string, candidate: string): RootedPath {
  const resolved = resolve(candidate);
  const realRoot = realpathOfExistingPrefix(resolve(root));
  const realCandidate = realpathOfExistingPrefix(resolved);
  const rel = relative(realRoot, realCandidate);
  if (rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
    throw new MaximsError(
      ExitCode.DestinationWriteFailed,
      `refusing to write outside ${realRoot}: ${resolved}`,
    );
  }
  return resolved as RootedPath;
}

function realpathOfExistingPrefix(path: string): string {
  let prefix = path;
  const tail: string[] = [];
  for (;;) {
    try {
      return join(realpathSync(prefix), ...tail.reverse());
    } catch {
      const parent = dirname(prefix);
      if (parent === prefix) return path;
      tail.push(basename(prefix));
      prefix = parent;
    }
  }
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
