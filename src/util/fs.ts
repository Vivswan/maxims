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
  type Stats,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { chmod } from "node:fs/promises";
import {
  basename,
  dirname,
  isAbsolute,
  join,
  posix,
  relative,
  resolve,
  sep,
  win32,
} from "node:path";
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
      : realKeyOf(resolved);
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
// rest appended as typed. Only "nothing is there" stops the walk; a prefix that exists but cannot
// be inspected is exit 4, never a path verdict, so a containment check or a sweep identity is never
// built on a path nobody looked at.
export function realpathOfExistingPrefix(path: string): string {
  return realpathOfPrefix(path, path);
}

// The identity a rule FILE is grouped and swept under: its parent resolved, its own name kept,
// because the final entry is what a write replaces (a leaf that is a symlink becomes the real
// file), while two spellings of the directory above it are one place.
export function realKeyOf(path: string): string {
  return join(realpathOfPrefix(dirname(path), path), basename(path));
}

// Read as the kernel reads `prefix`. Node's `realpathSync` folds a `..` before reading the link in
// front of it, and bun's normalizes the typed path before the kernel sees it, so neither is handed
// a `..`. The cwd is read inside the try: under a sealed folder macOS refuses the read itself.
//
// A failure to look names `asked`, the entry the caller asked about, never the entry the walk was
// at: the kernels disagree on where a sealed folder fails (macOS's realpath at the folder it
// cannot open, Linux's at the entry inside it), and the kernel's own path stays in the cause text.
function realpathOfPrefix(prefix: string, asked: string): string {
  const links = linksOf(process.platform);
  const { root, names } = links.parts(prefix);
  let at = root;
  let index = 0;
  try {
    at = resolve(root === "" ? process.cwd() : root);
    at = realpathSync.native(at);
    while (index < names.length) {
      const rest = names.slice(index);
      if (rest[0] === "..") {
        at = links.parentOf(at);
        index += 1;
        continue;
      }
      const end = rest.indexOf("..");
      const run = end === -1 ? rest : rest.slice(0, end);
      const head = realpathOfRun(at, run);
      if (head.length < run.length) return join(head.real, ...rest.slice(head.length));
      at = head.real;
      index += run.length;
    }
    return at;
  } catch (cause) {
    if (!isAbsent(cause)) throw cannotInspect(asked, cause);
    return join(at, ...names.slice(index));
  }
}

// The deepest existing head of `run` under the real folder `at`. One lookup's ENOENT does not say
// which entry was missing.
function realpathOfRun(at: string, run: string[]): { real: string; length: number } {
  for (let length = run.length; length > 0; length -= 1) {
    try {
      return { real: realpathSync.native(join(at, ...run.slice(0, length))), length };
    } catch (cause) {
      if (!isAbsent(cause)) throw cause;
    }
  }
  return { real: at, length: 0 };
}

// Nothing there reads as absent; a probe that could not look is exit 4 naming `path`, never an
// answer.
function ifPresent<T>(path: string, look: () => T): T | null {
  try {
    return look();
  } catch (cause) {
    if (isAbsent(cause)) return null;
    throw cannotInspect(path, cause);
  }
}

export function lstatIfPresent(path: string): Stats | null {
  return ifPresent(path, () => lstatSync(path));
}

export function isSymlink(path: string): boolean {
  return lstatIfPresent(path)?.isSymbolicLink() ?? false;
}

// The entries a chain of links passes, read as the kernel reads them: the links passed and the
// entry each reaches, a folder link on the way included, the link at `path` itself excluded.
// `reached` ends at an entry that is no link (it may not exist); `broken` met a folder that is
// missing or a file (ENOENT, ENOTDIR); `looped` passed the kernel's bound (ELOOP).
export type LinkChain =
  | { kind: "reached"; hops: string[]; end: string }
  | { kind: "broken"; hops: string[] }
  | { kind: "looped"; hops: string[] };

// How one kernel reads a path with links in it. The two differ on what a `..` means, so the same
// link reaches different files on each, and a walk has to pick the one the kernel of its platform
// opens:
//
//   POSIX    one component at a time; a `..` steps out of the folder the component before it
//            reached, entering it on the way (a sealed folder is EACCES, a file ENOTDIR);
//            40 links, then ELOOP
//   Windows  `.` and `..` folded in the typed string before any entry is looked at, so a `..`
//            after a linked folder never enters it; 63 reparse points
//
// Both read a relative target from the folder the link's own path reached, a folder link before
// it followed. `parts` is the fold: on Windows `win32.normalize`, whose kept `..` lead the target.
// `parentOf` is the `..` step from a real folder, the one step both walks take.
type LinkSemantics = {
  parts: (target: string) => { root: string; names: string[]; dirOnly: boolean };
  parentOf: (at: string) => string;
  maxHops: number;
};
const POSIX_LINKS: LinkSemantics = {
  parts: (target) => {
    const { root } = posix.parse(target);
    const names = target
      .slice(root.length)
      .split(/\/+/)
      .filter((name) => name !== "");
    const dirOnly = target.endsWith("/") || names.at(-1) === ".";
    return { root, names: names.filter((name) => name !== "."), dirOnly };
  },
  // Spelled without `join`, which would fold the `.` away and never enter the folder.
  parentOf: (at) => {
    statSync(`${at}${sep}.`);
    return dirname(at);
  },
  maxHops: 40,
};
const WINDOWS_LINKS: LinkSemantics = {
  parts: (target) => {
    const folded = win32.normalize(target);
    const { root } = win32.parse(folded);
    const names = folded
      .slice(root.length)
      .split("\\")
      .filter((name) => name !== "" && name !== ".");
    return { root, names, dirOnly: folded.endsWith("\\") };
  },
  parentOf: dirname,
  maxHops: 63,
};

// No path holding a `..` is handed to realpathSync, which folds it before looking at the links
// before it. Every hop of a followed chain is built on real folders, so `editInPlace` can hold the
// end of one against a real root; a path that is no link is returned as given.
export function followLinks(path: string, platform: NodeJS.Platform = process.platform): LinkChain {
  const links = linksOf(platform);
  const hops: string[] = [];
  let at = path;
  while (isSymlink(at)) {
    if (hops.length >= links.maxHops) return { kind: "looped", hops };
    const next = hopOf(hops, realpathOfExistingPrefix(dirname(at)), readlinkSync(at), links);
    if (next === null) return { kind: "broken", hops };
    hops.push(next);
    at = next;
  }
  return { kind: "reached", hops, end: at };
}

function linksOf(platform: NodeJS.Platform): LinkSemantics {
  return platform === "win32" ? WINDOWS_LINKS : POSIX_LINKS;
}

// A target ending in a separator or a `..` names a folder, so its final entry is walked like the
// ones before it.
function hopOf(
  hops: string[],
  realParent: string,
  target: string,
  links: LinkSemantics,
): string | null {
  const { root, names, dirOnly } = links.parts(target);
  let at = root === "" ? realParent : root;
  const last = dirOnly || names.at(-1) === ".." ? undefined : names.pop();
  for (const name of names) {
    const folder = name === ".." ? ifPresent(at, () => links.parentOf(at)) : enter(hops, at, name);
    if (folder === null) return null;
    at = folder;
  }
  return last === undefined ? at : join(at, last);
}

function enter(hops: string[], at: string, name: string): string | null {
  const entry = join(at, name);
  if (isSymlink(entry)) hops.push(entry);
  return ifPresent(entry, () => {
    const real = realpathSync.native(entry);
    return statSync(real).isDirectory() ? real : null;
  });
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
  return ifPresent(path, () => readFileSync(path, "utf8"));
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
