// What would drift silently: a dry run over a failed fetch that shows the failure line alone
// where `sync --dry-run` shows the writes, or one that writes on its way to that exit.
import { expect, test } from "bun:test";
import { join } from "node:path";
import { realEngineBundle, runCli, type Scenario, snapshot, withScenario } from "../cli/harness.ts";
import {
  ADDED_AT,
  fakeResolvers,
  fetchedEntry,
  fetchedFacts,
  githubFrom,
  seedStore,
  stateWith,
  writeSource,
  writeState,
} from "../engine/harness.ts";
import { TWO_MEMORIES } from "../engine/world.ts";

const FROM = githubFrom("a/b");
const KEY = "@a/b";

// A last-good install of `@a/b` whose next fetch fails on the network, through the real engine.
async function lastGoodThenUnreachable(scenario: Scenario): Promise<void> {
  const upstream = writeSource(join(scenario.root, "upstream"), TWO_MEMORIES);
  const facts = await fetchedFacts(upstream, ADDED_AT);
  writeState(
    scenario.home,
    stateWith({ [KEY]: fetchedEntry(FROM, facts, { harnesses: ["claude-code"] }) }),
  );
  seedStore(scenario.home, FROM, upstream);
  const fake = fakeResolvers();
  fake.set(FROM, { kind: "fail", failure: "network" });
  scenario.options.loadEngine = async () => realEngineBundle(fake.resolvers);
}

test("update --dry-run over a failed fetch prints the plan sync --dry-run prints, then the failure, exit 2, writes nothing", async () => {
  await withScenario({}, async (scenario) => {
    await lastGoodThenUnreachable(scenario);
    const before = await snapshot(scenario.root);
    // The control: the same failure under `sync --dry-run` is the plan, its notes, and exit 2.
    const sync = await runCli(scenario, ["sync", "--dry-run"]);
    const planLines = sync.stdout.split("\n").filter((line) => line.startsWith("write   "));
    expect([sync.code, sync.stderr, planLines.length]).toEqual([2, "", 2]);

    const run = await runCli(scenario, ["update", "--dry-run"]);
    expect({ code: run.code, stdout: run.stdout, stderr: run.stderr }).toEqual({
      code: 2,
      stdout: ["|", "o  Checking for memory updates...", ...planLines, ""].join("\n"),
      stderr:
        " ERROR  Failed to update @a/b: scripted network\n" +
        "Tip: the last good copy of each failed source stays installed\n",
    });
    expect(await snapshot(scenario.root)).toBe(before);
  });
});
