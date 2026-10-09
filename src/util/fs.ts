import { createHash, randomBytes } from "node:crypto";
import {
  closeSync,
  fchmodSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  realpathSync,
  renameSync,
  unlinkSync,
  writeSync,
} from "node:fs";
import { chmod } from "node:fs/promises";
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
    // A link at the destination is removed once the replacement is complete, right before the
    // rename: the file written here is a real file wherever the link pointed, and Windows refuses
    // to rename over a link to a directory.
    if (lstatSync(path, { throwIfNoEntry: false })?.isSymbolicLink()) unlinkSync(path);
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
// root would otherwise carry a write or delete to wherever it points. Only the PARENT is
// resolved; the final entry is what a write, rename or unlink modifies, and it is normal for that
// entry to be a link whose target lies elsewhere (a memory body linked from the store). The root
// itself is the one candidate judged by its own real path: its final entry may be a link too
// (`~/.agents` symlinked to a dotfiles checkout) and the root is trivially inside itself.
export function assertInsideRoot(root: string, candidate: string): RootedPath {
  const resolved = resolve(candidate);
  const resolvedRoot = resolve(root);
  const realRoot = realpathOfExistingPrefix(resolvedRoot);
  const realCandidate =
    resolved === resolvedRoot || dirname(resolved) === resolved
      ? realpathOfExistingPrefix(resolved)
      : join(realpathOfExistingPrefix(dirname(resolved)), basename(resolved));
  if (!isInside(realRoot, realCandidate)) {
    throw new MaximsError(
      ExitCode.DestinationWriteFailed,
      `refusing to write outside ${realRoot}: ${resolved}`,
    );
  }
  return resolved as RootedPath;
}

// Whether `path` is `root` or lies below it, judged by path segment: a sibling named `..cache` is
// outside, a child named `..cache` is inside. Both arguments are compared as given, so a caller
// that needs real paths resolves them first.
export function isInside(root: string, path: string): boolean {
  const rel = relative(root, path);
  return rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
}

// The real path of a location that may not exist yet: its deepest existing prefix resolved, the
// rest appended as typed. Only "nothing is there" walks up; a prefix that exists but cannot be
// inspected is exit 4, never a path verdict, so a containment check or a sweep identity is never
// built on a path nobody looked at.
export function realpathOfExistingPrefix(path: string): string {
  let prefix = path;
  const tail: string[] = [];
  for (;;) {
    try {
      return join(realpathSync(prefix), ...tail.reverse());
    } catch (cause) {
      if (!isAbsent(cause)) throw cannotInspect(prefix, cause);
      const parent = dirname(prefix);
      if (parent === prefix) return path;
      tail.push(basename(prefix));
      prefix = parent;
    }
  }
}

// The one reading of "nothing is there": a missing entry, or a regular file where a directory was
// expected on the way. A directory where a file was expected (EISDIR) is NOT absent: something is
// there, and it is not what maxims owns, so the caller refuses it by name instead of planning over
// it. Any other failure (EACCES, EIO) means the probe could not look, and is never an answer.
export function isAbsent(cause: unknown): boolean {
  const code = (cause as NodeJS.ErrnoException).code;
  return code === "ENOENT" || code === "ENOTDIR";
}

export function readIfPresent(path: string): string | null {
  try {
    return readFileSync(path, "utf8");
  } catch (cause) {
    if (isAbsent(cause)) return null;
    throw cannotInspect(path, cause);
  }
}

export function cannotInspect(path: string, cause: unknown): MaximsError {
  return new MaximsError(
    ExitCode.DestinationWriteFailed,
    `cannot inspect ${path}: ${describe(cause)}`,
    {
      cause,
    },
  );
}

export function sha256(text: string | Uint8Array): string {
  return `sha256:${createHash("sha256").update(text).digest("hex")}`;
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
