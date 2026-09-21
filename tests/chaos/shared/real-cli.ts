// The command line driven in-process over the REAL engine (the sync planner, the harness registry,
// the fetch ladder), with only the network scripted: the ladder's HTTP, `gh` and git calls answer
// as the row dictates, and every call is recorded so a row can prove which rungs ran.
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { createEngine } from "../../../src/commands/engine.ts";
import { type CliDeps, main } from "../../../src/commands/main.ts";
import { createResolvers } from "../../../src/commands/shared/resolvers.ts";
import type { EngineBundle } from "../../../src/commands/types.ts";
import {
  type ScriptedRunner,
  scriptedRunner,
} from "../../../src/sources/github/fixtures/runner.ts";
import { withTempDir } from "../../shared/temp_dir.ts";

export type RealWorld = {
  dir: string;
  userHome: string;
  maximsHome: string;
  cwd: string;
  projectRoot: string | null;
  runner: ScriptedRunner;
  // Resolver warnings, the lines an interactive run would print as `maxims: ...` on stderr, and
  // the rung diagnostics the bin keeps off it.
  warnings: string[];
  rungs: string[];
  clock: { now: Date };
};

export type RealWorldOptions = {
  runner?: ScriptedRunner;
  project?: boolean;
  now?: Date;
};

export type RunResult = { code: number; stdout: string; stderr: string };

const NOW = new Date("2026-09-20T12:00:00.000Z");

// A user home holding the maxims home, and beside it either a plain working directory or a git
// checkout, so a project-scoped verb finds its root.
export async function withRealWorld<T>(
  options: RealWorldOptions,
  fn: (world: RealWorld) => Promise<T>,
): Promise<T> {
  return withTempDir(async (dir) => {
    const userHome = join(dir, "home");
    const maximsHome = join(userHome, ".agents", "maxims");
    const cwd = join(dir, options.project === true ? "project" : "work");
    mkdirSync(maximsHome, { recursive: true });
    mkdirSync(cwd, { recursive: true });
    if (options.project === true) mkdirSync(join(cwd, ".git"));
    return fn({
      dir,
      userHome,
      maximsHome,
      cwd,
      projectRoot: options.project === true ? cwd : null,
      runner: options.runner ?? scriptedRunner(),
      warnings: [],
      rungs: [],
      clock: { now: options.now ?? NOW },
    });
  });
}

export function envOf(world: RealWorld): Record<string, string> {
  return { HOME: world.userHome, MAXIMS_HOME: world.maximsHome, PATH: process.env.PATH ?? "" };
}

// `stdin` is the hook payload a quiet run may read; absent, the stream ends at once so the run
// takes its no-payload branch instead of waiting out the read timeout.
export async function runReal(
  world: RealWorld,
  argv: string[],
  options: { stdin?: string } = {},
): Promise<RunResult> {
  let stdout = "";
  let stderr = "";
  const env = envOf(world);
  const stdin = new PassThrough();
  stdin.end(options.stdin ?? "");
  const deps: CliDeps = {
    loadEngine: async ({ quiet, rung }): Promise<EngineBundle> => {
      const bundle = await createEngine({ quiet, rung, env, runner: world.runner });
      return {
        ...bundle,
        resolvers: createResolvers({
          warn: (line) => world.warnings.push(line),
          rung: (line) => world.rungs.push(line),
          env,
          runner: world.runner,
        }),
      };
    },
    io: {
      env,
      cwd: world.cwd,
      home: world.maximsHome,
      userHome: world.userHome,
      projectRoot: world.projectRoot,
      now: () => world.clock.now,
      stdin,
      stdout: { write: (chunk: string) => (stdout += chunk) },
      stderr: { write: (chunk: string) => (stderr += chunk) },
    },
    stdoutTty: { isTTY: false, columns: 80 },
    stdinTty: false,
    interactive: null,
    detectAgent: async () => null,
  };
  const code = await main(argv, deps);
  return { code, stdout, stderr };
}

export function advanceClock(world: RealWorld, ms: number): void {
  world.clock.now = new Date(world.clock.now.getTime() + ms);
}

export const DAY_MS = 24 * 60 * 60 * 1000;
