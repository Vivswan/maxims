import { mkdirSync, readdirSync, readFileSync, readlinkSync, writeFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { PassThrough } from "node:stream";
import { type CliDeps, main } from "../../src/commands/main.ts";
import type {
  DisabledEdit,
  Engine,
  EngineBundle,
  ListOptions,
  RemoveOptions,
  ResolveIncomingInput,
  ResolveIncomingOutcome,
  RuleBlock,
  SyncOptions,
  SyncReport,
} from "../../src/commands/types.ts";
import type { HarnessId } from "../../src/harnesses/contract.ts";
import { type MemoryName, parseMemoryName } from "../../src/memory/contract.ts";
import type { FetchOptions, ResolverFor, SourceFrom } from "../../src/sources/contract.ts";
import type { Change } from "../../src/util/change.ts";
import { ExitCode, MaximsError } from "../../src/util/exit-codes.ts";
import { assertInsideRoot, hashDirectory } from "../../src/util/fs.ts";
import { homePaths, storePathFor } from "../../src/util/home.ts";
import { withTempDir } from "../shared/temp_dir.ts";
import { FIXTURE_HARNESSES } from "./fixture-harnesses.ts";

export const FIXTURES = resolve(import.meta.dir, "..", "fixtures", "cli");

// A recording engine: `runSync`, `runRemove`, `runList` and the disabled-list edit record their
// options and answer with the report the scenario dictates; `planStoreEntry` and
// `resolveIncoming` implement the contract for real over the fixture data, because `add` and the
// exit-family tests depend on their outcomes, not merely on their having been called.
export type FakeEngine = Engine & {
  calls: {
    sync: SyncOptions[];
    remove: RemoveOptions[];
    list: ListOptions[];
    disabled: DisabledEdit[];
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
  syncReport?: Partial<
    Pick<SyncReport, "rules" | "tokens" | "fetched" | "failed" | "changed" | "notices">
  >;
  hookMissing?: HarnessId[];
  tier2?: HarnessId[];
  disabledChanged?: boolean;
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

export function fakeEngine(scenario: () => Scenario, options: ScenarioOptions): FakeEngine {
  const calls: FakeEngine["calls"] = { sync: [], remove: [], list: [], disabled: [], mcpServe: 0 };
  const engine: FakeEngine = {
    calls,
    async runSync(syncOptions) {
      calls.sync.push(syncOptions);
      return {
        sources: 1,
        rules: options.syncReport?.rules ?? 0,
        tokens: options.syncReport?.tokens ?? 0,
        fetched: options.syncReport?.fetched ?? [],
        failed: [...(options.syncReport?.failed ?? [])],
        changed: options.syncReport?.changed ?? [],
        notices: [...(options.syncReport?.notices ?? [])],
        plan: { changes: [], notices: [] },
      };
    },
    async runRemove(removeOptions) {
      calls.remove.push(removeOptions);
      return {
        removed: [describeTarget(removeOptions)],
        notices: [],
        plan: { changes: [], notices: [] },
      };
    },
    async runList(listOptions) {
      calls.list.push(listOptions);
      return { sources: [] };
    },
    planStoreEntry(from, home, files) {
      const entry = assertInsideRoot(homePaths(home).store, storePathFor(home, from));
      const changes: Change[] = [{ kind: "delete", path: entry }];
      if (from.type === "local" && from.live === true) {
        changes.push({ kind: "symlink", path: entry, target: from.path });
        return changes;
      }
      changes.push({ kind: "mkdir", path: entry });
      for (const file of files) {
        changes.push({
          kind: "write",
          path: assertInsideRoot(entry, join(entry, file.relPath)),
          content: file.text,
        });
      }
      return changes;
    },
    resolveIncoming: resolveIncomingForReal,
    async planHookWrite(input) {
      const missing = (options.hookMissing ?? []).includes(input.def.id);
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
      return (options.tier2 ?? []).includes(def.id) ? 2 : 1;
    },
    parseRuleFile: parseFixtureRuleFile,
    async editDisabled(edit) {
      calls.disabled.push(edit);
      const state =
        edit.base ??
        (JSON.parse(
          readFileSync(homePaths(scenario().home).state, "utf8"),
        ) as import("../../src/state/schema.ts").State);
      const path = assertInsideRoot(scenario().home, homePaths(scenario().home).state);
      return {
        changed: options.disabledChanged ?? true,
        state,
        changes: [{ kind: "write", path, content: JSON.stringify(state) }],
      };
    },
    async serveMcpStub(stubOptions) {
      calls.mcpServe += 1;
      await stubOptions.runSync();
    },
  };
  return engine;
}

// The fixture block grammar: `<!-- maxims:<key> -->`, one `- <name>` per rule line, `<!-- /maxims -->`.
export function parseFixtureRuleFile(text: string): RuleBlock[] {
  const blocks: RuleBlock[] = [];
  let current: RuleBlock | null = null;
  for (const line of text.split("\n")) {
    const open = /^<!-- maxims:(\S+) -->$/.exec(line);
    if (open !== null && open[1] !== undefined) {
      current = { source: open[1], names: [] };
      continue;
    }
    if (line === "<!-- /maxims -->" && current !== null) {
      blocks.push(current);
      current = null;
      continue;
    }
    const rule = /^- ([a-z0-9-]+)/.exec(line);
    const name = rule?.[1] === undefined ? null : parseMemoryName(rule[1]);
    if (current !== null && name !== null) current.names.push(name);
  }
  return blocks;
}

function describeTarget(options: RemoveOptions): string {
  const target = options.target;
  return target.kind === "all" ? "*" : target.kind === "source" ? target.key : target.name;
}

// The dedupe contract over the fixture data: installation order owns a name, a rename moves the
// incoming memory under its local name, a name another source owns collides, and the survivors
// are counted against the cap.
export function resolveIncomingForReal(input: ResolveIncomingInput): ResolveIncomingOutcome {
  const index = new Map<string, string>();
  const ordered = [...input.installed].sort(
    (a, b) => Date.parse(a.addedAt) - Date.parse(b.addedAt) || (a.key < b.key ? -1 : 1),
  );
  for (const source of ordered) {
    for (const name of source.names) {
      if (source.intent.select !== "*" && !source.intent.select.includes(name)) continue;
      const local = Object.hasOwn(source.intent.rename, name) ? source.intent.rename[name] : name;
      if (local !== undefined && !index.has(local)) index.set(local, source.key);
    }
  }
  const collisions: { name: MemoryName; ownedBy: string }[] = [];
  const names: MemoryName[] = [];
  for (const memory of input.memories) {
    if (input.select !== "*" && !input.select.includes(memory.name)) continue;
    const local = Object.hasOwn(input.rename, memory.name)
      ? input.rename[memory.name]
      : memory.name;
    if (local === undefined) continue;
    const owner = index.get(local);
    if (owner !== undefined && owner !== input.source)
      collisions.push({ name: local, ownedBy: owner });
    else names.push(local);
  }
  if (collisions.length > 0) return { ok: false, code: ExitCode.NameCollision, collisions };
  if (names.length > input.cap) {
    return {
      ok: false,
      code: ExitCode.RuleCapExceeded,
      count: names.length,
      cap: input.cap,
      hint: `narrow the source with --memory <name>..., or raise the cap (currently ${input.cap})`,
    };
  }
  return { ok: true, names: names.sort() };
}

// Resolvers over fixture directories: a github repo maps to the directory the scenario names, a
// local path is read as is. Every fetch is recorded so a test can assert none happened.
export function fixtureResolvers(scenario: () => Scenario): ResolverFor {
  const resolver = {
    async fetch(from: SourceFrom, opts: FetchOptions) {
      scenario().fetches.push(from);
      const dir = sourceDir(scenario(), from);
      const memoriesDir = join(dir, opts.memoryPath);
      let names: string[];
      try {
        names = readdirSync(memoriesDir).sort();
      } catch {
        throw new MaximsError(
          ExitCode.SourceUnresolvable,
          `Local path does not exist: ${memoriesDir}`,
        );
      }
      const files = names
        .filter((name) => name.endsWith(".md"))
        .map((name) => ({
          relPath: join(opts.memoryPath, name),
          text: readFileSync(join(memoriesDir, name), "utf8"),
        }));
      const count = String(names.length).padStart(2, "0");
      const sha =
        from.type === "local" ? `sha256:${"0".repeat(62)}${count}` : `${"0".repeat(38)}${count}`;
      return { sha, memoryPath: opts.memoryPath, files };
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
  return withTempDir(async (root) => {
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
  const bundle: EngineBundle = {
    engine: scenario.engine,
    harnesses: FIXTURE_HARNESSES,
    resolvers: fixtureResolvers(() => scenario),
  };
  const deps: CliDeps = {
    loadEngine: async () => bundle,
    io: {
      env: { HOME: scenario.userHome, MAXIMS_HOME: scenario.home, ...scenario.options.env },
      cwd: scenario.cwd,
      home: scenario.home,
      userHome: scenario.userHome,
      projectRoot: scenario.projectRoot,
      now: () => new Date("2026-09-20T12:00:00.000Z"),
      stdin: new PassThrough(),
      stdout: { write: (chunk: string) => (stdout += chunk) },
      stderr: { write: (chunk: string) => (stderr += chunk) },
    },
    stdoutTty: { isTTY: scenario.options.tty === true, columns: scenario.options.columns ?? 80 },
    stdinTty: scenario.options.stdinTty ?? scenario.options.tty === true,
    interactive: null,
    detectAgent: async () => scenario.options.agent ?? null,
  };
  const code = await main(argv, deps);
  return { code, stdout, stderr };
}

// Every regular file under a directory with its content hash, plus every symlink by name and
// target, so a test can prove a failing verb wrote nothing anywhere under the home or the project.
export async function snapshot(dir: string): Promise<string> {
  const links: string[] = [];
  const walk = (current: string): void => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const path = join(current, entry.name);
      if (entry.isSymbolicLink()) links.push(`${relative(dir, path)}->${readlinkSync(path)}`);
      else if (entry.isDirectory()) walk(path);
    }
  };
  walk(dir);
  return `${await hashDirectory(dir)}|${links.sort().join(",")}`;
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
