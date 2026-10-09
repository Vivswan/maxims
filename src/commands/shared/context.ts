import { existsSync, realpathSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import type { HarnessId } from "../../contracts/harness-id.ts";
import type { HarnessContext } from "../../harnesses/contract.ts";
import { DEFAULT_RULE_CAP } from "../../rulefile/budget.ts";
import { readUserConfig, type UserConfig } from "../../state/config.ts";
import type { SourceEntry } from "../../state/schema.ts";
import { type HomePaths, homePaths, maximsHome } from "../../util/home.ts";
import type { EngineIo, HarnessFilter } from "../types.ts";
import { classifyInvoker, type InvokerClassification, stdoutVariantFor } from "./stdin.ts";

export const DEFAULT_COOLDOWN_DAYS = 7;

// `home` is the maxims home (state, store, log); `userHome` is the user's own, which the harness
// definitions resolve their files against. `configIssue` is the notice an engine verb prints when
// config.json could not be read as one: the engine always runs on the defaults then, since the
// session-start hook is one of its callers and must refresh whatever a preference file holds;
// the verbs that refuse the file instead do so at the command line, before the engine runs.
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
  const paths = homePaths(home);
  const invoker = classifyInvoker(options.readHookStdin ? await io.readStdin() : null);
  const startDir =
    invoker.kind === "harness" && invoker.startDir !== null ? invoker.startDir : io.cwd;
  const loaded =
    options.config === undefined
      ? readUserConfig(paths.config)
      : { config: options.config, issue: null };
  return {
    home,
    userHome: io.userHome,
    paths,
    env: io.env,
    cwd: io.cwd,
    projectRoot: findProjectRoot(startDir),
    config: loaded.config,
    configIssue: loaded.issue === null ? null : `${loaded.issue}; using defaults`,
    cooldownDays: loaded.config.cooldownDays ?? DEFAULT_COOLDOWN_DAYS,
    ruleCap: loaded.config.ruleCap ?? DEFAULT_RULE_CAP,
    invoker,
    stdoutVariant: stdoutVariantFor(invoker, io.harnesses),
    now: io.now(),
  };
}

// The nearest ancestor holding `.git` (a directory, or the file a worktree or submodule leaves),
// by its real path: state records a project by that path, and a session started through an
// alias symlink must find the same entries.
export function findProjectRoot(startDir: string): string | null {
  let dir = resolve(startDir);
  for (;;) {
    if (existsSync(join(dir, ".git"))) return realpathSync(dir);
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

// A project-scope entry belongs to the project whose root it recorded; a run acts on it only from
// that project, so two checkouts holding one source never write into each other, and the names,
// collisions and lookups a run judges are those of the entries it acts on.
export function actsHere(entry: SourceEntry, ctx: { projectRoot: string | null }): boolean {
  const { destination } = entry.intent;
  return destination.scope !== "project" || destination.root === ctx.projectRoot;
}

export function agentsAllowed(filter: HarnessFilter | undefined, id: HarnessId): boolean {
  return filter === undefined || filter.includes(id);
}

// What a harness definition resolves its files against, from the engine's context or the command
// line's io alike: both carry the user's home and the project root the run acts in.
export function harnessContext(
  ctx: Pick<EngineContext, "userHome" | "projectRoot" | "env">,
): HarnessContext {
  return { home: ctx.userHome, projectRoot: ctx.projectRoot, env: ctx.env };
}
