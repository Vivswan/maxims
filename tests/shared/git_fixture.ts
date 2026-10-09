// Git on a fixture repository. The identity and the /dev/null config files come from the launcher's
// environment (scripts/run_tests.ts), which every test process inherits, so a fixture never differs
// by the machine it was made on; signing is switched off per call because a repository config
// could still turn it on. Only the exit code says whether a step succeeded: git's hints go to
// stderr and are not errors.
export function git(
  dir: string,
  args: readonly string[],
  env: Record<string, string> = {},
): string {
  const result = Bun.spawnSync(["git", "-C", dir, "-c", "commit.gpgsign=false", ...args], {
    env: { ...process.env, ...env },
    stdout: "pipe",
    stderr: "pipe",
  });
  if (result.exitCode !== 0) {
    throw new Error(`git ${args.join(" ")} in ${dir} exited ${result.exitCode}:\n${result.stderr}`);
  }
  return result.stdout.toString("utf8").trim();
}

export function gitInit(dir: string): void {
  git(dir, ["init", "--quiet", "--initial-branch", "main"]);
}

// Commits everything under `dir` and returns the new head's sha.
export function commitAll(dir: string, message: string, env: Record<string, string> = {}): string {
  git(dir, ["add", "--all"]);
  git(dir, ["commit", "--quiet", "--message", message], env);
  return git(dir, ["rev-parse", "HEAD"]);
}
