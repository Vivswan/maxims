import { createHash, randomBytes } from "node:crypto";
import {
  closeSync,
  fchmodSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { chmod } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, parse, relative, resolve, sep } from "node:path";
import { ExitCode, MaximsError } from "./exit-codes.ts";

export type WriteFileAtomicOptions = {
  mode?: number;
};

// Windows cannot hold a requested mode, so a mode compare there counts a change on every run.
export const POSIX_MODES = process.platform !== "win32";

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
      // Handed as bytes: node's writeFileSync sends a utf8 string down a separate native path,
      // and the byte path is the one whose write loop both runtimes share.
      writeFileSync(fd, typeof data === "string" ? Buffer.from(data) : data);
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
// that needs real paths resolves them first; relative() folds case on win32, so two spellings of
// one NTFS path agree.
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

// Nothing there reads as no link; a probe that could not look is exit 4, never an answer.
export function isSymlink(path: string): boolean {
  try {
    return lstatSync(path).isSymbolicLink();
  } catch (cause) {
    if (isAbsent(cause)) return false;
    throw cannotInspect(path, cause);
  }
}

// The kernel's own bound on a chain of links, past which an open fails with ELOOP.
const MAX_LINK_HOPS = 40;

// The entries a chain of links passes, read as the kernel reads them: the links passed and the
// entry each reaches, a folder link on the way included, the link at `path` itself excluded.
// `reached` ends at an entry that is no link (it may not exist); `broken` met a folder that is
// missing or a file (ENOENT, ENOTDIR); `looped` passed the kernel's bound (ELOOP).
export type LinkChain =
  | { kind: "reached"; hops: string[]; end: string }
  | { kind: "broken"; hops: string[] }
  | { kind: "looped"; hops: string[] };

// A relative target is read from the link's real parent, one component at a time, a `..` stepping
// out of the folder the component before it reached. No path holding a `..` is handed to
// realpathSync, which folds it before looking at the links before it.
export function followLinks(path: string): LinkChain {
  const hops: string[] = [];
  let at = path;
  while (isSymlink(at)) {
    if (hops.length >= MAX_LINK_HOPS) return { kind: "looped", hops };
    const next = hopOf(hops, realpathOfExistingPrefix(dirname(at)), readlinkSync(at));
    if (next === null) return { kind: "broken", hops };
    hops.push(next);
    at = next;
  }
  return { kind: "reached", hops, end: at };
}

// A backslash separates only where the platform says so; on POSIX it is a character in a name.
const SEPARATORS = sep === "\\" ? /[\\/]+/ : /\/+/;

// `target` walked from `realParent` (or from the root it names), every folder on the way an
// existing directory or the walk ends in null, as the kernel's does in ENOENT or ENOTDIR; a
// folder link on the way joins `hops`. The final entry is not followed: it is the next hop, or
// the file the chain ends at. A target ending in a separator or `.` names a folder, so its final
// entry is walked like the ones before it.
function hopOf(hops: string[], realParent: string, target: string): string | null {
  const { root } = parse(target);
  const parts = target
    .slice(root.length)
    .split(SEPARATORS)
    .filter((name) => name !== "");
  const dirOnly = SEPARATORS.test(target.slice(-1)) || parts[parts.length - 1] === ".";
  const names = parts.filter((name) => name !== ".");
  const last = dirOnly ? undefined : names.pop();
  let at = root === "" ? realParent : root;
  for (const name of names) {
    if (name === "..") {
      at = dirname(at);
      continue;
    }
    const entry = join(at, name);
    if (isSymlink(entry)) hops.push(entry);
    const folder = existingDirectory(entry);
    if (folder === null) return null;
    at = folder;
  }
  if (last === undefined) return at;
  return last === ".." ? dirname(at) : join(at, last);
}

// The real path of the directory at `path`, or null where nothing is there or a file is.
function existingDirectory(path: string): string | null {
  try {
    const real = realpathSync.native(path);
    return statSync(real).isDirectory() ? real : null;
  } catch (cause) {
    if (isAbsent(cause)) return null;
    throw cannotInspect(path, cause);
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
    if (POSIX_MODES) await chmod(dir, 0o700);
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
