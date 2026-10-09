import { isGitEnvKey } from "@simple-git/argv-parser";
import { type SimpleGit, simpleGit } from "simple-git";

// A fixture command silent for this long is killed, and the failure names the command.
const FIXTURE_GIT_STALL_MS = 20_000;

// The launcher's commit identity and its config isolation (scripts/run_tests.ts) travel in these
// variables, which simple-git refuses or drops unless they are named. Signing is switched off per
// call because a repository config could still turn it on.
const LAUNCHER_GIT_ENV = [
  "GIT_AUTHOR_NAME",
  "GIT_AUTHOR_EMAIL",
  "GIT_COMMITTER_NAME",
  "GIT_COMMITTER_EMAIL",
  "GIT_CONFIG_GLOBAL",
  "GIT_CONFIG_SYSTEM",
];

// simple-git checks an explicit `.env()` strictly: a guarded variable (any `GIT_*`, plus the keys
// `isGitEnvKey` names, EDITOR and PAGER among them) fails the command unless `allowEnvironment`
// lists it, so the ambient ones a developer shell exports are dropped here first. Only the exit
// code says whether a step succeeded: git's hints go to stderr and are not errors.
function fixtureGit(dir: string, env: Record<string, string>): SimpleGit {
  const allowEnvironment = [...LAUNCHER_GIT_ENV, ...Object.keys(env)];
  const allowed = new Set(allowEnvironment.map((key) => key.toLowerCase()));
  const child: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    const normalized = key.toLowerCase();
    const guarded = normalized.startsWith("git_") || isGitEnvKey(normalized);
    if (value === undefined || (guarded && !allowed.has(normalized))) continue;
    child[key] = value;
  }
  return simpleGit({
    baseDir: dir,
    config: ["commit.gpgsign=false"],
    timeout: { block: FIXTURE_GIT_STALL_MS },
    allowEnvironment,
    unsafe: { allowUnsafeConfigPaths: true },
    errors: (error, result) =>
      error ??
      (result.exitCode === 0
        ? undefined
        : new Error(`git in ${dir} exited ${result.exitCode}:\n${Buffer.concat(result.stdErr)}`)),
  }).env({ ...child, ...env });
}

export async function git(
  dir: string,
  args: readonly string[],
  env: Record<string, string> = {},
): Promise<string> {
  return (await fixtureGit(dir, env).raw([...args])).trim();
}

export async function gitInit(dir: string): Promise<void> {
  await git(dir, ["init", "--quiet", "--initial-branch", "main"]);
}

// Commits everything under `dir` and returns the new head's sha.
export async function commitAll(
  dir: string,
  message: string,
  env: Record<string, string> = {},
): Promise<string> {
  await git(dir, ["add", "--all"]);
  await git(dir, ["commit", "--quiet", "--message", message], env);
  return git(dir, ["rev-parse", "HEAD"]);
}
