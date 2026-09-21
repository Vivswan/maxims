// What would drift silently: an `accept` that syncs before the store swap lands (the block would
// keep last-good while state says the new sha), a hold `list` and `doctor` do not show, an
// `add --review` whose own first fetch is held instead of applied, an `unreview` that lifts the
// mark and leaves the held revision behind, a `--json` document whose `accepted` disagrees with
// what landed, an intent edit (`link`, `share`) that drops the held revision, a hand-deleted
// held revision that crashes `accept`, and a held tree missing a file that `accept` records as
// the whole revision.
import { expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ListReport } from "../../src/commands/types.ts";
import { pendingPathFor, storePathFor } from "../../src/util/home.ts";
import {
  type FakeResolvers,
  fakeResolvers,
  fetchedFacts,
  githubFrom,
  treeDigest,
  writeSource,
} from "../engine/harness.ts";
import { TWO_MEMORIES } from "../engine/world.ts";
import { readState, realEngineBundle, runCli, type Scenario, withScenario } from "./harness.ts";

const FROM = githubFrom("acme/rules");
const KEY = "@acme/rules";
const REVISION_B = {
  ...TWO_MEMORIES,
  "always-review": { description: "Review before every push." },
  "new-rule": { description: "New." },
};
const HELD_LINE = "o  Held @acme/rules (2 changed lines); run maxims accept @acme/rules\n";

type Recorded = {
  intent: { review?: true };
  fetched?: { sha: string };
  pending?: { sha: string; summary: string[] };
};

function recorded(scenario: Scenario): Recorded {
  const entry = (readState(scenario) as { sources: Record<string, Recorded> }).sources[KEY];
  if (entry === undefined) throw new Error(`${KEY} not in state`);
  return entry;
}

// Revision A installed with `--review` (its own fetch applies), then revision B upstream.
async function heldScenario(
  fn: (
    scenario: Scenario,
    upstream: { a: string; b: string; fake: FakeResolvers },
  ) => Promise<void>,
) {
  const fake = fakeResolvers();
  await withScenario({ bundle: realEngineBundle(fake.resolvers) }, async (scenario) => {
    const a = writeSource(join(scenario.root, "a"), TWO_MEMORIES);
    const b = writeSource(join(scenario.root, "b"), REVISION_B);
    fake.set(FROM, { kind: "dir", dir: a });
    const added = await runCli(scenario, ["add", KEY, "-g", "--rule", "-a", "codex", "--review"]);
    expect(added.code).toBe(0);
    expect(recorded(scenario).intent.review).toBe(true);
    expect(recorded(scenario).pending).toBeUndefined();
    fake.set(FROM, { kind: "dir", dir: b });
    await fn(scenario, { a, b, fake });
  });
}

function rulesFile(scenario: Scenario): string {
  return join(scenario.userHome, ".codex", "AGENTS.md");
}

test("update holds the revision, list and doctor show it, accept lands it in one step", async () => {
  await heldScenario(async (scenario, { b }) => {
    const rules = rulesFile(scenario);
    const block = readFileSync(rules, "utf8");
    expect(block).toContain("Never merge red.");
    const update = await runCli(scenario, ["update"]);
    expect(update.code).toBe(0);
    expect(update.stdout).toContain(HELD_LINE);
    expect(readFileSync(rules, "utf8")).toBe(block);
    expect(treeDigest(pendingPathFor(scenario.home, FROM))).toBe(treeDigest(b));
    const list = await runCli(scenario, ["list"]);
    expect(list.stdout).toContain("  held (2 changed lines; run maxims accept @acme/rules)\n");
    const listed: ListReport = JSON.parse((await runCli(scenario, ["list", "--json"])).stdout);
    expect(listed.sources[0]).toMatchObject({
      key: KEY,
      review: true,
      held: {
        summary: [
          expect.stringMatching(/^~ always-review \([0-9a-f]{7} -> [0-9a-f]{7}\)$/),
          "+ new-rule",
        ],
      },
    });
    const doctor = await runCli(scenario, ["doctor"]);
    expect(doctor.code).toBe(0);
    expect(doctor.stdout).toContain(
      "!   @acme/rules: 2 changed lines held for review (run maxims accept @acme/rules)\n",
    );
    const accepted = await runCli(scenario, ["accept", KEY, "--json"]);
    expect(accepted.code).toBe(0);
    expect(JSON.parse(accepted.stdout)).toMatchObject({
      ok: true,
      source: KEY,
      review: true,
      accepted: true,
      held: 0,
    });
    const text = readFileSync(rules, "utf8");
    expect(text).toContain("Review before every push.");
    expect(text).toContain("New.");
    const after = recorded(scenario);
    expect(after.fetched?.sha).toBe((await fetchedFacts(b, "")).sha);
    expect(after.pending).toBeUndefined();
    expect(after.intent.review).toBe(true);
    expect(existsSync(pendingPathFor(scenario.home, FROM))).toBe(false);
    expect(treeDigest(storePathFor(scenario.home, FROM))).toBe(treeDigest(b));
    const again = await runCli(scenario, ["accept", KEY]);
    expect(again.code).toBe(0);
    expect(again.stdout).toContain("o  @acme/rules has nothing held for review\n");
    expect((await runCli(scenario, ["doctor"])).stdout).not.toContain("held for review");
    // Lifting the mark with nothing held accepts nothing, and the document says so.
    const lifted = await runCli(scenario, ["unreview", KEY, "--json"]);
    expect(JSON.parse(lifted.stdout)).toMatchObject({
      source: KEY,
      review: false,
      accepted: false,
    });
    expect(recorded(scenario).intent.review).toBeUndefined();
  });
});

test("a held revision deleted by hand is forgotten by accept and held again by the next update", async () => {
  await heldScenario(async (scenario) => {
    expect((await runCli(scenario, ["update"])).stdout).toContain(HELD_LINE);
    rmSync(pendingPathFor(scenario.home, FROM), { recursive: true });
    const gone = await runCli(scenario, ["accept", KEY]);
    expect(gone.code).toBe(0);
    expect(gone.stdout).toContain(
      "o  the held revision of @acme/rules is gone; run maxims update to fetch it again\n",
    );
    const nothing = await runCli(scenario, ["accept", KEY, "--json"]);
    expect(JSON.parse(nothing.stdout)).toMatchObject({ ok: true, source: KEY, accepted: false });
    expect(recorded(scenario).pending).toBeUndefined();
    expect(readFileSync(rulesFile(scenario), "utf8")).toContain("Never merge red.");
    expect((await runCli(scenario, ["update"])).stdout).toContain(HELD_LINE);
    expect(recorded(scenario).pending?.summary).toHaveLength(2);
  });
});

// The recorded sha names the whole revision; recording it over a tree missing a file would say
// the revision landed while its block lacks a rule.
test("a held revision that lost a file is forgotten by accept, not recorded over the partial tree", async () => {
  await heldScenario(async (scenario, { a }) => {
    const rules = rulesFile(scenario);
    const block = readFileSync(rules, "utf8");
    expect((await runCli(scenario, ["update"])).stdout).toContain(HELD_LINE);
    const pending = pendingPathFor(scenario.home, FROM);
    rmSync(join(pending, "memories", "new-rule.md"));
    const partial = await runCli(scenario, ["accept", KEY]);
    expect(partial.code).toBe(0);
    expect(partial.stdout).toContain(
      "o  the held revision of @acme/rules no longer matches what was fetched; run maxims update to fetch it again\n",
    );
    const after = recorded(scenario);
    expect(after.pending).toBeUndefined();
    expect(after.fetched?.sha).toBe((await fetchedFacts(a, "")).sha);
    expect(readFileSync(rules, "utf8")).toBe(block);
    expect(existsSync(pending)).toBe(false);
    expect((await runCli(scenario, ["update"])).stdout).toContain(HELD_LINE);
  });
});

test("unreview applies the held revision and lifts the mark; accept --all takes every hold", async () => {
  await heldScenario(async (scenario, { b, fake }) => {
    expect((await runCli(scenario, ["update"])).stdout).toContain(HELD_LINE);
    const lifted = await runCli(scenario, ["unreview", KEY]);
    expect(lifted.code).toBe(0);
    expect(lifted.stdout).toContain("o  Accepted @acme/rules (2 changed lines)\n");
    expect(lifted.stdout).toContain("o  Unreviewed @acme/rules; upstream changes apply at once\n");
    const after = recorded(scenario);
    expect(after.intent.review).toBeUndefined();
    expect(after.pending).toBeUndefined();
    expect(after.fetched?.sha).toBe((await fetchedFacts(b, "")).sha);
    expect(readFileSync(rulesFile(scenario), "utf8")).toContain("Review before every push.");
    const marked = await runCli(scenario, ["review", KEY]);
    expect(marked.stdout).toContain(
      "o  Reviewing @acme/rules; upstream changes wait for maxims accept\n",
    );
    const c = writeSource(join(scenario.root, "c"), {
      ...REVISION_B,
      "third-rule": { description: "Third." },
    });
    fake.set(FROM, { kind: "dir", dir: c });
    expect((await runCli(scenario, ["update"])).stdout).toContain(
      "o  Held @acme/rules (1 changed line); run maxims accept @acme/rules\n",
    );
    const all = await runCli(scenario, ["accept", "--all", "--json"]);
    expect(all.code).toBe(0);
    expect(JSON.parse(all.stdout)).toMatchObject({ ok: true, sources: [KEY], accepted: true });
    expect(readFileSync(rulesFile(scenario), "utf8")).toContain("Third.");
  });
});

// Every other intent edit goes through the same entry rebuild, so one that dropped the held
// revision would have the next sync sweep its files and `accept` say nothing is held.
test("an intent edit on a held source keeps the held revision", async () => {
  await heldScenario(async (scenario, { b }) => {
    expect((await runCli(scenario, ["update"])).stdout).toContain(HELD_LINE);
    const linked = await runCli(scenario, ["link", KEY, "-a", "claude-code"]);
    expect(linked.code).toBe(0);
    expect(recorded(scenario).pending?.summary).toHaveLength(2);
    expect(treeDigest(pendingPathFor(scenario.home, FROM))).toBe(treeDigest(b));
    expect((await runCli(scenario, ["accept", KEY])).stdout).toContain(
      "o  Accepted @acme/rules (2 changed lines)\n",
    );
    expect(readFileSync(rulesFile(scenario), "utf8")).toContain("Review before every push.");
  });
});

test("review refuses a live source, since a directory read in place has no fetch to hold", async () => {
  const fake = fakeResolvers();
  await withScenario({ bundle: realEngineBundle(fake.resolvers) }, async (scenario) => {
    mkdirSync(join(scenario.cwd, "memories"));
    writeFileSync(
      join(scenario.cwd, "memories", "local-rule.md"),
      "---\nname: local-rule\ndescription: A rule edited in place\n---\n",
    );
    expect((await runCli(scenario, ["add", ".", "-g", "-a", "codex"])).code).toBe(0);
    const live = await runCli(scenario, ["review", scenario.cwd]);
    expect(live.code).toBe(1);
    expect(live.stderr).toContain("is live and read in place; there is no fetch to hold");
  });
});
