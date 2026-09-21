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

// git exits 128 for every fatal error alike, so "found no repository" is told by its message under
// the C locale. Both spellings open a parenthetical ("or any of the parent directories", "or any
// parent up to mount point"); a gitfile pointing at a moved primary names a path instead.
const NO_REPOSITORY_FOUND = "fatal: not a git repository (";

// GIT_CEILING_DIRECTORIES and a mount boundary both stop git's climb short of a checkout that
// encloses the root, and git reports nothing found for that checkout as for none; a .git entry
// above the root is what tells the two apart.
function enclosingCheckout(root: string): string | undefined {
  for (let dir = dirname(root); ; dir = dirname(dir)) {
    if (lstatSync(join(dir, ".git"), { throwIfNoEntry: false }) !== undefined) return dir;
    if (dirname(dir) === dir) return undefined;
  }
}

// A root with no .git of its own and no repository above it has exactly one checkout: itself (the
// container tier runs the scripts from such a copy). All three facts are needed: a checkout whose
// own .git is damaged makes git skip it and report the same "nothing found" while its linked
// worktrees still exist, and so does a checkout above the root that git was kept from climbing
// into. A git binary that cannot be started surfaces as a thrown ENOENT, not as an exit code.
function listCheckouts(repoRoot: string, refuse: (message: string) => never): string {
  const command = ["git", "-C", repoRoot, "worktree", "list", "--porcelain"];
  let git: Bun.ReadableSyncSubprocess;
  try {
    git = Bun.spawnSync(command, {
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
      env: { ...process.env, LC_ALL: "C" },
    });
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    refuse(`cannot list the repository's checkouts: ${reason}`);
  }
  if (git.exitCode === 0) return git.stdout.toString();
  const stderr = git.stderr.toString();
  const ownMetadata = lstatSync(join(repoRoot, ".git"), { throwIfNoEntry: false });
  if (stderr.startsWith(NO_REPOSITORY_FOUND) && ownMetadata === undefined) {
    const above = enclosingCheckout(repoRoot);
    if (above === undefined) return "";
    refuse(`cannot list the repository's checkouts: git found none, yet ${above} has a .git`);
  }
  process.stderr.write(stderr);
  refuse(`cannot list the repository's checkouts: git worktree list exited with ${git.exitCode}`);
}

// Every checkout of one repository shares its history, so a commit from any of them publishes
// what lands there; git's own worktree list is the set of them. A bare entry has no working tree.
// A primary set up with --separate-git-dir is out of reach: git keeps no path back to it and lists
// its git dir in its place. No git answer from a real checkout, no known roots: refuse. Every root
// is canonicalized the way the output path is, so the two sides agree on a spelling (git prints
// forward slashes and the short name of a Windows temp directory).
function repositoryRoots(repoRoot: string, refuse: (message: string) => never): Set<string> {
  const root = whereBytesLand(repoRoot, refuse);
  const roots = new Set([root]);
  for (const entry of listCheckouts(root, refuse).split("\n\n")) {
    const lines = entry.split("\n");
    const path = lines[0]?.startsWith("worktree ") ? lines[0].slice("worktree ".length) : undefined;
    if (path === undefined || lines.includes("bare")) continue;
    roots.add(existsSync(path) ? whereBytesLand(path, refuse) : resolve(path));
  }
  return roots;
}

// Where a script may write what it measured or observed on this machine: anywhere but a checkout
// of the repository, since .gitignore is not consulted by `git add -f`. `what` names the bytes in
// the refusal ("measured data", "the failure report").
export function outsideCheckouts(
  value: string,
  repoRoot: string,
  what: string,
  refuse: (message: string) => never,
): string {
  const out = whereBytesLand(value, refuse);
  for (const root of repositoryRoots(repoRoot, refuse)) {
    if (isInside(root, out)) refuse(`refusing to write ${what} inside the repository: ${out}`);
  }
  return out;
}
