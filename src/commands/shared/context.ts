import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import type { HarnessContext, HarnessId } from "../../harnesses/contract.ts";
import { DEFAULT_RULE_CAP } from "../../rulefile/budget.ts";
import { parseUserConfig, type UserConfig } from "../../state/config.ts";
import { type HomePaths, homePaths, maximsHome } from "../../util/home.ts";
import type { EngineIo, HarnessFilter } from "../types.ts";
import { classifyInvoker, type InvokerClassification, stdoutVariantFor } from "./stdin.ts";

export const DEFAULT_COOLDOWN_DAYS = 7;

// `home` is the maxims home (state, store, log); `userHome` is the user's own, which the harness
// definitions resolve their files against.
export type EngineContext = {
  home: string;
  userHome: string;
  paths: HomePaths;
  env: Record<string, string | undefined>;
  cwd: string;
  projectRoot: string | null;
  config: UserConfig;
  configIssue: string | null;
  cooldownDays: number;
  ruleCap: number;
  invoker: InvokerClassification;
  stdoutVariant: ReturnType<typeof stdoutVariantFor>;
  now: Date;
};

// `config` stands in for the file on disk: a dry run whose caller would have written the config
// first plans against what it would have held.
export type LoadContextOptions = {
  readHookStdin: boolean;
  config?: UserConfig;
};

// The hook command carries no arguments, so the stdin payload is how a hook run learns who called
// and from where; an interactive run never reads stdin and starts from the process cwd.
export async function loadContext(
  io: EngineIo,
  options: LoadContextOptions,
): Promise<EngineContext> {
  const home = maximsHome(io.env);
  const userHome = io.env.HOME ?? io.env.USERPROFILE ?? homedir();
  const paths = homePaths(home);
  const invoker = classifyInvoker(options.readHookStdin ? await io.readStdin() : null);
  const startDir =
    invoker.kind === "harness" && invoker.startDir !== null ? invoker.startDir : io.cwd;
  const loaded =
    options.config === undefined
      ? loadUserConfig(paths.config)
      : { config: options.config, issue: null };
  return {
    home,
    userHome,
    paths,
    env: io.env,
    cwd: io.cwd,
    projectRoot: findProjectRoot(startDir),
    config: loaded.config,
    configIssue: loaded.issue,
    cooldownDays: loaded.config.cooldownDays ?? DEFAULT_COOLDOWN_DAYS,
    ruleCap: loaded.config.ruleCap ?? DEFAULT_RULE_CAP,
    invoker,
    stdoutVariant: stdoutVariantFor(invoker, io.harnesses),
    now: io.now(),
  };
}

// The nearest ancestor holding `.git` (a directory, or the file a worktree or submodule leaves).
export function findProjectRoot(startDir: string): string | null {
  let dir = resolve(startDir);
  for (;;) {
    if (existsSync(join(dir, ".git"))) return dir;
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

type LoadedUserConfig = { config: UserConfig; issue: string | null };

// An unreadable config is a notice and the defaults, never a stop: a typo in a preference file
// must not keep a session start from refreshing rules.
function loadUserConfig(path: string): LoadedUserConfig {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      return { config: {}, issue: null };
    }
    const detail = error instanceof Error ? error.message : String(error);
    return { config: {}, issue: `${path} could not be read (${detail}); using defaults` };
  }
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    return { config: {}, issue: `${path} is not valid JSON (${detail}); using defaults` };
  }
  const parsed = parseUserConfig(json);
  if (parsed.ok) return { config: parsed.config, issue: null };
  return { config: {}, issue: `${path}: ${parsed.issues.join("; ")}; using defaults` };
}

export function agentsAllowed(filter: HarnessFilter | undefined, id: HarnessId): boolean {
  return filter === undefined || filter.includes(id);
}

export function harnessContext(ctx: EngineContext): HarnessContext {
  return { home: ctx.userHome, projectRoot: ctx.projectRoot, env: ctx.env };
}
