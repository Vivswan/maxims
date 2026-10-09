// What would drift silently: a config.json with a typo keeping a session-start `sync --quiet`
// from refreshing any rule file (the hook exits 0 after a log line and the machine goes stale
// with nothing on screen); a reading verb running on defaults a user believes they overrode; or
// `sync --cap` on a broken file overwriting what the user had in it with the one key it was given.
import { expect, test } from "bun:test";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createEngine } from "../../src/commands/engine.ts";
import { sourceSlug } from "../../src/commands/shared/slug.ts";
import { estimateTokens } from "../../src/rulefile/budget.ts";
import { homePaths } from "../../src/util/home.ts";
import {
  entryFor,
  localFrom,
  rulesDirHarness,
  stateWith,
  writeSource,
  writeState,
} from "../engine/harness.ts";
import { globalRulesFile, TWO_MEMORIES } from "../engine/world.ts";
import { runCli, type Scenario, withScenario } from "./harness.ts";

const BROKEN = '{"ruleCap":"x","agents":["codex"]}\n';

// The real engine over the fixture rules-dir harness, so the run writes a rule file a test can
// find; the fake engine would only record the call.
async function brokenConfigScenario(
  scenario: Scenario,
): Promise<{ rules: string; config: string }> {
  const env = { HOME: scenario.userHome, MAXIMS_HOME: scenario.home };
  scenario.options.loadEngine = async (options) => ({
    ...(await createEngine({ ...options, env })),
    harnesses: [rulesDirHarness],
  });
  const source = writeSource(join(scenario.root, "upstream"), TWO_MEMORIES);
  const from = localFrom(source, true);
  writeState(scenario.home, stateWith({ [source]: entryFor(from) }));
  const config = homePaths(scenario.home).config;
  writeFileSync(config, BROKEN);
  return { rules: globalRulesFile(scenario.userHome, sourceSlug(from)), config };
}

// The postcondition of a refresh is the rule file's content, not its presence: both fixture
// rules reached the harness.
function expectBothRules(rules: string): void {
  const text = readFileSync(rules, "utf8");
  for (const { description } of Object.values(TWO_MEMORIES)) expect(text).toContain(description);
}

test("sync --quiet with a broken config.json still refreshes, and logs what it ran without", async () => {
  await withScenario({}, async (scenario) => {
    const { rules, config } = await brokenConfigScenario(scenario);
    const run = await runCli(scenario, ["sync", "--quiet"]);
    expect([run.code, run.stdout, run.stderr]).toEqual([
      0,
      "maxims: rules refreshed (1 file updated)\n",
      "",
    ]);
    expectBothRules(rules);
    const log = readFileSync(homePaths(scenario.home).log, "utf8");
    expect(log).toContain(
      `sync --quiet: maxims: ${config} is not a valid config: ruleCap: Invalid input: expected number, received string; using defaults`,
    );
    expect(readFileSync(config, "utf8")).toBe(BROKEN);
  });
});

test("sync with a broken config.json refreshes and says which key it ignored", async () => {
  await withScenario({}, async (scenario) => {
    const { rules, config } = await brokenConfigScenario(scenario);
    const run = await runCli(scenario, ["sync"]);
    expect([run.code, run.stderr]).toEqual([0, ""]);
    // The estimate counts the rule file's own text, which carries the file's absolute path, so
    // the figure follows the temp dir's length and is derived from the written bytes.
    const tokens = estimateTokens(readFileSync(rules, "utf8"), rulesDirHarness.markers);
    expect(run.stdout).toBe(
      `!  maxims: ${config} is not a valid config: ruleCap: Invalid input: expected number, received string; using defaults\n` +
        `!  ~${tokens} tokens in ${rules}\n` +
        `o  Installed 2 memories, 2 rule lines (~${tokens} tokens)\n`,
    );
    expectBothRules(rules);
  });
});

const REFUSING: [string, string[]][] = [
  ["list", ["list"]],
  ["config get", ["config", "get"]],
  ["sync --cap", ["sync", "--cap", "5"]],
];

test.each(REFUSING)(
  "%s refuses a broken config.json with exit 4, names the key, and leaves the file as it was",
  async (_verb, argv) => {
    await withScenario({}, async (scenario) => {
      const { rules, config } = await brokenConfigScenario(scenario);
      const run = await runCli(scenario, argv);
      expect([run.code, run.stdout]).toEqual([4, ""]);
      expect(run.stderr).toBe(
        ` ERROR  ${config} is not a valid config: ruleCap: Invalid input: expected number, received string\n` +
          "Tip: valid keys: agents, yes, addHook, rule, cooldownDays, ruleCap, lastAgents\n",
      );
      expect(existsSync(rules)).toBe(false);
      expect(readFileSync(config, "utf8")).toBe(BROKEN);
    });
  },
);
