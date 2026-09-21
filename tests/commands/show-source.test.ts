// What would drift silently: a `show <source>` that reports intent without the hold standing on
// it, a held block whose three line groups disagree with the pending tree on disk (a body that
// changed with no rule-line change must still be named), a `--json` document whose `held` shape
// drifts from the frame, a source argument that a memory name shadows without a word about it, a
// scope or `--source` flag accepted on a source, or a `list` tip that still points at `accept`.
import { expect, test } from "bun:test";
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import type { SourceFacts } from "../../src/commands/show-source.ts";
import { pendingPathFor } from "../../src/util/home.ts";
import {
  readState,
  realEngineBundle,
  runCli,
  type Scenario,
  snapshot,
  withScenario,
  writeState,
} from "../cli/harness.ts";
import {
  type FakeResolvers,
  fakeResolvers,
  githubFrom,
  memoryName,
  writeSource,
} from "../engine/harness.ts";
import { TWO_MEMORIES } from "../engine/world.ts";

const FROM = githubFrom("acme/rules");
const KEY = "@acme/rules";
// Against TWO_MEMORIES: one description changed (its body with it), one memory gone, one new.
const REVISION_B = {
  "always-review": { description: "Review before every push.", body: "Push, then review." },
  "new-rule": { description: "New." },
};

type Document = SourceFacts & { ok: boolean; kind: "source"; notices: string[] };

// Revision A installed with `--review` (its own fetch applies), then revision B upstream.
async function reviewedScenario(
  fn: (scenario: Scenario, fake: FakeResolvers) => Promise<void>,
): Promise<void> {
  const fake = fakeResolvers();
  const loadEngine = async () => realEngineBundle(fake.resolvers);
  await withScenario({ loadEngine }, async (scenario) => {
    const a = writeSource(join(scenario.root, "a"), TWO_MEMORIES);
    fake.set(FROM, { kind: "dir", dir: a });
    const added = await runCli(scenario, ["add", KEY, "-g", "--rule", "-a", "codex", "--review"]);
    expect(added.code).toBe(0);
    await fn(scenario, fake);
  });
}

async function hold(scenario: Scenario, fake: FakeResolvers): Promise<void> {
  fake.set(FROM, { kind: "dir", dir: writeSource(join(scenario.root, "b"), REVISION_B) });
  expect((await runCli(scenario, ["update"])).code).toBe(0);
}

async function shownSource(scenario: Scenario, ...argv: string[]): Promise<Document> {
  const run = await runCli(scenario, ["show", ...argv, "--json"]);
  expect([run.code, run.stderr]).toEqual([0, ""]);
  return JSON.parse(run.stdout) as Document;
}

test("a held source prints its facts, the three line groups, the bodies and their diffs", async () => {
  await reviewedScenario(async (scenario, fake) => {
    await hold(scenario, fake);
    const before = await snapshot(scenario.root);
    const run = await runCli(scenario, ["show", KEY]);
    expect([run.code, run.stderr]).toEqual([0, ""]);
    expect(run.stdout).toMatch(
      new RegExp(
        [
          "^\\|",
          `o  ${KEY}`,
          "   revision: [0-9a-f]{7} \\(tracking HEAD\\), fetched 2026-09-20",
          "   scope: global",
          "   agents: codex",
          "   rules: yes",
          "   selection: \\* \\(2 installed\\)",
          "   renames: none",
          "   disabled: none",
          "   review: on; 3 changed lines held since 2026-09-20",
          "o  Held changes: [0-9a-f]{7} -> [0-9a-f]{7}",
          "   \\+ new-rule  New\\.",
          "   - keep-tests-green",
          "   ~ always-review  Review before every commit\\. -> Review before every push\\.",
          "   bodies: always-review, keep-tests-green, new-rule",
          "\\|",
          "--- always-review",
          "",
        ].join("\\n"),
      ),
    );
    expect(run.stdout).toContain("\n-description: Review before every commit.\n");
    expect(run.stdout).toContain("\n+description: Review before every push.\n");
    expect(run.stdout).toContain("\n-Body of always-review.\n+Push, then review.\n");
    expect(run.stdout).toContain("\n--- new-rule\n");
    expect(run.stdout).toContain("\n+Body of new-rule.\n");
    expect(run.stdout).toContain("\n-Body of keep-tests-green.\n");
    const document = await shownSource(scenario, KEY);
    expect(document).toMatchObject({
      ok: true,
      kind: "source",
      key: KEY,
      ref: { kind: "tracking", ref: "HEAD" },
      scope: "global",
      location: null,
      harnesses: ["codex"],
      rule: true,
      select: "*",
      rename: {},
      disabled: [],
      review: true,
      notices: [],
    });
    expect(document.sha).toMatch(/^[0-9a-f]{40}$/);
    const held = document.held;
    if (held === null || "unreadable" in held) throw new Error("expected held changes");
    expect(held).toMatchObject({
      sha: expect.stringMatching(/^[0-9a-f]{40}$/),
      at: "2026-09-20T12:00:00.000Z",
      added: [{ name: "new-rule", description: "New." }],
      removed: ["keep-tests-green"],
      changed: [
        {
          name: "always-review",
          from: "Review before every commit.",
          to: "Review before every push.",
        },
      ],
    });
    expect(held.bodies.map((body) => String(body.name))).toEqual([
      "always-review",
      "keep-tests-green",
      "new-rule",
    ]);
    expect(held.bodies[0]?.diff).toContain("+Push, then review.");
    expect(held.sha).not.toBe(document.sha);
    // Reading the hold changed nothing: no lock, no log line, the pending tree as it was.
    expect(await snapshot(scenario.root)).toBe(before);
  });
});

test("a reviewed source with nothing held, and one never reviewed, print facts and no held block", async () => {
  await reviewedScenario(async (scenario, fake) => {
    const reviewed = await runCli(scenario, ["show", KEY]);
    expect([reviewed.code, reviewed.stderr]).toEqual([0, ""]);
    expect(reviewed.stdout).toContain("   review: on; nothing held\n");
    expect(reviewed.stdout).not.toContain("Held changes");
    expect((await shownSource(scenario, KEY)).held).toBeNull();
    expect((await runCli(scenario, ["unreview", KEY])).code).toBe(0);
    const plain = await runCli(scenario, ["show", "acme/rules"]);
    expect(plain.stdout).toContain("   review: off\n");
    expect(plain.stdout.endsWith("   disabled: none\n   review: off\n")).toBe(true);
    // A hold whose files were removed or altered by hand is said as such, never as "no changes":
    // `accept` forgets exactly these two, so `show` must not present them as a revision.
    expect((await runCli(scenario, ["review", KEY])).code).toBe(0);
    await hold(scenario, fake);
    const pending = pendingPathFor(scenario.home, FROM);
    rmSync(join(pending, "memories", "new-rule.md"));
    const altered = await runCli(scenario, ["show", KEY]);
    expect(altered.stdout).toContain(
      `!  the held revision of ${KEY} no longer matches what was fetched; run maxims update to fetch it again\n`,
    );
    expect(altered.stdout).not.toContain("Held changes");
    rmSync(pending, { recursive: true });
    const gone = await runCli(scenario, ["show", KEY]);
    expect(gone.stdout).toContain(
      `!  the held revision of ${KEY} is gone; run maxims update to fetch it again\n`,
    );
    expect((await shownSource(scenario, KEY)).held).toMatchObject({
      unreadable: `the held revision of ${KEY} is gone; run maxims update to fetch it again`,
    });
  });
});

test("a memory name shadows a source spelled the same; flags for memories are refused on a source", async () => {
  const fake = fakeResolvers();
  const loadEngine = async () => realEngineBundle(fake.resolvers);
  await withScenario({ loadEngine }, async (scenario) => {
    // A directory named like the one memory it provides, added as a local source.
    const dir = writeSource(join(scenario.cwd, "always-review"), {
      "always-review": { description: "Review before every commit." },
    });
    expect((await runCli(scenario, ["add", "./always-review", "-g", "-a", "codex"])).code).toBe(0);
    const memory = await runCli(scenario, ["show", "always-review"]);
    expect([memory.code, memory.stderr]).toEqual([0, ""]);
    expect(memory.stdout).toContain(
      `!  always-review also names a source; maxims show ${dir} prints it\n`,
    );
    expect(memory.stdout).toContain("\n---\nname: always-review\n");
    const source = await runCli(scenario, ["show", "./always-review"]);
    expect([source.code, source.stderr]).toEqual([0, ""]);
    expect(source.stdout).toContain(`o  ${dir}\n   revision: [0-9a-f]{7}`.slice(0, 4 + dir.length));
    expect(source.stdout).toContain("(copied directory)");
    expect((await shownSource(scenario, "./always-review")).ref).toEqual({
      kind: "copied",
      path: dir,
    });
    mkdirSync(join(scenario.cwd, "other"));
    const unknown = await runCli(scenario, ["show", "./other"]);
    expect([unknown.code, unknown.stderr]).toEqual([1, " ERROR  ./other is not installed\n"]);
    const scoped = await runCli(scenario, ["show", dir, "-g"]);
    expect(scoped.stderr).toBe(` ERROR  ${dir} has one recorded destination; drop -g or -p\n`);
    const narrowed = await runCli(scenario, ["show", dir, "--source", dir]);
    expect(narrowed.stderr).toBe(` ERROR  --source narrows a memory lookup; ${dir} is a source\n`);
    // Under `--json` a source's refusal is the same five-field document a memory's refusal is,
    // so one caller parses one shape whichever kind of name it passed.
    const refusals: [string[], string][] = [
      [["-g"], `${dir} has one recorded destination; drop -g or -p`],
      [["--source", dir], `--source narrows a memory lookup; ${dir} is a source`],
    ];
    for (const [flags, message] of refusals) {
      const json = await runCli(scenario, ["show", dir, ...flags, "--json"]);
      expect([json.code, json.stderr, JSON.parse(json.stdout)]).toEqual([
        1,
        "",
        { ok: false, code: 1, message, hint: null, notices: [] },
      ]);
    }
  });
});

// A source recorded for another project is refused by every verb that would edit it; a memory
// that happens to share its spelling must still print here, since the memory is what was asked.
test("a memory name is printed even when the same spelling is a source recorded for another project", async () => {
  const fake = fakeResolvers();
  const loadEngine = async () => realEngineBundle(fake.resolvers);
  await withScenario({ loadEngine, project: true }, async (scenario) => {
    const dir = writeSource(join(scenario.cwd, "always-review"), {
      "other-rule": { description: "Other." },
    });
    fake.set(githubFrom("a/b"), {
      kind: "dir",
      dir: writeSource(join(scenario.root, "b"), TWO_MEMORIES),
    });
    expect((await runCli(scenario, ["add", "./always-review", "-p", "-a", "codex"])).code).toBe(0);
    expect((await runCli(scenario, ["add", "@a/b", "-g", "-a", "codex"])).code).toBe(0);
    const state = readState(scenario) as {
      sources: Record<string, { intent: { destination: { scope: string; root?: string } } }>;
    };
    const entry = state.sources[dir];
    if (entry === undefined) throw new Error(`${dir} not in state`);
    entry.intent.destination = { scope: "project", root: join(scenario.root, "elsewhere") };
    writeState(scenario, state);
    const run = await runCli(scenario, ["show", "always-review"]);
    expect([run.code, run.stderr]).toEqual([0, ""]);
    expect(run.stdout).toContain("\n---\nname: always-review\n");
    expect(run.stdout).not.toContain("also names a source");
    const source = await runCli(scenario, ["show", "./always-review"]);
    expect([source.code, source.stderr]).toEqual([
      1,
      ` ERROR  ${dir} is installed for the project at ${join(scenario.root, "elsewhere")}\nTip: run the command from that project\n`,
    ]);
    const json = await runCli(scenario, ["show", "./always-review", "--json"]);
    expect([json.code, json.stderr, JSON.parse(json.stdout)]).toEqual([
      1,
      "",
      {
        ok: false,
        code: 1,
        message: `${dir} is installed for the project at ${join(scenario.root, "elsewhere")}`,
        hint: "run the command from that project",
        notices: [],
      },
    ]);
  });
});

// The hold's summary counts only the memories the user could see when it was recorded, and the
// selection can narrow afterwards (`remove <memory>`); a check that re-derives the summary under
// either selection alone forgets an intact hold as "altered", in `accept` and `show` alike.
test("a narrowed source whose unselected memory also changed still shows and accepts its hold", async () => {
  const fake = fakeResolvers();
  const loadEngine = async () => realEngineBundle(fake.resolvers);
  await withScenario({ loadEngine }, async (scenario) => {
    fake.set(FROM, { kind: "dir", dir: writeSource(join(scenario.root, "a"), TWO_MEMORIES) });
    const argv = ["add", KEY, "-g", "-a", "codex", "--review", "-m", "always-review"];
    expect((await runCli(scenario, argv)).code).toBe(0);
    const both = {
      "always-review": { description: "Review before every push." },
      "keep-tests-green": { description: "Never merge red, ever." },
    };
    fake.set(FROM, { kind: "dir", dir: writeSource(join(scenario.root, "b"), both) });
    expect((await runCli(scenario, ["update"])).code).toBe(0);
    const shown = await shownSource(scenario, KEY);
    expect(shown.held).toMatchObject({
      added: [],
      removed: [],
      changed: [{ name: "always-review" }],
    });
    expect(shown.select).toEqual([memoryName("always-review")]);
    const accepted = await runCli(scenario, ["accept", KEY, "--json"]);
    expect(JSON.parse(accepted.stdout)).toMatchObject({ ok: true, accepted: true });
  });
});

test("a hold survives the selection narrowing after it was recorded", async () => {
  await reviewedScenario(async (scenario, fake) => {
    const both = {
      "always-review": { description: "Review before every push." },
      "keep-tests-green": { description: "Never merge red, ever." },
    };
    fake.set(FROM, { kind: "dir", dir: writeSource(join(scenario.root, "b"), both) });
    expect((await runCli(scenario, ["update"])).code).toBe(0);
    expect((await runCli(scenario, ["remove", "always-review", "-y"])).code).toBe(0);
    const shown = await shownSource(scenario, KEY);
    expect(shown.select).toEqual([memoryName("keep-tests-green")]);
    expect(shown.held).toMatchObject({
      added: [],
      removed: [],
      changed: [{ name: "keep-tests-green" }],
    });
    const accepted = await runCli(scenario, ["accept", KEY, "--json"]);
    expect(JSON.parse(accepted.stdout)).toMatchObject({ ok: true, accepted: true });
  });
});
