import {
  mkdirSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  writeFileSync,
} from "node:fs";
import { join, relative, resolve } from "node:path";
import { PassThrough } from "node:stream";
import { runList } from "../../src/commands/list.ts";
import { type CliDeps, main } from "../../src/commands/main.ts";
import { runRemove } from "../../src/commands/remove.ts";
import { ReportedMaximsError } from "../../src/commands/shared/errors.ts";
import { runSync } from "../../src/commands/sync.ts";
import type {
  Engine,
  EngineBundle,
  ListOptions,
  ListReport,
  RemoveOptions,
  SyncOptions,
  SyncReport,
} from "../../src/commands/types.ts";
import type { InteractiveStreams } from "../../src/console/contract.ts";
import type { HarnessId } from "../../src/contracts/harness-id.ts";
import type { SourceFrom } from "../../src/contracts/source.ts";
import type { HarnessDefinition } from "../../src/harnesses/contract.ts";
import { achievedTier, planHookOnly } from "../../src/harnesses/hook-writer.ts";
import type { FetchOptions, ResolverFor } from "../../src/sources/contract.ts";
import { hashFiles, readMemoryTree } from "../../src/sources/tree.ts";
import { ExitCode, MaximsError } from "../../src/util/exit-codes.ts";
import { assertInsideRoot, hashDirectory } from "../../src/util/fs.ts";
import { homePaths } from "../../src/util/home.ts";
import { withTempDir } from "../shared/temp_dir.ts";
import { FIXTURE_HARNESSES } from "./fixture-harnesses.ts";

export const FIXTURES = resolve(import.meta.dir, "..", "fixtures", "cli");

// A recording engine: the three runners record their options and answer with the report the
// scenario dictates, printing nothing (the real engine's own output is pinned by its own tests);
// the hook and tier probes answer from the scenario so `doctor` can be driven through both
// branches; the stub counts its starts and runs the sync it was handed.
export type FakeEngine = Engine & {
  calls: {
    sync: SyncOptions[];
    remove: RemoveOptions[];
    list: ListOptions[];
    mcpServe: number;
  };
};

export type ScenarioOptions = {
  tty?: boolean;
  stdinTty?: boolean;
  agent?: string | null;
  columns?: number;
  env?: Record<string, string>;
  project?: boolean;
  github?: Record<string, string>;
  // The registry the CLI runs against; the three fixture shapes unless a test names real ones.
  harnesses?: readonly HarnessDefinition[];
  syncReport?: Partial<
    Pick<
      SyncReport,
      "rules" | "tokens" | "fetched" | "held" | "upstreamChanges" | "failed" | "notices" | "plan"
    >
  >;
  listReport?: ListReport;
  hookMissing?: HarnessId[];
  // The reason a harness's tier probe could not read its config: tier 2 with that reason.
  tierUnreadable?: Partial<Record<HarnessId, string>>;
  // The refusal the engine's planner would raise for what a verb is about to install (a
  // collision, a cap, a byte budget): thrown, already reported, from every planning run.
  refuse?: { code: ExitCode; message: string };
  // Scripted prompt answers: the keystrokes to type once the interactive frame shows the prompt
  // whose message contains the key. Without this the CLI gets no interactive streams and every
  // prompt takes its silent branch.
  answers?: Record<string, string>;
  // The real engine over scripted resolvers, for a scenario that must see what a verb's sync
  // lands rather than what it asked for; the recording engine is unused then. Called the way the
  // bin calls it, so the run's rung sink reaches the resolvers it builds.
  loadEngine?: CliDeps["loadEngine"];
  // Every read of the clock answers noon on 2026-09-20 unless a scenario needs it to move.
  now?: () => Date;
};

export type Scenario = {
  root: string;
  home: string;
  userHome: string;
  cwd: string;
  projectRoot: string | null;
  engine: FakeEngine;
  fetches: SourceFrom[];
  options: ScenarioOptions;
};

export type RunResult = { code: number; stdout: string; stderr: string };

const EMPTY_LIST: ListReport = {
  sources: [],
  lockOnly: [],
  defaults: { agents: null, rule: false, cooldownDays: 7, ruleCap: 25 },
  notices: [],
};

export function fakeEngine(scenario: () => Scenario, options: ScenarioOptions): FakeEngine {
  const calls: FakeEngine["calls"] = { sync: [], remove: [], list: [], mcpServe: 0 };
  const report = (): SyncReport => ({
    sources: 1,
    memories: 1,
    rules: options.syncReport?.rules ?? 0,
    tokens: options.syncReport?.tokens ?? 0,
    fetched: options.syncReport?.fetched ?? [],
    held: options.syncReport?.held ?? [],
    heldFiles: [],
    upstreamChanges: options.syncReport?.upstreamChanges ?? {},
    failed: [...(options.syncReport?.failed ?? [])],
    changed: [],
    notices: [...(options.syncReport?.notices ?? [])],
    plan: options.syncReport?.plan ?? { changes: [], notices: [] },
  });
  const engine: FakeEngine = {
    calls,
    async runSync(syncOptions) {
      calls.sync.push(syncOptions);
      if (options.refuse !== undefined) {
        throw new ReportedMaximsError(options.refuse.code, options.refuse.message);
      }
      return report();
    },
    async runRemove(removeOptions) {
      calls.remove.push(removeOptions);
      return report();
    },
    async runList(listOptions) {
      calls.list.push(listOptions);
      return options.listReport ?? EMPTY_LIST;
    },
    async planHookAlone(def) {
      const missing = (options.hookMissing ?? []).includes(def.id);
      return missing
        ? {
            changes: [
              {
                kind: "write",
                path: assertInsideRoot(scenario().root, join(scenario().root, "hook")),
                content: "",
              },
            ],
          }
        : { changes: [] };
    },
    async achievedTier(def) {
      const unreadable = options.tierUnreadable?.[def.id];
      if (unreadable !== undefined) return { tier: 2, unreadable };
      return { tier: 1, unreadable: null };
    },
    async serveMcpStub(stubOptions) {
      calls.mcpServe += 1;
      await stubOptions.runSync();
    },
  };
  return engine;
}

// Resolvers over fixture directories: a github repo maps to the directory the scenario names, a
// local path is read as is, both walked the way the real fetch walks a source. Every fetch is
// recorded so a test can assert none happened. A remote reports a commit id cut from the tree
// hash, a local directory the tree hash itself, as the real resolvers do.
export function fixtureResolvers(scenario: () => Scenario): ResolverFor {
  const resolver = {
    async fetch(from: SourceFrom, opts: FetchOptions) {
      scenario().fetches.push(from);
      const dir = sourceDir(scenario(), from);
      const tree = await readMemoryTree(dir, opts, () => undefined);
      const treeSha = hashFiles(tree.files);
      const sha = from.type === "local" ? treeSha : treeSha.slice("sha256:".length, 47);
      return { sha, memoryPath: opts.memoryPath, files: tree.files };
    },
  };
  return (() => resolver) as ResolverFor;
}

function sourceDir(scenario: Scenario, from: SourceFrom): string {
  if (from.type === "local") return from.path;
  if (from.type === "git") {
    throw new MaximsError(ExitCode.SourceUnresolvable, `Failed to clone repository ${from.url}`);
  }
  const mapped = scenario.options.github?.[from.repo.toLowerCase()];
  if (mapped === undefined) {
    throw new MaximsError(ExitCode.SourceUnresolvable, `repository ${from.repo} was not found`);
  }
  return mapped;
}

export async function withScenario<T>(
  options: ScenarioOptions,
  fn: (scenario: Scenario) => Promise<T>,
): Promise<T> {
  return withTempDir(async (rawRoot) => {
    // Roots are recorded by their real path, so a scenario under a symlinked temp dir names them so.
    const root = realpathSync(rawRoot);
    const userHome = join(root, "user");
    const home = join(userHome, ".agents", "maxims");
    const cwd = join(root, "work");
    mkdirSync(home, { recursive: true });
    mkdirSync(cwd, { recursive: true });
    if (options.project === true) mkdirSync(join(cwd, ".git"));
    let scenario: Scenario;
    const engine = fakeEngine(() => scenario, options);
    scenario = {
      root,
      home,
      userHome,
      cwd,
      projectRoot: options.project === true ? cwd : null,
      engine,
      fetches: [],
      options,
    };
    return fn(scenario);
  });
}

export async function runCli(scenario: Scenario, argv: string[]): Promise<RunResult> {
  let stdout = "";
  let stderr = "";
  const answers = scenario.options.answers;
  const interactive =
    answers === undefined ? null : scriptedStreams(answers, (chunk) => (stdout += chunk));
  const bundle: EngineBundle = {
    engine: scenario.engine,
    harnesses: scenario.options.harnesses ?? FIXTURE_HARNESSES,
    resolvers: fixtureResolvers(() => scenario),
  };
  const deps: CliDeps = {
    loadEngine: scenario.options.loadEngine ?? (async () => bundle),
    io: {
      env: { HOME: scenario.userHome, MAXIMS_HOME: scenario.home, ...scenario.options.env },
      cwd: scenario.cwd,
      home: scenario.home,
      userHome: scenario.userHome,
      projectRoot: scenario.projectRoot,
      now: scenario.options.now ?? (() => new Date("2026-09-20T12:00:00.000Z")),
      stdin: new PassThrough(),
      stdout: { write: (chunk: string) => (stdout += chunk) },
      stderr: { write: (chunk: string) => (stderr += chunk) },
    },
    stdoutTty: { isTTY: scenario.options.tty === true, columns: scenario.options.columns ?? 80 },
    stdinTty: scenario.options.stdinTty ?? scenario.options.tty === true,
    interactive,
    detectAgent: async () => scenario.options.agent ?? null,
  };
  const code = await main(argv, deps);
  return { code, stdout, stderr };
}

// The real clack prompts read keypresses off any stream, so a scenario drives them through a
// pipe: each answer is written once the frame has rendered its prompt, which happens only after
// the prompt attached its listener, so no keystroke lands before anyone is reading. Clack wraps
// the message at the real terminal's width and draws a gutter on every line, so the match runs
// on the letters alone, whatever the width of the terminal the tests run in.
function scriptedStreams(
  answers: Record<string, string>,
  capture: (chunk: string) => void,
): InteractiveStreams {
  const input = new PassThrough();
  const output = new PassThrough();
  const pending = new Map(Object.entries(answers).map(([m, keys]) => [letters(m), keys]));
  let seen = "";
  output.on("data", (chunk: Buffer) => {
    const text = chunk.toString("utf8");
    capture(text);
    seen += letters(text);
    for (const [message, keys] of pending) {
      if (!seen.includes(message)) continue;
      pending.delete(message);
      setImmediate(() => input.write(keys));
    }
  });
  return { input, output };
}

const ANSI_ESCAPE = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*[A-Za-z]`, "g");

function letters(text: string): string {
  return text.replace(ANSI_ESCAPE, "").replace(/[^A-Za-z0-9]/g, "");
}

// Every regular file under a directory with its content hash, every symlink by name and target,
// and every directory by name, so a test can prove a failing verb created nothing anywhere under
// the home or the project, not even an empty folder.
export async function snapshot(dir: string): Promise<string> {
  const entries: string[] = [];
  const walk = (current: string): void => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const path = join(current, entry.name);
      if (entry.isSymbolicLink()) entries.push(`${relative(dir, path)}->${readlinkSync(path)}`);
      else if (entry.isDirectory()) {
        entries.push(`${relative(dir, path)}/`);
        walk(path);
      }
    }
  };
  walk(dir);
  return `${await hashDirectory(dir)}|${entries.sort().join(",")}`;
}

// The real engine's three runners and probes over the given resolvers and definitions: what the
// bin loads, minus the MCP stub, which no CLI scenario drives.
export function realEngineBundle(
  resolvers: ResolverFor,
  harnesses: readonly HarnessDefinition[] = FIXTURE_HARNESSES,
): EngineBundle {
  return {
    engine: {
      runSync,
      runRemove,
      runList,
      planHookAlone: (def, scope, ctx, wanted) => planHookOnly({ def, scope, ctx, wanted }),
      achievedTier,
      serveMcpStub: () => {
        throw new Error("no CLI scenario drives the MCP stub");
      },
    },
    harnesses,
    resolvers,
  };
}

// The last sync the fake engine recorded, or a thrown error: an assertion about an absent key on
// `calls.sync.at(-1)` would otherwise pass on a verb that never called sync at all.
export function lastSyncCall(scenario: Scenario): SyncOptions {
  const call = scenario.engine.calls.sync.at(-1);
  if (call === undefined) throw new Error("no sync call was recorded");
  return call;
}

export function writeState(scenario: Scenario, state: unknown): void {
  writeFileSync(homePaths(scenario.home).state, `${JSON.stringify(state, null, 2)}\n`);
}

export function readState(scenario: Scenario): Record<string, unknown> {
  return JSON.parse(readFileSync(homePaths(scenario.home).state, "utf8")) as Record<
    string,
    unknown
  >;
}

export function writeConfig(scenario: Scenario, config: unknown): void {
  writeFileSync(homePaths(scenario.home).config, `${JSON.stringify(config, null, 2)}\n`);
}
