// What would drift silently: the fetch ladder's per-rung reasons (which transport failed and
// why) dropped on the floor, so refresh.log records only the winning failure and a user whose gh
// login, git remote and API fallback all failed differently cannot see which one to fix; or a
// rung line escaping to stdout or stderr, where the docs promise silence until a source is stale.
import { expect, test } from "bun:test";
import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { createEngine } from "../../src/commands/engine.ts";
import {
  exited,
  ghScript,
  httpResponse,
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

// gh answers 401, git says the repository is gone, the API fallback answers 404: three rungs,
// three reasons, and `auth` wins the recorded failure.
const RUNGS = [
  "gh api: HTTP 401: Bad credentials",
  "git ls-remote: fatal: repository 'https://github.com/a/b.git/' not found",
  "https://api.github.com/repos/a/b/commits/HEAD: HTTP 404",
];

function threeRungRunner() {
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

type Row = { argv: string[]; code: number; mode: string; quiet: boolean };

const rows: Row[] = [
  { argv: ["sync"], code: 2, mode: "sync", quiet: false },
  { argv: ["sync", "--quiet"], code: 0, mode: "sync --quiet", quiet: true },
];

test.each(rows)(
  "$mode over a fetch that fails on three rungs logs every rung's reason and prints none",
  async ({ argv, code, mode, quiet }) => {
    await withScenario({}, async (scenario) => {
      const upstream = writeSource(join(scenario.root, "upstream"), TWO_MEMORIES);
      const facts = await fetchedFacts(upstream, ADDED_AT);
      writeState(scenario.home, stateWith({ [KEY]: fetchedEntry(FROM, facts, { auth: true }) }));
      seedStore(scenario.home, FROM, upstream);
      const env = { HOME: scenario.userHome, MAXIMS_HOME: scenario.home };
      scenario.options.bundle = await createEngine({ quiet, env, runner: threeRungRunner() });
      const run = await runCapturingProcessStderr(scenario, argv);
      expect({ code: run.code, stderr: run.stderr, processStderr: run.processStderr }).toEqual({
        code,
        stderr: "",
        processStderr: "",
      });
      for (const rung of RUNGS) expect(run.stdout).not.toContain(rung);
      const log = readFileSync(homePaths(scenario.home).log, "utf8");
      const stamp = "2026-09-20T12:00:00.000Z";
      expect(log).toContain(
        `${stamp} ${mode}: ${KEY}: fetch failed (auth): gh api: HTTP 401: Bad credentials\n`,
      );
      for (const rung of RUNGS)
        expect(log).toContain(`${stamp} ${mode}: fetch rung failed: ${rung}\n`);
    });
  },
);

// A dry run writes nothing, the rung lines included: the fetch still climbs the ladder, but its
// diagnostics go where every other line of a dry run goes, nowhere.
test("sync --dry-run over the same failure leaves no log behind", async () => {
  await withScenario({}, async (scenario) => {
    const upstream = writeSource(join(scenario.root, "upstream"), TWO_MEMORIES);
    const facts = await fetchedFacts(upstream, ADDED_AT);
    writeState(scenario.home, stateWith({ [KEY]: fetchedEntry(FROM, facts, { auth: true }) }));
    seedStore(scenario.home, FROM, upstream);
    const env = { HOME: scenario.userHome, MAXIMS_HOME: scenario.home };
    const runner = threeRungRunner();
    scenario.options.bundle = await createEngine({ quiet: false, env, runner });
    const run = await runCli(scenario, ["sync", "--dry-run"]);
    expect(run.stderr).toBe("");
    expect(runner.calls.some((call) => call.startsWith("git ls-remote"))).toBe(true);
    // `throwIfNoEntry` answers undefined for "nothing is there" alone; any other trouble throws.
    expect(statSync(homePaths(scenario.home).log, { throwIfNoEntry: false })).toBeUndefined();
  });
});
