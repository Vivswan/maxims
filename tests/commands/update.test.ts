// What would drift silently: a dry run over a failed fetch that shows the failure line alone
// where `sync --dry-run` shows the writes, or one that writes on its way to that exit.
import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { homePaths } from "../../src/util/home.ts";
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

test("update --dry-run over a failed fetch prints the plan sync --dry-run prints and the run's notices, then the failure, exit 2, writes nothing", async () => {
  await withScenario({}, async (scenario) => {
    await lastGoodThenUnreachable(scenario);
    const before = await snapshot(scenario.root);
    // The control: the same failure under `sync --dry-run` is the plan, its notes, and exit 2.
    const sync = await runCli(scenario, ["sync", "--dry-run"]);
    const planLines = sync.stdout.split("\n").filter((line) => line.startsWith("write   "));
    expect([sync.code, sync.stderr, planLines.length]).toEqual([2, "", 2]);

    const run = await runCli(scenario, ["update", "--dry-run"]);
    const notices = run.stdout.split("\n").filter((line) => line.startsWith("!  "));
    expect(notices).toEqual([
      `!  maxims: the rules from ${KEY} have not refreshed since ${ADDED_AT} (network unreachable) and may be out of date.`,
      expect.stringMatching(/^! {2}~\d+ tokens in /),
    ]);
    expect({ code: run.code, stdout: run.stdout, stderr: run.stderr }).toEqual({
      code: 2,
      stdout: ["|", "o  Checking for memory updates...", ...planLines, ...notices, ""].join("\n"),
      stderr:
        " ERROR  Failed to update @a/b: scripted network\n" +
        "Tip: the last good copy of each failed source stays installed\n",
    });
    expect(await snapshot(scenario.root)).toBe(before);
  });
});

// The failure document is the success document with the failure in front, so a CI job reads the
// shared ok/code/message/hint head from `sync --json` and `update --json` alike, then each verb's
// own fields: `update --dry-run --json` over a failed fetch carries the plan `sync --dry-run
// --json` carries, the writes the engine would make.
test("update --json over a failed fetch carries the plan and the keys sync --json carries", async () => {
  await withScenario({}, async (scenario) => {
    await lastGoodThenUnreachable(scenario);
    const sync = await runCli(scenario, ["sync", "--dry-run", "--json"]);
    const syncDocument = JSON.parse(sync.stdout) as {
      ok: boolean;
      code: number;
      message: string;
      hint: string | null;
      plan: { changes: { kind: string; path: string }[] };
    };
    const update = await runCli(scenario, ["update", "--dry-run", "--json"]);
    const updateDocument = JSON.parse(update.stdout) as typeof syncDocument;
    expect([sync.code, syncDocument.ok, syncDocument.code]).toEqual([2, false, 2]);
    expect([update.code, updateDocument.ok, updateDocument.code]).toEqual([2, false, 2]);
    expect(Object.keys(updateDocument).slice(0, 4)).toEqual(["ok", "code", "message", "hint"]);
    expect(Object.keys(syncDocument).slice(0, 4)).toEqual(["ok", "code", "message", "hint"]);
    expect([updateDocument.message, updateDocument.hint]).toEqual([
      syncDocument.message,
      syncDocument.hint,
    ]);
    const writes = (document: typeof syncDocument) =>
      document.plan.changes.filter((change) => change.kind === "write").map((c) => c.path);
    expect(writes(updateDocument)).toEqual(writes(syncDocument));
    expect(writes(updateDocument)).toHaveLength(2);
  });
});

// Under `--quiet` every failure is exit 0 after one log line, whichever channel printed it: a
// hook-mode `update --json --quiet` whose failed fetch left refresh.log silent would hide the
// failure from the one place a hook's user can read it.
test("update --json --quiet over a failed fetch exits 0 and logs the failure line the bare --quiet run logs", async () => {
  await withScenario({}, async (scenario) => {
    await lastGoodThenUnreachable(scenario);
    const run = await runCli(scenario, ["update", "--json", "--quiet"]);
    expect([run.code, run.stderr]).toEqual([0, ""]);
    expect(JSON.parse(run.stdout)).toMatchObject({ ok: false, code: 2, hint: expect.any(String) });
    const line = `maxims: update failed (exit 2): Failed to update ${KEY}: scripted network`;
    const log = readFileSync(homePaths(scenario.home).log, "utf8").split("\n");
    expect(log.filter((entry) => entry === line)).toHaveLength(1);
  });
});

// `update --rename` admits an incoming name through the same walk `add` runs, so a cap it would
// cross is refused with the one cap wording and the hint that names the ways out.
test("update --rename over the cap is refused with the cap refusal add prints", async () => {
  await withScenario({}, async (scenario) => {
    await lastGoodThenUnreachable(scenario);
    const run = await runCli(scenario, ["update", KEY, "--rename", "ghost=phantom", "--cap", "2"]);
    expect([run.code, run.stderr.split("\n")[0]]).toEqual([
      8,
      ` ERROR  ${KEY} would publish 3 rule lines, over the cap of 2`,
    ]);
    expect(run.stderr).toContain("Tip: narrow the source with --memory <name>...");
  });
});
