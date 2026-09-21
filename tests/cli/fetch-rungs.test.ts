// What would drift silently: the fetch ladder's per-rung reasons (which transport failed and
// why) dropped on the floor, so refresh.log records only the winning failure and a user whose gh
// login, git remote and API fallback all failed differently cannot see which one to fix; a rung
// line lost to the dry-run plan a verb draws before its real sync, or to a verb that fails before
// any sync runs; a rung line escaping to stdout or stderr, where the docs promise silence until a
// source is stale; or a rung line stamped when the verb ended instead of when it started.
import { expect, test } from "bun:test";
import { cpSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createEngine } from "../../src/commands/engine.ts";
import {
  exited,
  ghScript,
  httpResponse,
  type ScriptedRunner,
  scriptedGit,
  scriptedRunner,
} from "../../src/sources/github/fixtures/runner.ts";
import { homePaths } from "../../src/util/home.ts";
import {
  ADDED_AT,
  fetchedEntry,
  fetchedFacts,
  githubFrom,
  seedStore,
  stateWith,
  writeSource,
  writeState,
} from "../engine/harness.ts";
import { TWO_MEMORIES } from "../engine/world.ts";
import { type RunResult, runCli, type Scenario, withScenario } from "./harness.ts";

const FROM = githubFrom("a/b");
const KEY = "@a/b";
const SHA = "1".repeat(40);
const STAMP = "2026-09-20T12:00:00.000Z";
const ADD = ["add", KEY, "-g", "-a", "claude-code", "--auth", "-y"];

// gh answers 401, git says the repository is gone, the API fallback answers 404: three rungs,
// three reasons, and `auth` wins the recorded failure.
const RUNGS = [
  "gh api: HTTP 401: Bad credentials",
  "git ls-remote: fatal: repository 'https://github.com/a/b.git/' not found",
  "https://api.github.com/repos/a/b/commits/HEAD: HTTP 404",
];

function threeRungRunner(): ScriptedRunner {
  return scriptedRunner({
    exec: ghScript(() => exited(1, "", "HTTP 401: Bad credentials")),
    git: scriptedGit({
      lsRemote: () => ({
        kind: "failed",
        message: "fatal: repository 'https://github.com/a/b.git/' not found",
      }),
    }),
    fetch: () => httpResponse(404),
  });
}

// gh is logged in but refused on both calls the ladder makes (the ref, then the tarball) and git
// answers each time: a rung reason per refused call beside a fetch that succeeded.
const GH_DENIED = {
  commits: "gh api: HTTP 401: Bad credentials",
  tarball: "gh api: HTTP 401: Requires authentication",
};

function ghDeniedGitAnswers(upstream: string): ScriptedRunner {
  return scriptedRunner({
    exec: ghScript((args) =>
      exited(
        1,
        "",
        args.some((arg) => arg.includes("/tarball/"))
          ? "HTTP 401: Requires authentication"
          : "HTTP 401: Bad credentials",
      ),
    ),
    git: scriptedGit({
      lsRemote: () => ({ kind: "ok", value: `${SHA}\tHEAD\n` }),
      shallowClone: (_url, _ref, dir) => {
        cpSync(upstream, dir, { recursive: true });
        return { kind: "ok", value: SHA };
      },
    }),
  });
}

function useRealEngine(scenario: Scenario, runner: ScriptedRunner): void {
  const env = { HOME: scenario.userHome, MAXIMS_HOME: scenario.home };
  scenario.options.loadEngine = (options) => createEngine({ ...options, env, runner });
}

async function installedSource(scenario: Scenario): Promise<string> {
  const upstream = writeSource(join(scenario.root, "upstream"), TWO_MEMORIES);
  const facts = await fetchedFacts(upstream, ADDED_AT);
  writeState(scenario.home, stateWith({ [KEY]: fetchedEntry(FROM, facts, { auth: true }) }));
  seedStore(scenario.home, FROM, upstream);
  return upstream;
}

function writeManifest(scenario: Scenario): void {
  mkdirSync(join(scenario.cwd, ".agents"), { recursive: true });
  writeFileSync(
    join(scenario.cwd, ".agents", "maxims.lock"),
    JSON.stringify({
      version: 1,
      sources: {
        [KEY]: {
          from: { type: "github", repo: "a/b" },
          select: "*",
          rule: true,
          harnesses: ["claude-code"],
          auth: true,
        },
      },
    }),
  );
}

// `throwIfNoEntry` answers undefined for "nothing is there" alone; any other trouble throws.
function logOf(scenario: Scenario): string | null {
  const path = homePaths(scenario.home).log;
  if (statSync(path, { throwIfNoEntry: false }) === undefined) return null;
  return readFileSync(path, "utf8");
}

function occurrences(text: string, needle: string): number {
  return text.split(needle).length - 1;
}

// The engine's own warning sink writes to the process stream, not the captured one, so a rung
// line printed there would pass a check of the captured stderr alone.
async function runCapturingProcessStderr(
  scenario: Scenario,
  argv: string[],
): Promise<RunResult & { processStderr: string }> {
  let processStderr = "";
  const write = process.stderr.write.bind(process.stderr);
  process.stderr.write = ((chunk: string | Uint8Array) => {
    processStderr += typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8");
    return true;
  }) as typeof process.stderr.write;
  try {
    return { ...(await runCli(scenario, argv)), processStderr };
  } finally {
    process.stderr.write = write;
  }
}

function expectSilent(run: RunResult & { processStderr: string }, code: number): void {
  expect({ code: run.code, stderr: run.stderr, processStderr: run.processStderr }).toEqual({
    code,
    stderr: "",
    processStderr: "",
  });
  for (const rung of [...RUNGS, ...Object.values(GH_DENIED)]) {
    expect(run.stdout).not.toContain(rung);
  }
}

type FailingRow = { argv: string[]; code: number; mode: string };

const failingRows: FailingRow[] = [
  { argv: ["sync"], code: 2, mode: "sync" },
  { argv: ["sync", "--quiet"], code: 0, mode: "sync --quiet" },
];

test.each(failingRows)(
  "$mode over a fetch that fails on three rungs logs every rung's reason and prints none",
  async ({ argv, code, mode }) => {
    await withScenario({}, async (scenario) => {
      await installedSource(scenario);
      useRealEngine(scenario, threeRungRunner());
      const run = await runCapturingProcessStderr(scenario, argv);
      expectSilent(run, code);
      const log = logOf(scenario) ?? "";
      expect(log).toContain(`${STAMP} ${mode}: ${KEY}: fetch failed (auth): ${RUNGS[0]}\n`);
      for (const rung of RUNGS)
        expect(occurrences(log, `${STAMP} ${mode}: fetch rung failed: ${rung}\n`)).toBe(1);
    });
  },
);

// `add` and `install` plan with a dry-run sync before their real one; `update` and `sync` run
// the real one alone. Each rung reason lands once, under the verb's own label, whatever the verb
// ran before its sync.
type SucceedingRow = {
  mode: string;
  argv: string[];
  project: boolean;
  setup: (scenario: Scenario) => Promise<string>;
};

const succeedingRows: SucceedingRow[] = [
  {
    mode: "add",
    argv: ADD,
    project: false,
    setup: async (scenario) => writeSource(join(scenario.root, "upstream"), TWO_MEMORIES),
  },
  {
    mode: "install",
    argv: ["install", "-y"],
    project: true,
    setup: async (scenario) => {
      writeManifest(scenario);
      mkdirSync(join(scenario.cwd, ".claude"));
      return writeSource(join(scenario.root, "upstream"), TWO_MEMORIES);
    },
  },
  { mode: "update", argv: ["update"], project: false, setup: installedSource },
  { mode: "sync", argv: ["sync"], project: false, setup: installedSource },
];

test.each(succeedingRows)(
  "$mode over a fetch gh refused and git answered logs each refusal once",
  async ({ mode, argv, project, setup }) => {
    await withScenario({ project }, async (scenario) => {
      const upstream = await setup(scenario);
      const runner = ghDeniedGitAnswers(upstream);
      useRealEngine(scenario, runner);
      const run = await runCapturingProcessStderr(scenario, argv);
      expectSilent(run, 0);
      const log = logOf(scenario) ?? "";
      // One line per refused call, whose count the runner saw: a verb whose sync resolves the
      // ref to see whether a fetch is due, then again inside the fetch, is refused twice there.
      for (const [call, rung] of Object.entries(GH_DENIED)) {
        const refused = runner.calls.filter(
          (line) => line.startsWith("exec gh api") && line.includes(`/${call}/`),
        ).length;
        expect(refused).toBeGreaterThanOrEqual(1);
        expect(occurrences(log, `${STAMP} ${mode}: fetch rung failed: ${rung}\n`)).toBe(refused);
      }
    });
  },
);

// A verb that fails before any sync runs still owes the log its rung reasons; the terminal gets
// the one failure line it always got.
test("add over a fetch that fails on three rungs logs every reason and exits 2", async () => {
  await withScenario({}, async (scenario) => {
    useRealEngine(scenario, threeRungRunner());
    const run = await runCapturingProcessStderr(scenario, ADD);
    expect({ code: run.code, processStderr: run.processStderr }).toEqual({
      code: 2,
      processStderr: "",
    });
    expect(run.stderr).toBe(` ERROR  cannot fetch https://github.com/a/b.git: ${RUNGS[0]}\n`);
    for (const rung of RUNGS.slice(1)) {
      expect(run.stdout).not.toContain(rung);
      expect(run.stderr).not.toContain(rung);
    }
    const log = logOf(scenario) ?? "";
    for (const rung of RUNGS)
      expect(occurrences(log, `${STAMP} add: fetch rung failed: ${rung}\n`)).toBe(1);
  });
});

// A preview writes nothing, the rung lines included: the fetch still climbs the ladder and gh
// still refuses, but the diagnostics go where every other line of a preview goes, nowhere.
test.each(["--dry-run", "--list"])(
  "add %s over a fetch gh refused leaves no log behind",
  async (flag) => {
    await withScenario({}, async (scenario) => {
      const upstream = writeSource(join(scenario.root, "upstream"), TWO_MEMORIES);
      const runner = ghDeniedGitAnswers(upstream);
      useRealEngine(scenario, runner);
      const run = await runCli(scenario, [...ADD, flag]);
      expect({ code: run.code, stderr: run.stderr }).toEqual({ code: 0, stderr: "" });
      expect(runner.calls.some((call) => call.startsWith("exec gh api"))).toBe(true);
      expect(runner.calls.some((call) => call.startsWith("git clone"))).toBe(true);
      expect(logOf(scenario)).toBeNull();
    });
  },
);

// The rung lines carry the stamp the run started with. A clock read after the run would stamp
// them later than the sync's own line about the same fetch, as if the reasons arrived after it.
test("rung lines are stamped with the run's start, not the clock at flush", async () => {
  await withScenario({}, async (scenario) => {
    let tick = 0;
    scenario.options.now = () => new Date(Date.parse(STAMP) + 1000 * tick++);
    await installedSource(scenario);
    useRealEngine(scenario, threeRungRunner());
    const run = await runCli(scenario, ["sync"]);
    expect(run.code).toBe(2);
    const lines = (logOf(scenario) ?? "").split("\n").filter((line) => line !== "");
    const stampOf = (line: string): string => line.slice(0, STAMP.length);
    const rungLines = lines.filter((line) => line.includes(": fetch rung failed: "));
    const [failureLine] = lines.filter((line) => line.includes(": fetch failed (auth): "));
    expect(rungLines).toHaveLength(RUNGS.length);
    expect(failureLine).toBeDefined();
    const earliest = lines.map(stampOf).sort()[0];
    for (const line of rungLines) expect(stampOf(line)).toBe(earliest ?? "");
    expect(stampOf(failureLine ?? "") > (earliest ?? "")).toBe(true);
  });
});
