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

// A git binary that cannot be started surfaces as a thrown ENOENT, not as an exit code; both are
// the same refusal, never a stack trace.
function listCheckouts(repoRoot: string, refuse: (message: string) => never): string {
  const command = ["git", "-C", repoRoot, "worktree", "list", "--porcelain"];
  let git: Bun.ReadableSyncSubprocess;
  try {
    git = Bun.spawnSync(command, { stdin: "ignore", stdout: "pipe", stderr: "pipe" });
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    refuse(`cannot list the repository's checkouts: ${reason}`);
  }
  if (git.exitCode !== 0) {
    process.stderr.write(git.stderr.toString());
    refuse(`cannot list the repository's checkouts: git worktree list exited with ${git.exitCode}`);
  }
  return git.stdout.toString();
}

// Every checkout of one repository shares its history, so a commit from any of them publishes
// what lands there; git's own worktree list is the set of them. A bare entry has no working tree.
// A primary set up with --separate-git-dir is out of reach: git keeps no path back to it and lists
// its git dir in its place. No git answer, no known roots: refuse. Every root is canonicalized the
// way the output path is, so the two sides agree on a spelling (git prints forward slashes and
// the short name of a Windows temp directory).
function repositoryRoots(repoRoot: string, refuse: (message: string) => never): Set<string> {
  const roots = new Set([whereBytesLand(repoRoot, refuse)]);
  for (const entry of listCheckouts(repoRoot, refuse).split("\n\n")) {
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
