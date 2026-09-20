// Fails if a verb that edits one intent field or reads state stops doing exactly that: `update`
// no longer forcing the refetch, `init` writing a file the contract rejects, `config` writing a
// value the schema refuses, `install` skipping a manifest entry, `lint` missing a problem class,
// `doctor` writing anything, `link` adding a harness without a target, `remove` deleting without
// `-y` non-interactively, or `disable` accepting `-a`.
import { expect, test } from "bun:test";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { cursor } from "../../src/harnesses/cursor/index.ts";
import { zed } from "../../src/harnesses/zed/index.ts";
import { type MemoryName, parseMemory, parseMemoryName } from "../../src/memory/contract.ts";
import { renderBlock } from "../../src/rulefile/block.ts";
import { homePaths } from "../../src/util/home.ts";
import { CURSOR_FRONTMATTER } from "./fixture-harnesses.ts";
import {
  FIXTURES,
  lastSyncCall,
  readState,
  runCli,
  type Scenario,
  snapshot,
  withScenario,
  writeConfig,
  writeState,
} from "./harness.ts";

const SKILLS = join(FIXTURES, "skills");
const DOTFILES = join(FIXTURES, "dotfiles");

function mn(raw: string): MemoryName {
  const name = parseMemoryName(raw);
  if (name === null) throw new Error(`${raw} is not a memory name`);
  return name;
}

async function installSkills(scenario: Scenario, extra: string[] = []): Promise<void> {
  const run = await runCli(scenario, ["add", "@a/b", "-g", "-a", "codex", "--rule", ...extra]);
  expect(run.code).toBe(0);
}

// A managed block as the engine renders one, so `doctor` reads the fixture files with the real
// parser, which takes each rule line's name from its detail path's last segment; the hash is
// display only.
function block(source: string, names: string[]): string {
  return renderBlock({
    source,
    sha: "a".repeat(40),
    lines: names.map((name) => ({
      name: mn(name),
      description: `Rule ${name}.`,
      detailPath: `memories/${name}.md`,
      shortHash: "abcdef1",
    })),
    markers: "counted",
    expands: [],
    selfRefresh: false,
  });
}

const NEW_UPSTREAM =
  "maxims: @a/b has new memories not in your selection: gate-exit-conditions-the-merge, no-sleep-waiting-on-subagents, rubber-duck-before-every-commit";

test("update forces a refetch of every fetched source, or of the one named, and reports", async () => {
  await withScenario(
    {
      github: { "a/b": SKILLS, "a/d": DOTFILES },
      syncReport: {
        fetched: ["@a/b"],
        upstreamChanges: { "@a/b": ["+ skip-unfit-skills"] },
        notices: [NEW_UPSTREAM],
      },
    },
    async (scenario) => {
      await installSkills(scenario, ["-m", "skip-unfit-skills"]);
      expect(
        (
          await runCli(scenario, [
            "add",
            "@a/d",
            "-g",
            "-a",
            "codex",
            "--rename",
            "gate-exit-conditions-the-merge=merge-gate",
          ])
        ).code,
      ).toBe(0);
      mkdirSync(join(scenario.cwd, "memories"));
      writeFileSync(
        join(scenario.cwd, "memories", "live-rule.md"),
        "---\nname: live-rule\ndescription: Edited in place\n---\n",
      );
      expect((await runCli(scenario, ["add", ".", "-g", "-a", "codex"])).code).toBe(0);
      const all = await runCli(scenario, ["update"]);
      expect(all.stderr).toBe("");
      expect(all.code).toBe(0);
      const last = scenario.engine.calls.sync.at(-1);
      expect(last).toMatchObject({ fetch: "force" });
      expect(last?.only).toBeUndefined();
      expect(all.stdout).toContain("o  Checking for memory updates...\n");
      expect(all.stdout).toContain(`o  ${scenario.cwd} is live; nothing to fetch\n`);
      expect(all.stdout).toContain("o  Found 1 update(s)\n");
      expect(all.stdout).toContain("o  Updated @a/b (+1 -0 rule)\n");
      expect(all.stdout).toContain(`!  ${NEW_UPSTREAM}\n`);
      const one = await runCli(scenario, ["update", "@A/D"]);
      expect(one.code).toBe(0);
      expect(scenario.engine.calls.sync.at(-1)?.only).toEqual(["@a/d"]);
      scenario.options.syncReport = { fetched: [] };
      const quietRun = await runCli(scenario, ["update"]);
      expect(quietRun.stdout).toContain("o  All memories are up to date\n");
    },
  );
});

test("update --rename records the pair on the named source, and sync persists --cap", async () => {
  await withScenario({ github: { "a/b": SKILLS } }, async (scenario) => {
    await installSkills(scenario);
    const bare = await runCli(scenario, ["update", "--rename", "skip-unfit-skills=skip-unfit"]);
    expect(bare.code).toBe(1);
    expect(bare.stderr).toBe(" ERROR  --rename on update needs the source it applies to\n");
    const named = await runCli(scenario, [
      "update",
      "@a/b",
      "--rename",
      "skip-unfit-skills=skip-unfit",
    ]);
    expect(named.code).toBe(0);
    const state = readState(scenario) as {
      sources: Record<string, { intent: { rename: Record<string, string> } }>;
    };
    expect(state.sources["@a/b"]?.intent.rename).toEqual({ "skip-unfit-skills": "skip-unfit" });
    expect((await runCli(scenario, ["sync", "--cap", "40", "--cooldown", "2"])).code).toBe(0);
    expect(JSON.parse((await runCli(scenario, ["config", "get"])).stdout)).toEqual({
      ruleCap: 40,
      cooldownDays: 2,
    });
  });
});

test("update reports a source whose refetch failed and exits 2 after finishing the others", async () => {
  await withScenario(
    {
      github: { "a/b": SKILLS },
      syncReport: { failed: [{ key: "@a/b", message: "connect timed out", kind: "network" }] },
    },
    async (scenario) => {
      await installSkills(scenario);
      const run = await runCli(scenario, ["update"]);
      expect(run.code).toBe(2);
      expect(run.stderr).toContain(" ERROR  Failed to update @a/b: connect timed out\n");
      const quiet = await runCli(scenario, ["update", "--quiet"]);
      expect(quiet.code).toBe(0);
    },
  );
});

test("init scaffolds a contract-valid file, refuses to overwrite, and needs a name non-interactively", async () => {
  await withScenario({}, async (scenario) => {
    const run = await runCli(scenario, ["init", "my-rule"]);
    expect(run.code).toBe(0);
    const path = join(scenario.cwd, "memories", "my-rule.md");
    const text = readFileSync(path, "utf8");
    const parsed = parseMemory(path, text);
    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      expect(parsed.memory.metadata).toEqual({ nodeType: "memory", type: "feedback", extra: {} });
      expect(parsed.memory.body).toContain("**Why:**");
      expect(parsed.memory.body).toContain("**How to apply:**");
    }
    const yamlWord = await runCli(scenario, ["init", "true"]);
    expect(yamlWord.code).toBe(0);
    expect(
      parseMemory("true.md", readFileSync(join(scenario.cwd, "memories", "true.md"), "utf8")).ok,
    ).toBe(true);
    const again = await runCli(scenario, ["init", "my-rule"]);
    expect(again.code).toBe(1);
    expect(again.stderr).toBe(" ERROR  memories/my-rule.md already exists\n");
    const nameless = await runCli(scenario, ["init"]);
    expect(nameless.code).toBe(1);
    expect(nameless.stderr).toContain("a memory name is required");
    const dry = await runCli(scenario, ["init", "other-rule", "--dry-run"]);
    expect(dry.code).toBe(0);
    expect(existsSync(join(scenario.cwd, "memories", "other-rule.md"))).toBe(false);
  });
});

test("config set/get/unset round-trips through the schema and refuses bad values", async () => {
  await withScenario({}, async (scenario) => {
    expect((await runCli(scenario, ["config", "set", "rule", "true"])).code).toBe(0);
    expect((await runCli(scenario, ["config", "set", "agents", "codex,claude-code"])).code).toBe(0);
    expect((await runCli(scenario, ["config", "set", "ruleCap", "30"])).code).toBe(0);
    expect((await runCli(scenario, ["config", "get", "rule"])).stdout).toBe("true\n");
    expect(JSON.parse((await runCli(scenario, ["config", "get"])).stdout)).toEqual({
      rule: true,
      agents: ["codex", "claude-code"],
      ruleCap: 30,
    });
    expect(readFileSync(homePaths(scenario.home).config, "utf8")).toBe(
      '{\n  "agents": [\n    "codex",\n    "claude-code"\n  ],\n  "rule": true,\n  "ruleCap": 30\n}\n',
    );
    const bad = await runCli(scenario, ["config", "set", "ruleCap", "0"]);
    expect(bad.code).toBe(1);
    expect(bad.stderr).toBe(' ERROR  ruleCap expects a positive integer, got "0"\n');
    const badAgent = await runCli(scenario, ["config", "set", "agents", "Vim"]);
    expect(badAgent.code).toBe(1);
    expect((await runCli(scenario, ["config", "set", "agents", "team-agent,codex"])).code).toBe(0);
    expect((await runCli(scenario, ["config", "get", "agents"])).stdout).toBe(
      '["team-agent","codex"]\n',
    );
    expect((await runCli(scenario, ["config", "unset", "rule"])).code).toBe(0);
    expect((await runCli(scenario, ["config", "get", "rule"])).stdout).toBe("");
    const before = await snapshot(scenario.home);
    expect((await runCli(scenario, ["config", "set", "yes", "true", "--dry-run"])).code).toBe(0);
    expect(await snapshot(scenario.home)).toBe(before);
    writeFileSync(homePaths(scenario.home).config, "{ not json");
    const broken = await runCli(scenario, ["config", "get"]);
    expect(broken.code).toBe(4);
  });
});

test("install replays every manifest entry at project scope and syncs once", async () => {
  await withScenario(
    { project: true, github: { "a/b": SKILLS, "a/d": DOTFILES } },
    async (scenario) => {
      const none = await runCli(scenario, ["install"]);
      expect(none.code).toBe(0);
      expect(none.stdout).toContain("o  no manifest\n");
      mkdirSync(join(scenario.cwd, ".agents"), { recursive: true });
      writeFileSync(
        join(scenario.cwd, ".agents", "maxims.lock"),
        JSON.stringify({
          version: 1,
          sources: {
            "@a/b": {
              from: { type: "github", repo: "a/b" },
              select: ["skip-unfit-skills"],
              rule: true,
              harnesses: ["codex", "cursor"],
            },
            "@a/d#v1": {
              from: { type: "github", repo: "a/d" },
              pin: "v1",
              select: "*",
              rule: false,
              harnesses: ["codex"],
            },
          },
        }),
      );
      const syncCalls = scenario.engine.calls.sync.length;
      const run = await runCli(scenario, ["install", "-a", "codex"]);
      expect(run.stderr).toBe("");
      expect(run.code).toBe(0);
      expect(run.stdout).toContain("o  Found 2 sources in ");
      expect(scenario.engine.calls.sync.filter((call) => !call.dryRun)).toHaveLength(1);
      expect(scenario.engine.calls.sync.length).toBe(syncCalls + 2);
      const state = readState(scenario) as {
        sources: Record<
          string,
          {
            intent: {
              destination: unknown;
              harnesses: string[];
              select: unknown;
              from: { ref: string };
            };
          }
        >;
      };
      expect(Object.keys(state.sources).sort()).toEqual(["@a/b", "@a/d#v1"]);
      expect(state.sources["@a/b"]?.intent).toMatchObject({
        destination: { scope: "project" },
        harnesses: ["codex"],
        select: ["skip-unfit-skills"],
      });
      expect(state.sources["@a/d#v1"]?.intent.from.ref).toBe("v1");
      const badManifest = join(scenario.cwd, ".agents", "maxims.lock");
      writeFileSync(
        badManifest,
        JSON.stringify({ version: 1, sources: { x: { from: { type: "local", path: "/tmp/x" } } } }),
      );
      const refused = await runCli(scenario, ["install"]);
      expect(refused.code).toBe(1);
      expect(refused.stderr).toContain("is not a valid manifest");
    },
  );
});

test("lint reports each problem class as path:line: reason and exits 3, clean folders exit 0", async () => {
  await withScenario({}, async (scenario) => {
    const dir = join(scenario.cwd, "memories");
    mkdirSync(dir);
    writeFileSync(
      join(dir, "good-rule.md"),
      "---\nname: good-rule\ndescription: Fine\n---\n\nSee [[missing-target]].\n",
    );
    writeFileSync(
      join(dir, "no-description.md"),
      "---\nname: no-description\nmetadata:\n  type: feedback\n---\n",
    );
    writeFileSync(
      join(dir, "hidden-char.md"),
      "---\nname: hidden-char\ndescription: quiet\u200b text\n---\n",
    );
    writeFileSync(join(dir, "third.md"), "---\nname: third\ndescription: ok\n---\n");
    const run = await runCli(scenario, ["lint", "--cap", "2"]);
    expect(run.code).toBe(3);
    expect(run.stdout).toBe(
      [
        "memories:1: 3 memories is over the rule cap of 2",
        "memories/good-rule.md:6: [[missing-target]] does not name a memory in this folder",
        "memories/hidden-char.md:3: description carries U+200B zero-width character at column 6",
        "memories/no-description.md:1: description is missing or empty",
        "",
      ].join("\n"),
    );
    const json = await runCli(scenario, ["lint", "--json"]);
    expect(json.code).toBe(3);
    expect(JSON.parse(json.stdout)).toMatchObject({ ok: false });
    const clean = join(scenario.cwd, "clean");
    mkdirSync(clean);
    writeFileSync(join(clean, "alpha.md"), "---\nname: alpha\ndescription: A\n---\n[[beta]]\n");
    writeFileSync(join(clean, "beta.md"), "---\nname: beta\ndescription: B\n---\n");
    expect(await runCli(scenario, ["lint", "clean"])).toEqual({ code: 0, stdout: "", stderr: "" });
  });
});

test("doctor reports rule files, frontmatter, hooks, tiers and --expect without writing", async () => {
  await withScenario(
    { project: true, github: { "a/b": SKILLS }, hookMissing: ["codex"], tier2: ["codex"] },
    async (scenario) => {
      expect(
        (
          await runCli(scenario, [
            "add",
            "@a/b",
            "-p",
            "-a",
            "codex,cursor",
            "--rule",
            "--add-hook",
          ])
        ).code,
      ).toBe(0);
      writeFileSync(
        join(scenario.cwd, "AGENTS.md"),
        `# project\n\n${block("@a/b", ["gate-exit-conditions-the-merge"])}`,
      );
      mkdirSync(join(scenario.cwd, ".cursor", "rules"), { recursive: true });
      writeFileSync(
        join(scenario.cwd, ".cursor", "rules", "maxims-a-b.mdc"),
        block("@a/b", ["gate-exit-conditions-the-merge"]),
      );
      const stamp = homePaths(scenario.home).lastSync;
      writeFileSync(stamp, "");
      utimesSync(stamp, new Date("2026-09-20T11:56:00.000Z"), new Date("2026-09-20T11:56:00.000Z"));
      const before = await snapshot(scenario.root);
      const run = await runCli(scenario, [
        "doctor",
        "--expect",
        "gate-exit-conditions-the-merge",
        "--expect",
        "@a/b/skip-unfit-skills",
      ]);
      expect(run.code).toBe(1);
      expect(run.stdout).toBe(
        [
          "ok  codex: AGENTS.md",
          "x   codex: hook missing (run maxims add <source> --add-hook)",
          "!   codex: tier 2 on this machine",
          "x   cursor: .cursor/rules/maxims-a-b.mdc lacks the frontmatter Cursor needs to load it every session",
          "ok  expect gate-exit-conditions-the-merge: rule line in place",
          "x   expect @a/b/skip-unfit-skills: no rule line in AGENTS.md, .cursor/rules/maxims-a-b.mdc",
          "ok  last sync 4m ago",
          "Defaults: rule=false addHook=false",
          "",
        ]
          .join("\n")
          .replaceAll("AGENTS.md", join(scenario.cwd, "AGENTS.md"))
          .replaceAll(".cursor/rules", join(scenario.cwd, ".cursor", "rules")),
      );
      expect(await snapshot(scenario.root)).toBe(before);
      writeFileSync(
        join(scenario.cwd, ".cursor", "rules", "maxims-a-b.mdc"),
        `${CURSOR_FRONTMATTER}${block("@a/b", ["gate-exit-conditions-the-merge", "skip-unfit-skills"])}`,
      );
      writeFileSync(
        join(scenario.cwd, "AGENTS.md"),
        block("@a/b", ["skip-unfit-skills", "gate-exit-conditions-the-merge"]),
      );
      scenario.options.hookMissing = [];
      scenario.options.tier2 = [];
      const prose = await runCli(scenario, ["doctor", "--expect", "no-sleep-waiting-on-subagents"]);
      expect(prose.code).toBe(1);
      expect(prose.stdout).toContain("x   expect no-sleep-waiting-on-subagents: no rule line in ");
      const healthy = await runCli(scenario, ["doctor", "--expect", "skip-unfit-skills", "--json"]);
      expect(healthy.code).toBe(0);
      const body = JSON.parse(healthy.stdout) as {
        ok: boolean;
        harnesses: { id: string; hook: string }[];
        expect: { name: string; met: boolean; checked: number; missing: string[] }[];
      };
      expect(body.ok).toBe(true);
      expect(body.harnesses.map((h) => [h.id, h.hook])).toEqual([
        ["codex", "current"],
        ["cursor", "none"],
      ]);
      expect(body.expect).toEqual([
        { name: "skip-unfit-skills", met: true, checked: 2, missing: [] },
      ]);
    },
  );
});

test("link adds harnesses with a target and syncs them; unlink is the remove -a path", async () => {
  await withScenario({ github: { "a/b": SKILLS } }, async (scenario) => {
    await installSkills(scenario);
    const link = await runCli(scenario, ["link", "@A/B", "-a", "claude-code,cursor"]);
    expect(link.code).toBe(0);
    expect(link.stdout).toContain("!  cursor has no global target; skipped\n");
    const state = readState(scenario) as {
      sources: Record<string, { intent: { harnesses: string[] } }>;
    };
    expect(state.sources["@a/b"]?.intent.harnesses).toEqual(["codex", "claude-code"]);
    expect(scenario.engine.calls.sync.at(-1)).toMatchObject({
      fetch: "none",
      agents: ["claude-code"],
    });
    const nothing = await runCli(scenario, ["link", "@a/b", "-a", "cursor"]);
    expect(nothing.code).toBe(3);
    const unlink = await runCli(scenario, ["unlink", "@a/b", "-a", "claude-code"]);
    expect(unlink.code).toBe(0);
    expect(scenario.engine.calls.remove).toEqual([
      {
        quiet: false,
        dryRun: false,
        json: false,
        targets: ["@a/b"],
        all: false,
        agents: ["claude-code"],
        confirmed: true,
      },
    ]);
  });
});

test("remove needs -y non-interactively, --all spells it out, and a bare name resolves or is ambiguous", async () => {
  await withScenario({ github: { "a/b": SKILLS, "a/d": DOTFILES } }, async (scenario) => {
    await installSkills(scenario);
    const refused = await runCli(scenario, ["remove", "@a/b"]);
    expect(refused.code).toBe(1);
    expect(refused.stderr).toBe(
      " ERROR  Interactive prompt required but stdin is not a TTY. Nothing was removed. Use -y to run non-interactively.\n",
    );
    expect(scenario.engine.calls.remove).toEqual([]);
    expect((await runCli(scenario, ["remove", "skip-unfit-skills", "-y"])).code).toBe(0);
    expect(scenario.engine.calls.remove.at(-1)).toEqual({
      quiet: false,
      dryRun: false,
      json: false,
      targets: [{ source: "@a/b", memory: mn("skip-unfit-skills") }],
      all: false,
      confirmed: true,
    });
    const scopedSource = await runCli(scenario, ["remove", "@a/b", "-p", "-y"]);
    expect(scopedSource.code).toBe(1);
    expect(scopedSource.stderr).toBe(
      " ERROR  @a/b has one recorded destination; drop -g, -p or -o\n",
    );
    const oneHarness = await runCli(scenario, [
      "remove",
      "@a/b/skip-unfit-skills",
      "-a",
      "codex",
      "-y",
    ]);
    expect(oneHarness.code).toBe(1);
    expect(oneHarness.stderr).toContain("-a applies to a source, not to the memory");
    expect(
      (
        await runCli(scenario, [
          "add",
          "@a/d",
          "-g",
          "-a",
          "codex",
          "--rename",
          "gate-exit-conditions-the-merge=merge-gate",
        ])
      ).code,
    ).toBe(0);
    expect((await runCli(scenario, ["remove", "private-note", "-y"])).code).toBe(1);
    const twin = readState(scenario) as {
      sources: Record<string, { intent: { rename: unknown } }>;
    };
    const dotfiles = twin.sources["@a/d"];
    if (dotfiles !== undefined) dotfiles.intent.rename = {};
    writeState(scenario, twin);
    const ambiguous = await runCli(scenario, ["remove", "gate-exit-conditions-the-merge", "-y"]);
    expect(ambiguous.code).toBe(1);
    expect(ambiguous.stderr).toBe(
      " ERROR  gate-exit-conditions-the-merge is provided by 2 sources; name one of @a/b/gate-exit-conditions-the-merge, @a/d/gate-exit-conditions-the-merge\n",
    );
    const qualified = await runCli(scenario, [
      "remove",
      "@a/d/gate-exit-conditions-the-merge",
      "-y",
    ]);
    expect(qualified.code).toBe(0);
    expect(scenario.engine.calls.remove.at(-1)?.targets).toEqual([
      { source: "@a/d", memory: mn("gate-exit-conditions-the-merge") },
    ]);
    const all = await runCli(scenario, ["remove", "--all", "-a", "codex"]);
    expect(all.code).toBe(0);
    expect(scenario.engine.calls.remove.at(-1)).toMatchObject({
      targets: [],
      all: true,
      agents: ["codex"],
      confirmed: true,
    });
    const scopedAll = await runCli(scenario, ["remove", "--all", "-g"]);
    expect(scopedAll.code).toBe(1);
    expect(scopedAll.stderr).toBe(" ERROR  --all removes every source; drop -g, -p or -o\n");
    const narrowed = await runCli(scenario, ["remove", "@a/b", "-y", "-m", "skip-unfit-skills"]);
    expect(narrowed.code).toBe(0);
    expect(scenario.engine.calls.remove.at(-1)?.targets).toEqual([
      { source: "@a/b", memory: mn("skip-unfit-skills") },
    ]);
    const scoped = await runCli(scenario, [
      "remove",
      "@a/b",
      "-y",
      "-m",
      "skip-unfit-skills",
      "-a",
      "codex",
    ]);
    expect(scoped.code).toBe(1);
    expect(scoped.stderr).toBe(" ERROR  -a applies to a whole source; drop -m to unlink @a/b\n");
  });
});

test("disable and enable edit the per-scope list in state, then sync", async () => {
  await withScenario({ github: { "a/b": SKILLS } }, async (scenario) => {
    await installSkills(scenario);
    const disabled = await runCli(scenario, ["disable", "skip-unfit-skills"]);
    expect(disabled.code).toBe(0);
    expect(readState(scenario).disabled).toEqual({ global: ["skip-unfit-skills"] });
    expect(disabled.stdout).toContain("o  Disabled skip-unfit-skills at global scope\n");
    expect(Object.keys(lastSyncCall(scenario))).not.toContain("agents");
    const enabled = await runCli(scenario, ["enable", "@a/b/skip-unfit-skills"]);
    expect(enabled.code).toBe(0);
    expect(enabled.stdout).toContain("o  Enabled skip-unfit-skills at global scope\n");
    expect(readState(scenario).disabled).toBeUndefined();
    const again = await runCli(scenario, ["enable", "@a/b/skip-unfit-skills"]);
    expect(again.code).toBe(0);
    expect(again.stdout).toContain("o  skip-unfit-skills was not disabled at global\n");
    expect(scenario.engine.calls.sync.filter((call) => !call.dryRun)).toHaveLength(4);
    const quiet = await runCli(scenario, ["disable", "skip-unfit-skills", "--quiet"]);
    expect(quiet).toEqual({ code: 0, stdout: "", stderr: "" });
    expect(lastSyncCall(scenario).quiet).toBe(false);
    const project = await runCli(scenario, ["disable", "skip-unfit-skills", "-p"]);
    expect(project.code).toBe(1);
    expect(project.stderr).toContain("a project-scoped change needs a project root");
  });
});

// The engine prints for `sync`, so the command line adds nothing of its own to stdout: what the
// fake returns is not echoed, and the flags reach the engine as its own options.
test("sync hands the engine its fetch intent, its filter and the output modes, adding no line of its own", async () => {
  await withScenario(
    { project: true, syncReport: { notices: ["maxims: a notice"] } },
    async (scenario) => {
      const quiet = await runCli(scenario, ["sync", "--quiet", "--no-fetch", "-a", "codex"]);
      expect(quiet).toEqual({ code: 0, stdout: "", stderr: "" });
      expect(scenario.engine.calls.sync).toEqual([
        { quiet: true, dryRun: false, json: false, fetch: "none", agents: ["codex"] },
      ]);
      const loud = await runCli(scenario, ["sync"]);
      expect(loud).toEqual({ code: 0, stdout: "", stderr: "" });
      expect(lastSyncCall(scenario)).toEqual({
        quiet: false,
        dryRun: false,
        json: false,
        fetch: "due",
      });
      expect((await runCli(scenario, ["sync", "--json"])).code).toBe(0);
      expect(lastSyncCall(scenario).json).toBe(true);
    },
  );
});

test("mcp-serve hands the stub a quiet sync and stays out of --help", async () => {
  await withScenario({}, async (scenario) => {
    const run = await runCli(scenario, ["mcp-serve"]);
    expect(run.code).toBe(0);
    expect(scenario.engine.calls.mcpServe).toBe(1);
    expect(scenario.engine.calls.sync).toEqual([
      { quiet: true, dryRun: false, json: false, fetch: "due" },
    ]);
    const help = await runCli(scenario, ["--help"]);
    expect(help.stdout).not.toContain("mcp-serve");
    const json = await runCli(scenario, ["mcp-serve", "--json"]);
    expect(json.code).toBe(1);
    expect(JSON.parse(json.stdout)).toMatchObject({
      ok: false,
      code: 1,
      message: "mcp-serve speaks MCP on stdout; drop --json",
    });
    expect(scenario.engine.calls.mcpServe).toBe(1);
  });
});

// The engine prints the listing; the command line only dispatches, so the report the fake
// returns is not echoed and the output flags reach the engine as its own options.
test("list dispatches to the engine with the output modes and prints nothing of its own", async () => {
  await withScenario({}, async (scenario) => {
    expect(await runCli(scenario, ["ls"])).toEqual({ code: 0, stdout: "", stderr: "" });
    expect((await runCli(scenario, ["list", "--json"])).code).toBe(0);
    expect(scenario.engine.calls.list).toEqual([
      { quiet: false, dryRun: false, json: false },
      { quiet: false, dryRun: false, json: true },
    ]);
  });
});

test("remove --all with -m and add @owner/repo@name with --all are refused", async () => {
  await withScenario({ github: { "a/b": SKILLS } }, async (scenario) => {
    await installSkills(scenario);
    const remove = await runCli(scenario, ["remove", "--all", "-m", "skip-unfit-skills", "--json"]);
    expect(remove.code).toBe(1);
    expect(JSON.parse(remove.stdout)).toMatchObject({ ok: false, code: 1 });
    expect(scenario.engine.calls.remove).toEqual([]);
    const add = await runCli(scenario, ["add", "@a/b@skip-unfit-skills", "--all"]);
    expect(add.code).toBe(1);
    expect(add.stderr).toBe(" ERROR  Cannot combine --all with specific memory names.\n");
  });
});

test("a pinned source is addressed by its recorded key on link, unlink, update and remove", async () => {
  await withScenario({ github: { "a/b": SKILLS } }, async (scenario) => {
    expect((await runCli(scenario, ["add", "@a/b", "-g", "-a", "codex", "--pin", "v1"])).code).toBe(
      0,
    );
    expect(Object.keys((readState(scenario) as { sources: object }).sources)).toEqual(["@a/b#v1"]);
    expect((await runCli(scenario, ["link", "@a/b#v1", "-a", "claude-code"])).code).toBe(0);
    expect((await runCli(scenario, ["update", "@A/B#v1"])).code).toBe(0);
    expect(scenario.engine.calls.sync.at(-1)?.only).toEqual(["@a/b#v1"]);
    expect((await runCli(scenario, ["unlink", "@a/b#v1", "-a", "claude-code"])).code).toBe(0);
    expect((await runCli(scenario, ["remove", "@a/b#v1", "-y"])).code).toBe(0);
    expect(scenario.engine.calls.remove.at(-1)?.targets).toEqual(["@a/b#v1"]);
  });
});

test("sync --quiet exits 0 even on a usage error, and --json wraps errors before the verb parses", async () => {
  await withScenario({ github: { "a/b": SKILLS } }, async (scenario) => {
    const quiet = await runCli(scenario, ["sync", "--quiet", "--bogus"]);
    expect(quiet).toEqual({ code: 0, stdout: "", stderr: "" });
    expect(readFileSync(homePaths(scenario.home).log, "utf8")).toBe(
      "maxims: sync failed (exit 1): unknown option: --bogus\n",
    );
    rmSync(scenario.home, { recursive: true, force: true });
    const dry = await runCli(scenario, ["sync", "--quiet", "--dry-run", "--bogus"]);
    expect(dry).toEqual({ code: 0, stdout: "", stderr: "" });
    expect(existsSync(scenario.home)).toBe(false);
    mkdirSync(scenario.home, { recursive: true });
    const json = await runCli(scenario, ["add", "@a/b", "--json", "-y", "--bogus"]);
    expect(json.code).toBe(1);
    expect(JSON.parse(json.stdout)).toEqual({
      ok: false,
      code: 1,
      message: "unknown option: --bogus",
    });
    const verb = await runCli(scenario, ["frob", "--json"]);
    expect(verb.code).toBe(1);
    expect(JSON.parse(verb.stdout)).toMatchObject({
      ok: false,
      code: 1,
      message: "Unknown command: frob",
    });
    const unset = await runCli(scenario, ["config", "get", "rule", "--json"]);
    expect(unset.stdout).toBe("null\n");
  });
});

test("install --json with no manifest emits one document, and a bad entry records nothing", async () => {
  await withScenario(
    { project: true, github: { "a/b": SKILLS, "a/d": DOTFILES } },
    async (scenario) => {
      const none = await runCli(scenario, ["install", "-y", "--json"]);
      expect(none.code).toBe(0);
      expect(JSON.parse(none.stdout)).toMatchObject({ ok: true, sources: [] });
      mkdirSync(join(scenario.cwd, ".agents"), { recursive: true });
      const entry = (repo: string, select: unknown) => ({
        from: { type: "github", repo },
        select,
        rule: false,
        harnesses: ["codex"],
      });
      const manifest = {
        version: 1,
        sources: { "@a/b": entry("a/b", "*"), "@a/d": entry("a/d", ["ghost"]) },
      };
      writeFileSync(join(scenario.cwd, ".agents", "maxims.lock"), JSON.stringify(manifest));
      const before = await snapshot(scenario.root);
      const run = await runCli(scenario, ["install"]);
      expect(run.code).toBe(3);
      expect(await snapshot(scenario.root)).toBe(before);
      expect(scenario.engine.calls.sync).toEqual([]);
    },
  );
});

test("lint honors an absolute path and refuses a folder it cannot read", async () => {
  await withScenario({}, async (scenario) => {
    const dir = join(scenario.root, "elsewhere");
    mkdirSync(dir);
    writeFileSync(join(dir, "bad.md"), "---\nname: bad\n---\n");
    const absolute = await runCli(scenario, ["lint", dir]);
    expect(absolute.code).toBe(3);
    expect(absolute.stdout).toContain("bad.md:1: description is missing or empty\n");
    const missing = await runCli(scenario, ["lint", "nowhere"]);
    expect(missing.code).toBe(1);
    expect(missing.stderr).toContain(" ERROR  cannot read ");
    // A permission refusal reads the same as an absent folder: lint inspected nothing there, so
    // it is a failed check (exit 1), never the destination-write code. Root ignores modes.
    if (process.getuid?.() === 0) return;
    const nested = join(dir, "locked");
    mkdirSync(nested);
    chmodSync(nested, 0o000);
    try {
      const locked = await runCli(scenario, ["lint", dir, "--full-depth"]);
      expect(locked.code).toBe(1);
      expect(locked.stderr).toContain(` ERROR  cannot read ${nested}: EACCES`);
    } finally {
      chmodSync(nested, 0o755);
    }
  });
});

test("--dry-run on disable and on link plans against the would-be state and writes nothing", async () => {
  await withScenario({ github: { "a/b": SKILLS } }, async (scenario) => {
    await installSkills(scenario);
    expect((await runCli(scenario, ["disable", "skip-unfit-skills", "--dry-run"])).code).toBe(0);
    expect(lastSyncCall(scenario).dryRun).toBe(true);
    expect(lastSyncCall(scenario).preview?.state.disabled).toEqual({
      global: [mn("skip-unfit-skills")],
    });
    expect(readState(scenario).disabled).toBeUndefined();
    const before = await snapshot(scenario.home);
    expect((await runCli(scenario, ["link", "@a/b", "-a", "claude-code", "--dry-run"])).code).toBe(
      0,
    );
    expect(await snapshot(scenario.home)).toBe(before);
    const planned = scenario.engine.calls.sync.at(-1)?.preview;
    expect(planned?.state.sources["@a/b"]?.intent.harnesses).toEqual(["codex", "claude-code"]);
    expect(planned?.config).toEqual({});
  });
});

test("pins differing only in case are different sources, and update --rename is validated first", async () => {
  await withScenario({ github: { "a/b": SKILLS, "a/d": DOTFILES } }, async (scenario) => {
    expect((await runCli(scenario, ["add", "@a/b", "-g", "-a", "codex", "--pin", "v1"])).code).toBe(
      0,
    );
    expect(
      (
        await runCli(scenario, [
          "add",
          "@a/b",
          "-g",
          "-a",
          "codex",
          "--pin",
          "V1",
          "-m",
          "skip-unfit-skills",
          "--rename",
          "skip-unfit-skills=skip-unfit-v1",
        ])
      ).code,
    ).toBe(0);
    expect(Object.keys((readState(scenario) as { sources: object }).sources).sort()).toEqual([
      "@a/b#V1",
      "@a/b#v1",
    ]);
    expect(
      (
        await runCli(scenario, [
          "add",
          "@a/d",
          "-g",
          "-a",
          "codex",
          "--rename",
          "gate-exit-conditions-the-merge=merge-gate",
        ])
      ).code,
    ).toBe(0);
    const before = await snapshot(scenario.home);
    const collides = await runCli(scenario, [
      "update",
      "@a/d",
      "--rename",
      "gate-exit-conditions-the-merge=skip-unfit-skills",
    ]);
    expect(collides.code).toBe(6);
    expect(collides.stderr).toBe(
      " ERROR  skip-unfit-skills is owned by @a/b#v1\nTip: --rename skip-unfit-skills=<new>\n",
    );
    expect(await snapshot(scenario.home)).toBe(before);
  });
});

test("update renders a failed refetch through the error path, also under --json", async () => {
  await withScenario(
    {
      github: { "a/b": SKILLS },
      syncReport: { failed: [{ key: "@a/b", message: "connect timed out", kind: "network" }] },
    },
    async (scenario) => {
      await installSkills(scenario);
      const plain = await runCli(scenario, ["update"]);
      expect(plain.code).toBe(2);
      expect(plain.stdout).not.toContain("up to date");
      expect(plain.stderr).toBe(
        " ERROR  Failed to update @a/b: connect timed out\nTip: the last good copy of each failed source stays installed\n",
      );
      const json = await runCli(scenario, ["update", "--json"]);
      expect(json.code).toBe(2);
      expect(JSON.parse(json.stdout)).toMatchObject({ ok: false, code: 2 });
    },
  );
});

test("mcp-serve passes --dry-run through to its sync", async () => {
  await withScenario({}, async (scenario) => {
    expect((await runCli(scenario, ["mcp-serve", "--dry-run"])).code).toBe(0);
    expect(scenario.engine.calls.sync.at(-1)?.dryRun).toBe(true);
  });
});

test("install prepares entries against each other: a wikilink into a sibling entry resolves", async () => {
  await withScenario(
    { project: true, github: { "a/b": SKILLS, "a/d": DOTFILES } },
    async (scenario) => {
      const linked = join(scenario.root, "linked", "memories");
      mkdirSync(linked, { recursive: true });
      writeFileSync(
        join(linked, "follow-up.md"),
        "---\nname: follow-up\ndescription: Depends on a sibling\n---\nSee [[skip-unfit-skills]].\n",
      );
      scenario.options.github = {
        ...scenario.options.github,
        "a/l": join(scenario.root, "linked"),
      };
      mkdirSync(join(scenario.cwd, ".agents"), { recursive: true });
      const entry = (repo: string) => ({
        from: { type: "github", repo },
        select: "*",
        rule: false,
        harnesses: ["codex"],
      });
      writeFileSync(
        join(scenario.cwd, ".agents", "maxims.lock"),
        JSON.stringify({ version: 1, sources: { "@a/l": entry("a/l"), "@a/b": entry("a/b") } }),
      );
      const run = await runCli(scenario, ["install"]);
      expect(run.stderr).toBe("");
      expect(run.code).toBe(0);
      expect(Object.keys((readState(scenario) as { sources: object }).sources).sort()).toEqual([
        "@a/b",
        "@a/l",
      ]);
    },
  );
});

test("a qualified memory must belong to the source it names", async () => {
  await withScenario({ github: { "a/b": SKILLS, "a/d": DOTFILES } }, async (scenario) => {
    await installSkills(scenario);
    const rename = "gate-exit-conditions-the-merge=merge-gate";
    expect(
      (await runCli(scenario, ["add", "@a/d", "-g", "-a", "codex", "--rename", rename])).code,
    ).toBe(0);
    const wrong = await runCli(scenario, ["disable", "@a/b/merge-gate"]);
    expect(wrong.code).toBe(1);
    expect(wrong.stderr).toBe(" ERROR  @a/b does not provide merge-gate\n");
    expect(readState(scenario).disabled).toBeUndefined();
    expect((await runCli(scenario, ["disable", "@a/d/merge-gate"])).code).toBe(0);
    expect(readState(scenario).disabled).toEqual({ global: ["merge-gate"] });
  });
});

test("update threads --cap into its dry-run preview and accepts a rename for a name the last fetch lacked", async () => {
  await withScenario({ github: { "a/b": SKILLS } }, async (scenario) => {
    await installSkills(scenario);
    expect((await runCli(scenario, ["update", "--dry-run", "--cap", "7"])).code).toBe(0);
    expect(scenario.engine.calls.sync.at(-1)?.preview?.config).toEqual({ ruleCap: 7 });
    expect(existsSync(homePaths(scenario.home).config)).toBe(false);
    const fresh = await runCli(scenario, [
      "update",
      "@a/b",
      "--rename",
      "brand-new=brand-new-skills",
    ]);
    expect(fresh.code).toBe(0);
    const state = readState(scenario) as {
      sources: Record<string, { intent: { rename: Record<string, string> } }>;
    };
    expect(state.sources["@a/b"]?.intent.rename).toEqual({ "brand-new": "brand-new-skills" });
  });
});

test("install refuses a batch whose entries would land on one local name", async () => {
  await withScenario(
    { project: true, github: { "a/b": SKILLS, "a/d": DOTFILES } },
    async (scenario) => {
      mkdirSync(join(scenario.cwd, ".agents"), { recursive: true });
      const entry = (repo: string) => ({
        from: { type: "github", repo },
        select: "*",
        rule: false,
        harnesses: ["codex"],
      });
      writeFileSync(
        join(scenario.cwd, ".agents", "maxims.lock"),
        JSON.stringify({ version: 1, sources: { "@a/b": entry("a/b"), "@a/d": entry("a/d") } }),
      );
      const before = await snapshot(scenario.root);
      const run = await runCli(scenario, ["install"]);
      expect(run.code).toBe(6);
      expect(run.stderr).toContain("gate-exit-conditions-the-merge is owned by @a/");
      expect(await snapshot(scenario.root)).toBe(before);
    },
  );
});

test("doctor leaves an -o folder unchecked instead of reading it as a file", async () => {
  await withScenario({ project: true, github: { "a/b": SKILLS } }, async (scenario) => {
    const argv = ["add", "@a/b", "-o", "./team-rules", "-a", "codex", "--rule"];
    expect((await runCli(scenario, argv)).code).toBe(0);
    mkdirSync(join(scenario.cwd, "team-rules"), { recursive: true });
    const run = await runCli(scenario, ["doctor", "--expect", "skip-unfit-skills"]);
    expect(run.code).toBe(1);
    expect(run.stdout).not.toContain("codex:");
    expect(run.stdout).toContain(
      "x   expect skip-unfit-skills: no rule line in any rule-writing source\n",
    );
  });
});

test("remove refuses without -y when stdin is piped even though stdout is a terminal", async () => {
  await withScenario(
    { github: { "a/b": SKILLS }, tty: true, stdinTty: false },
    async (scenario) => {
      await installSkills(scenario);
      const run = await runCli(scenario, ["remove", "@a/b"]);
      expect(run.code).toBe(1);
      expect(run.stderr).toContain("Interactive prompt required");
      expect(scenario.engine.calls.remove).toEqual([]);
    },
  );
});

// The exit follows the report's failure classes: every failure a source with nothing valid is 3,
// anything else 2, and the `--json` document agrees.
test("a failed update exits by the failure class, also under --dry-run --json", async () => {
  await withScenario({ github: { "a/b": SKILLS } }, async (scenario) => {
    await installSkills(scenario, ["-m", "skip-unfit-skills"]);
    scenario.options.syncReport = {
      failed: [{ key: "@a/b", message: "rate limited", kind: "ratelimit" }],
    };
    const failed = await runCli(scenario, ["update", "--dry-run", "--json"]);
    expect(failed.code).toBe(2);
    expect(JSON.parse(failed.stdout)).toMatchObject({ ok: false, code: 2 });
    scenario.options.syncReport = {
      failed: [{ key: "@a/b", message: "no valid memories at memories", kind: "invalid" }],
    };
    const invalid = await runCli(scenario, ["update"]);
    expect(invalid.code).toBe(3);
    expect(invalid.stderr).toContain("Failed to update @a/b: no valid memories at memories");
  });
});

test("an extra positional word is a usage error, not a silent drop", async () => {
  await withScenario({ github: { "a/b": SKILLS } }, async (scenario) => {
    await installSkills(scenario);
    const run = await runCli(scenario, ["remove", "@a/b", "@a/c", "-y"]);
    expect(run.code).toBe(1);
    expect(run.stderr).toBe(" ERROR  unexpected argument: @a/c\n");
    expect(scenario.engine.calls.remove).toEqual([]);
  });
});

test("a manifest whose key disagrees with its entry is refused", async () => {
  await withScenario({ project: true, github: { "a/b": SKILLS } }, async (scenario) => {
    mkdirSync(join(scenario.cwd, ".agents"), { recursive: true });
    const entry = {
      from: { type: "github", repo: "a/b" },
      pin: "v1",
      select: "*",
      rule: false,
      harnesses: ["codex"],
    };
    writeFileSync(
      join(scenario.cwd, ".agents", "maxims.lock"),
      JSON.stringify({ version: 1, sources: { "@a/b": entry } }),
    );
    const run = await runCli(scenario, ["install"]);
    expect(run.code).toBe(1);
    expect(run.stderr).toContain("is not a valid manifest");
    expect(run.stderr).toContain("@a/b#v1");
    const { pin: _pin, ...twin } = entry;
    const upper = { ...twin, from: { ...twin.from, repo: "A/B" } };
    writeFileSync(
      join(scenario.cwd, ".agents", "maxims.lock"),
      JSON.stringify({ version: 1, sources: { "@a/b": twin, "@A/B": upper } }),
    );
    const twins = await runCli(scenario, ["install"]);
    expect(twins.code).toBe(1);
    expect(twins.stderr).toContain("is not a valid manifest");
    expect(twins.stderr).toContain("same GitHub repository");
    const unset = await runCli(scenario, ["config", "unset", "rule", "false"]);
    expect(unset.code).toBe(1);
    expect(unset.stderr).toBe(" ERROR  unexpected argument: false\n");
  });
});

test("an intent edit reports the state write in its dry-run plan", async () => {
  await withScenario({ github: { "a/b": SKILLS } }, async (scenario) => {
    await installSkills(scenario);
    const run = await runCli(scenario, [
      "link",
      "@a/b",
      "-a",
      "claude-code",
      "--dry-run",
      "--json",
    ]);
    expect(run.code).toBe(0);
    const body = JSON.parse(run.stdout) as { plan: { changes: { kind: string; path: string }[] } };
    expect(body.plan.changes.some((c) => c.kind === "write" && c.path.endsWith("state.json"))).toBe(
      true,
    );
  });
});

test("a dry run of an intent edit creates nothing, not even the maxims home", async () => {
  await withScenario({ github: { "a/b": SKILLS } }, async (scenario) => {
    rmSync(scenario.home, { recursive: true, force: true });
    const run = await runCli(scenario, ["add", "@a/b", "-g", "-a", "codex", "--dry-run"]);
    expect(run.code).toBe(0);
    expect(existsSync(scenario.home)).toBe(false);
  });
});

test("disable reports the engine's intent write in its plan and remove refuses -m on a memory", async () => {
  await withScenario({ github: { "a/b": SKILLS } }, async (scenario) => {
    await installSkills(scenario);
    const run = await runCli(scenario, ["disable", "skip-unfit-skills", "--dry-run", "--json"]);
    expect(run.code).toBe(0);
    const body = JSON.parse(run.stdout) as { plan: { changes: { path: string }[] } };
    expect(body.plan.changes.some((c) => c.path.endsWith("state.json"))).toBe(true);
    const yes = await runCli(scenario, ["disable", "skip-unfit-skills", "-y"]);
    expect(yes.code).toBe(1);
    expect(yes.stderr).toBe(" ERROR  unknown option: -y\n");
    const refused = await runCli(scenario, [
      "remove",
      "skip-unfit-skills",
      "-m",
      "gate-exit-conditions-the-merge",
      "-y",
    ]);
    expect(refused.code).toBe(1);
    expect(refused.stderr).toContain("names a memory; -m narrows a source");
  });
});

test("install replays the manifest's disabled names as project-scope disables", async () => {
  await withScenario({ project: true, github: { "a/b": SKILLS } }, async (scenario) => {
    mkdirSync(join(scenario.cwd, ".agents"), { recursive: true });
    const lock = {
      version: 1,
      sources: {
        "@a/b": {
          from: { type: "github", repo: "a/b" },
          select: "*",
          rule: true,
          harnesses: ["codex"],
        },
      },
      disabled: ["skip-unfit-skills"],
    };
    writeFileSync(join(scenario.cwd, ".agents", "maxims.lock"), JSON.stringify(lock));
    const dry = await runCli(scenario, ["install", "--dry-run", "--json", "-y"]);
    expect(dry.code).toBe(0);
    const plan = JSON.parse(dry.stdout) as { plan: { changes: { path: string }[] } };
    expect(plan.plan.changes.filter((c) => c.path.endsWith("state.json"))).toHaveLength(1);
    const run = await runCli(scenario, ["install"]);
    expect(run.stderr).toBe("");
    expect(run.code).toBe(0);
    expect(readState(scenario).disabled).toEqual({
      project: { [scenario.cwd]: ["skip-unfit-skills"] },
    });
    // A name switched off may belong to any project source, so the sync reaches every harness.
    const real = scenario.engine.calls.sync.filter((call) => !call.dryRun);
    expect(real).toHaveLength(1);
    expect(Object.keys(real[0] ?? {})).not.toContain("agents");
  });
});

test("a manifest local source that leaves the project is refused", async () => {
  await withScenario({ project: true }, async (scenario) => {
    mkdirSync(join(scenario.cwd, ".agents"), { recursive: true });
    const lock = {
      version: 1,
      sources: {
        "../outside": {
          from: { type: "local", path: "../outside" },
          select: "*",
          rule: false,
          harnesses: ["codex"],
        },
      },
    };
    writeFileSync(join(scenario.cwd, ".agents", "maxims.lock"), JSON.stringify(lock));
    const run = await runCli(scenario, ["install"]);
    expect(run.code).toBe(1);
    expect(run.stderr).toContain(
      "is not a valid manifest: manifest source ../outside leaves the project root\n",
    );
  });
});

test("a live project source is projected as .", async () => {
  await withScenario({ project: true }, async (scenario) => {
    mkdirSync(join(scenario.cwd, "memories"));
    writeFileSync(
      join(scenario.cwd, "memories", "own-rule.md"),
      "---\nname: own-rule\ndescription: Ours\n---\n",
    );
    expect((await runCli(scenario, ["add", ".", "-p", "-a", "codex"])).code).toBe(0);
    const lock = JSON.parse(readFileSync(join(scenario.cwd, ".agents", "maxims.lock"), "utf8")) as {
      sources: Record<string, { from: { type: string; path: string; live?: boolean } }>;
    };
    expect(Object.keys(lock.sources)).toEqual(["."]);
    expect(lock.sources["."]?.from).toEqual({ type: "local", path: ".", live: true });
  });
});

test("a dry-run install hands the disabled-list edit the state it staged", async () => {
  await withScenario({ project: true, github: { "a/b": SKILLS } }, async (scenario) => {
    mkdirSync(join(scenario.cwd, ".agents"), { recursive: true });
    const lock = {
      version: 1,
      sources: {
        "@a/b": {
          from: { type: "github", repo: "a/b" },
          select: "*",
          rule: true,
          harnesses: ["codex"],
        },
      },
      disabled: ["skip-unfit-skills"],
    };
    writeFileSync(join(scenario.cwd, ".agents", "maxims.lock"), JSON.stringify(lock));
    const run = await runCli(scenario, ["install", "--dry-run"]);
    expect(run.code).toBe(0);
    const preview = lastSyncCall(scenario).preview;
    expect(Object.keys(preview?.state.sources ?? {})).toEqual(["@a/b"]);
    expect(preview?.state.disabled).toEqual({
      project: { [scenario.cwd]: [mn("skip-unfit-skills")] },
    });
    expect(existsSync(homePaths(scenario.home).state)).toBe(false);
  });
});

test("a live manifest source registers no hook even when config asks for one", async () => {
  await withScenario({ project: true }, async (scenario) => {
    mkdirSync(join(scenario.cwd, "memories"));
    writeFileSync(
      join(scenario.cwd, "memories", "own-rule.md"),
      "---\nname: own-rule\ndescription: Ours\n---\n",
    );
    mkdirSync(join(scenario.cwd, ".agents"), { recursive: true });
    const lock = {
      version: 1,
      sources: {
        ".": {
          from: { type: "local", path: ".", live: true },
          select: "*",
          rule: false,
          harnesses: ["codex"],
        },
      },
    };
    writeFileSync(join(scenario.cwd, ".agents", "maxims.lock"), JSON.stringify(lock));
    writeConfig(scenario, { addHook: true });
    const run = await runCli(scenario, ["install"]);
    expect(run.stderr).toBe("");
    expect(run.code).toBe(0);
    expect(run.stdout).not.toContain("Hook registered");
    expect((readState(scenario) as { hooks: string[] }).hooks).toEqual([]);
  });
});

test("a manifest local source reached through a symlink out of the checkout is refused", async () => {
  await withScenario({ project: true }, async (scenario) => {
    const outside = join(scenario.root, "outside", "memories");
    mkdirSync(outside, { recursive: true });
    writeFileSync(join(outside, "leak.md"), "---\nname: leak\ndescription: Outside\n---\n");
    symlinkSync(join(scenario.root, "outside"), join(scenario.cwd, "rules"));
    mkdirSync(join(scenario.cwd, ".agents"), { recursive: true });
    const lock = {
      version: 1,
      sources: {
        rules: {
          from: { type: "local", path: "rules" },
          select: "*",
          rule: false,
          harnesses: ["codex"],
        },
      },
    };
    writeFileSync(join(scenario.cwd, ".agents", "maxims.lock"), JSON.stringify(lock));
    const run = await runCli(scenario, ["install"]);
    expect(run.code).toBe(1);
    expect(run.stderr).toContain(
      "is not a valid manifest: manifest source rules leaves the project root\n",
    );
  });
});

test("two manifest spellings of one source are refused, and an undefined harness id is kept", async () => {
  await withScenario({ project: true, github: { "a/b": SKILLS } }, async (scenario) => {
    mkdirSync(join(scenario.cwd, "memories"));
    writeFileSync(
      join(scenario.cwd, "memories", "own-rule.md"),
      "---\nname: own-rule\ndescription: Ours\n---\n",
    );
    mkdirSync(join(scenario.cwd, ".agents"), { recursive: true });
    const local = (path: string) => ({
      from: { type: "local", path },
      select: "*",
      rule: false,
      harnesses: ["codex"],
    });
    writeFileSync(
      join(scenario.cwd, ".agents", "maxims.lock"),
      JSON.stringify({ version: 1, sources: { ".": local("."), "./": local("./") } }),
    );
    const twins = await runCli(scenario, ["install"]);
    expect(twins.code).toBe(1);
    expect(twins.stderr).toContain("name the same source");
    const custom = {
      version: 1,
      sources: {
        "@a/b": {
          from: { type: "github", repo: "a/b" },
          select: "*",
          rule: false,
          harnesses: ["team-agent"],
        },
      },
    };
    writeFileSync(join(scenario.cwd, ".agents", "maxims.lock"), JSON.stringify(custom));
    const kept = await runCli(scenario, ["install"]);
    expect(kept.code).toBe(0);
    expect(kept.stdout).toContain(
      "!  team-agent is not defined on this machine; kept in intent, skipped until it is\n",
    );
    const state = readState(scenario) as {
      sources: Record<string, { intent: { harnesses: string[] } }>;
    };
    expect(state.sources["@a/b"]?.intent.harnesses).toEqual(["team-agent"]);
  });
});

test("a project directory named like an object property projects into the manifest", async () => {
  await withScenario({ project: true }, async (scenario) => {
    mkdirSync(join(scenario.cwd, "constructor", "memories"), { recursive: true });
    writeFileSync(
      join(scenario.cwd, "constructor", "memories", "own-rule.md"),
      "---\nname: own-rule\ndescription: Ours\n---\n",
    );
    const run = await runCli(scenario, ["add", "./constructor", "-p", "-a", "codex"]);
    expect(run.stderr).toBe("");
    expect(run.code).toBe(0);
    const lock = JSON.parse(readFileSync(join(scenario.cwd, ".agents", "maxims.lock"), "utf8")) as {
      sources: object;
    };
    expect(Object.keys(lock.sources)).toEqual(["./constructor"]);
  });
});

// The `./` prefix keeps a drive-relative or prototype-named directory representable; a name the
// marker grammar refuses everywhere is still refused before anything is written.
test("a project directory the manifest grammar cannot name is refused before anything is written", async () => {
  await withScenario({ project: true }, async (scenario) => {
    const memory = (name: string) => `---\nname: ${name}\ndescription: Ours\n---\n`;
    for (const [name, rule] of [
      ["a:rules", "drive-rule"],
      ["__proto__", "proto-rule"],
    ]) {
      mkdirSync(join(scenario.cwd, name, "memories"), { recursive: true });
      writeFileSync(join(scenario.cwd, name, "memories", `${rule}.md`), memory(rule));
      const run = await runCli(scenario, ["add", `./${name}`, "-p", "-a", "codex"]);
      expect(run.stderr).toBe("");
      expect(run.code).toBe(0);
    }
    const lock = JSON.parse(readFileSync(join(scenario.cwd, ".agents", "maxims.lock"), "utf8")) as {
      sources: object;
    };
    expect(Object.keys(lock.sources).sort()).toEqual(["./__proto__", "./a:rules"]);
    const unnameable = "rules-->x";
    mkdirSync(join(scenario.cwd, unnameable, "memories"), { recursive: true });
    writeFileSync(
      join(scenario.cwd, unnameable, "memories", "arrow-rule.md"),
      memory("arrow-rule"),
    );
    const before = await snapshot(scenario.root);
    const run = await runCli(scenario, ["add", `./${unnameable}`, "-p", "-a", "codex"]);
    expect(run.code).toBe(1);
    expect(run.stderr).toContain("cannot be written into");
    expect(await snapshot(scenario.root)).toBe(before);
  });
});

test("a project source added through an alias symlink is recorded by its real path in the checkout", async () => {
  await withScenario({ project: true }, async (scenario) => {
    mkdirSync(join(scenario.cwd, "rules", "memories"), { recursive: true });
    writeFileSync(
      join(scenario.cwd, "rules", "memories", "own-rule.md"),
      "---\nname: own-rule\ndescription: Ours\n---\n",
    );
    const alias = join(scenario.root, "alias");
    symlinkSync(join(scenario.cwd, "rules"), alias);
    const run = await runCli(scenario, ["add", alias, "-p", "-a", "codex"]);
    expect(run.stderr).toBe("");
    expect(run.code).toBe(0);
    const lock = JSON.parse(readFileSync(join(scenario.cwd, ".agents", "maxims.lock"), "utf8")) as {
      sources: object;
    };
    expect(Object.keys(lock.sources)).toEqual(["./rules"]);
    expect(Object.keys((readState(scenario) as { sources: object }).sources)).toEqual([
      realpathSync(join(scenario.cwd, "rules")),
    ]);
    expect((await runCli(scenario, ["link", alias, "-a", "claude-code"])).code).toBe(0);
    expect((await runCli(scenario, ["update", alias])).code).toBe(0);
  });
});

// `--cap` and `--cooldown` persist, so a request that fails to parse after them must not have
// written config.json on its way to the usage error.
const persistingInvocations: [string, string[]][] = [
  ["sync", ["sync", "--cap", "40", "--agent", "codx"]],
  ["update", ["update", "--cooldown", "2", "--agent", "codx"]],
  ["update --rename", ["update", "--cap", "40", "--rename", "skip-unfit-skills=skip-unfit"]],
];

test.each(persistingInvocations)(
  "%s validates the whole request before persisting --cap and --cooldown",
  async (_name, argv) => {
    await withScenario({ github: { "a/b": SKILLS } }, async (scenario) => {
      await installSkills(scenario);
      const before = await snapshot(scenario.root);
      const run = await runCli(scenario, argv);
      expect(run.code).toBe(1);
      expect(existsSync(homePaths(scenario.home).config)).toBe(false);
      expect(await snapshot(scenario.root)).toBe(before);
    });
  },
);

test("sync exits by the report's failure class, except under --quiet", async () => {
  await withScenario(
    {
      github: { "a/b": SKILLS },
      syncReport: { failed: [{ key: "@a/b", message: "connect timed out", kind: "network" }] },
    },
    async (scenario) => {
      await installSkills(scenario);
      expect((await runCli(scenario, ["sync"])).code).toBe(2);
      expect((await runCli(scenario, ["sync", "--json"])).code).toBe(2);
      scenario.options.syncReport = {
        failed: [{ key: "@a/b", message: "no valid memories", kind: "invalid" }],
      };
      expect((await runCli(scenario, ["sync"])).code).toBe(3);
      const quiet = await runCli(scenario, ["sync", "--quiet"]);
      expect(quiet).toEqual({ code: 0, stdout: "", stderr: "" });
    },
  );
});

// The fixture harnesses mirror the real definitions' shapes, so the real cursor and zed run here
// once: cursor's frontmatter arrives fenced from the definition, and zed reads `.rules` before
// `AGENTS.md`, two facts a fixture cannot vouch for.
test("doctor judges the frontmatter and the precedence file the real definitions write", async () => {
  await withScenario(
    { project: true, github: { "a/b": SKILLS }, harnesses: [cursor, zed] },
    async (scenario) => {
      writeFileSync(join(scenario.cwd, ".rules"), "# zed\n");
      const add = await runCli(scenario, ["add", "@a/b", "-p", "-a", "cursor,zed", "--rule"]);
      expect(add.code).toBe(0);
      const rendered = block("@a/b", ["skip-unfit-skills"]);
      const target = cursor.targets.project;
      if (target === null || target.kind !== "rules-dir" || target.frontmatter === undefined) {
        throw new Error("the cursor definition no longer declares a rules-dir frontmatter");
      }
      mkdirSync(join(scenario.cwd, ".cursor", "rules"), { recursive: true });
      const mdc = join(scenario.cwd, ".cursor", "rules", "maxims-a-b.mdc");
      writeFileSync(mdc, `${target.frontmatter({})}${rendered}`);
      const rules = join(scenario.cwd, ".rules");
      writeFileSync(rules, `# zed\n\n${rendered}`);
      const healthy = await runCli(scenario, ["doctor", "--expect", "skip-unfit-skills"]);
      expect(healthy.code).toBe(0);
      expect(healthy.stdout).toContain(`ok  cursor: ${mdc}\n`);
      expect(healthy.stdout).toContain(`ok  zed: ${rules}\n`);
      expect(healthy.stdout).toContain("ok  expect skip-unfit-skills: rule line in place\n");
      writeFileSync(mdc, rendered);
      const bare = await runCli(scenario, ["doctor"]);
      expect(bare.code).toBe(1);
      expect(bare.stdout).toContain(
        `x   cursor: ${mdc} lacks the frontmatter Cursor needs to load it every session\n`,
      );
    },
  );
});

// At user scope a rule line's detail path names the store file, so it carries the upstream name;
// `--expect` is asked for the installed local name, which the rename map produces.
test("doctor --expect finds a renamed memory installed at user scope", async () => {
  await withScenario({ github: { "a/b": SKILLS } }, async (scenario) => {
    const add = await runCli(scenario, [
      "add",
      "@a/b",
      "-g",
      "--rule",
      "-a",
      "codex",
      "--rename",
      "skip-unfit-skills=skip-unfit",
    ]);
    expect(add.code).toBe(0);
    mkdirSync(join(scenario.userHome, ".codex"), { recursive: true });
    writeFileSync(
      join(scenario.userHome, ".codex", "AGENTS.md"),
      block("@a/b", ["skip-unfit-skills", "gate-exit-conditions-the-merge"]),
    );
    const run = await runCli(scenario, ["doctor", "--expect", "skip-unfit"]);
    expect(run.code).toBe(0);
    expect(run.stdout).toContain("ok  expect skip-unfit: rule line in place\n");
    const upstream = await runCli(scenario, ["doctor", "--expect", "skip-unfit-skills"]);
    expect(upstream.code).toBe(1);
  });
});

test("doctor names a harness id no definition answers to and fails an --expect that needs it", async () => {
  await withScenario({ github: { "a/b": SKILLS } }, async (scenario) => {
    await installSkills(scenario);
    const state = readState(scenario) as {
      sources: Record<string, { intent: { harnesses: string[] } }>;
    };
    const entry = state.sources["@a/b"];
    if (entry === undefined) throw new Error("@a/b was not recorded");
    entry.intent.harnesses = ["team-agent"];
    writeState(scenario, state);
    const run = await runCli(scenario, ["doctor", "--expect", "skip-unfit-skills"]);
    expect(run.code).toBe(1);
    expect(run.stdout).toContain(
      "!   team-agent is not defined on this machine; kept in intent, skipped until it is\n",
    );
    expect(run.stdout).toContain(
      "x   expect skip-unfit-skills: no rule line in team-agent (not defined on this machine)\n",
    );
    const json = await runCli(scenario, ["doctor", "--json"]);
    expect(JSON.parse(json.stdout)).toMatchObject({ ok: true, unresolved: ["team-agent"] });
  });
});

test("doctor reports a corrupt state file as a warning and leaves it in place", async () => {
  await withScenario({}, async (scenario) => {
    writeState(scenario, { version: 1, writtenBy: "x", hooks: [], sources: { "@a/b": {} } });
    const before = await snapshot(scenario.home);
    const run = await runCli(scenario, ["doctor"]);
    expect(run.code).toBe(0);
    expect(run.stdout).toContain(
      "!   state.json is corrupt: sources.@a/b.intent: Invalid input: expected object, received undefined; run maxims sync to quarantine it\n",
    );
    expect(await snapshot(scenario.home)).toBe(before);
  });
});

// The persisted-flag preview reads state on a real run too, so the read must stay the locking
// one there: a corrupt file is settled (moved aside) as on any other real run, never refused.
test("update --cap on a real run settles a corrupt state file instead of refusing it", async () => {
  await withScenario({}, async (scenario) => {
    writeState(scenario, { version: 1, writtenBy: "x", hooks: [], sources: { "@a/b": {} } });
    const run = await runCli(scenario, ["update", "--cap", "7"]);
    expect(run.code).toBe(0);
    expect(existsSync(homePaths(scenario.home).state)).toBe(false);
    expect(existsSync(homePaths(scenario.home).config)).toBe(true);
  });
});
