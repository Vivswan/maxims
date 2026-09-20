// Fails if a verb that edits one intent field or reads state stops doing exactly that: `update`
// no longer forcing the refetch, `init` writing a file the contract rejects, `config` writing a
// value the schema refuses, `install` skipping a manifest entry, `lint` missing a problem class,
// `doctor` writing anything, `link` adding a harness without a target, `remove` deleting without
// `-y` non-interactively, or `disable` accepting `-a`.
import { expect, test } from "bun:test";
import {
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

test("update forces a refetch of every fetched source, or of the one named, and reports", async () => {
  await withScenario(
    {
      github: { "a/b": SKILLS, "a/d": DOTFILES },
      syncReport: { fetched: ["@a/b"], changed: ["+@a/b skip-unfit-skills"] },
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
      expect(last).toMatchObject({ force: true, noFetch: false });
      expect(last?.only).toBeUndefined();
      expect(all.stdout).toContain("o  Checking for memory updates...\n");
      expect(all.stdout).toContain(`o  ${scenario.cwd} is live; nothing to fetch\n`);
      expect(all.stdout).toContain("o  Found 1 update(s)\n");
      expect(all.stdout).toContain("o  Updated @a/b (+1 -0 rule)\n");
      expect(all.stdout).toContain(
        "!  @a/b has 3 memories not in your selection: gate-exit-conditions-the-merge, no-sleep-waiting-on-subagents, rubber-duck-before-every-commit\n",
      );
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
      syncReport: { failed: [{ key: "@a/b", message: "connect timed out" }] },
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
      expect(scenario.engine.calls.sync.length).toBe(syncCalls + 1);
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
        "# project\n\n<!-- maxims:@a/b -->\n- gate-exit-conditions-the-merge: ...\n<!-- /maxims -->\n",
      );
      mkdirSync(join(scenario.cwd, ".cursor", "rules"), { recursive: true });
      writeFileSync(
        join(scenario.cwd, ".cursor", "rules", "maxims-a-b.mdc"),
        "<!-- maxims:@a/b -->\n- gate-exit-conditions-the-merge\n<!-- /maxims -->\n",
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
        `${CURSOR_FRONTMATTER}<!-- maxims:@a/b -->\n- gate-exit-conditions-the-merge\n- skip-unfit-skills\n<!-- /maxims -->\n`,
      );
      writeFileSync(
        join(scenario.cwd, "AGENTS.md"),
        "<!-- maxims:@a/b -->\n- skip-unfit-skills\n- gate-exit-conditions-the-merge\n<!-- /maxims -->\n",
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
      noFetch: true,
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
        target: { kind: "source", key: "@a/b", memories: null, agents: ["claude-code"] },
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
    expect(scenario.engine.calls.remove.at(-1)?.target).toEqual({
      kind: "memory",
      source: "@a/b",
      name: mn("skip-unfit-skills"),
      agents: null,
      destination: null,
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
    expect(oneHarness.code).toBe(0);
    expect(scenario.engine.calls.remove.at(-1)?.target).toMatchObject({
      kind: "memory",
      agents: ["codex"],
    });
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
    expect(scenario.engine.calls.remove.at(-1)?.target).toMatchObject({
      kind: "memory",
      source: "@a/d",
    });
    const all = await runCli(scenario, ["remove", "--all", "-a", "codex"]);
    expect(all.code).toBe(0);
    expect(scenario.engine.calls.remove.at(-1)?.target).toEqual({ kind: "all", agents: ["codex"] });
    const scopedAll = await runCli(scenario, ["remove", "--all", "-g"]);
    expect(scopedAll.code).toBe(1);
    expect(scopedAll.stderr).toBe(" ERROR  --all removes every source; drop -g, -p or -o\n");
    const scoped = await runCli(scenario, [
      "remove",
      "@a/b",
      "-y",
      "-m",
      "skip-unfit-skills",
      "-a",
      "codex",
    ]);
    expect(scoped.code).toBe(0);
    expect(scenario.engine.calls.remove.at(-1)?.target).toEqual({
      kind: "source",
      key: "@a/b",
      memories: [mn("skip-unfit-skills")],
      agents: ["codex"],
    });
  });
});

test("disable and enable edit the per-scope list through the engine, then sync", async () => {
  await withScenario({ github: { "a/b": SKILLS } }, async (scenario) => {
    await installSkills(scenario);
    const disabled = await runCli(scenario, ["disable", "skip-unfit-skills"]);
    expect(disabled.code).toBe(0);
    expect(scenario.engine.calls.disabled).toEqual([
      { scope: "global", name: mn("skip-unfit-skills"), disabled: true, dryRun: false },
    ]);
    expect(disabled.stdout).toContain("o  Disabled skip-unfit-skills at global scope\n");
    expect(Object.keys(lastSyncCall(scenario))).not.toContain("agents");
    scenario.options.disabledChanged = false;
    const enabled = await runCli(scenario, ["enable", "@a/b/skip-unfit-skills"]);
    expect(enabled.code).toBe(0);
    expect(enabled.stdout).toContain("o  skip-unfit-skills was not disabled at global\n");
    expect(scenario.engine.calls.sync.length).toBe(3);
    const project = await runCli(scenario, ["disable", "skip-unfit-skills", "-p"]);
    expect(project.code).toBe(1);
    expect(project.stderr).toContain("a project-scoped change needs a project root");
  });
});

test("sync dispatches to the engine, prints the notices under --quiet, and warns about an unreplayed manifest", async () => {
  await withScenario(
    {
      project: true,
      syncReport: { notices: ["maxims: synced 1 sources, 4 rules (no fetch, within cooldown)"] },
    },
    async (scenario) => {
      const quiet = await runCli(scenario, ["sync", "--quiet", "--no-fetch", "-a", "codex"]);
      expect(quiet).toEqual({
        code: 0,
        stdout: "maxims: synced 1 sources, 4 rules (no fetch, within cooldown)\n",
        stderr: "",
      });
      expect(scenario.engine.calls.sync).toEqual([
        { quiet: true, dryRun: false, json: false, noFetch: true, agents: ["codex"], force: false },
      ]);
      mkdirSync(join(scenario.cwd, ".agents"));
      const entry = {
        from: { type: "github", repo: "a/b" },
        select: "*",
        rule: false,
        harnesses: ["codex"],
      };
      writeFileSync(
        join(scenario.cwd, ".agents", "maxims.lock"),
        JSON.stringify({ version: 1, sources: { "@a/b": entry } }),
      );
      const loud = await runCli(scenario, ["sync"]);
      expect(loud.code).toBe(0);
      expect(Object.keys(lastSyncCall(scenario))).not.toContain("agents");
      expect(loud.stdout).toContain(
        "lists sources this machine has not installed (@a/b); run maxims install",
      );
      writeFileSync(
        join(scenario.cwd, ".agents", "maxims.lock"),
        JSON.stringify({ version: 1, sources: {} }),
      );
      expect((await runCli(scenario, ["sync"])).stdout).not.toContain("run maxims install");
      const json = await runCli(scenario, ["sync", "--json"]);
      expect(JSON.parse(json.stdout)).toMatchObject({ ok: true, sources: 1 });
    },
  );
});

test("mcp-serve hands the stub a quiet sync and stays out of --help", async () => {
  await withScenario({}, async (scenario) => {
    const run = await runCli(scenario, ["mcp-serve"]);
    expect(run.code).toBe(0);
    expect(scenario.engine.calls.mcpServe).toBe(1);
    expect(scenario.engine.calls.sync).toEqual([
      { quiet: true, dryRun: false, json: false, noFetch: false, force: false },
    ]);
    const help = await runCli(scenario, ["--help"]);
    expect(help.stdout).not.toContain("mcp-serve");
  });
});

test("list prints the empty result and the --json envelope", async () => {
  await withScenario({}, async (scenario) => {
    const empty = await runCli(scenario, ["ls"]);
    expect(empty.stdout).toContain("o  No sources installed.\n");
    const json = await runCli(scenario, ["list", "--json"]);
    expect(JSON.parse(json.stdout)).toEqual({ ok: true, sources: [] });
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
    expect(scenario.engine.calls.remove.at(-1)?.target).toMatchObject({
      kind: "source",
      key: "@a/b#v1",
    });
  });
});

test("sync --quiet exits 0 even on a usage error, and --json wraps errors before the verb parses", async () => {
  await withScenario({ github: { "a/b": SKILLS } }, async (scenario) => {
    const quiet = await runCli(scenario, ["sync", "--quiet", "--bogus"]);
    expect(quiet).toEqual({ code: 0, stdout: "", stderr: "" });
    expect(readFileSync(homePaths(scenario.home).log, "utf8")).toBe(
      "maxims: sync failed (exit 1): unknown option: --bogus\n",
    );
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
  });
});

test("--dry-run on disable hands dryRun to the engine and on link plans against the would-be state", async () => {
  await withScenario({ github: { "a/b": SKILLS } }, async (scenario) => {
    await installSkills(scenario);
    expect((await runCli(scenario, ["disable", "skip-unfit-skills", "--dry-run"])).code).toBe(0);
    expect(scenario.engine.calls.disabled.at(-1)?.dryRun).toBe(true);
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
      syncReport: { failed: [{ key: "@a/b", message: "connect timed out" }] },
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
    expect(scenario.engine.calls.disabled).toEqual([]);
    expect((await runCli(scenario, ["disable", "@a/d/merge-gate"])).code).toBe(0);
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

test("a stale fetch error is not reported as a failure by a dry-run update", async () => {
  await withScenario({ github: { "a/b": SKILLS } }, async (scenario) => {
    await installSkills(scenario, ["-m", "skip-unfit-skills"]);
    expect((await runCli(scenario, ["update"])).stdout).toContain("not in your selection");
    const state = readState(scenario) as {
      sources: Record<string, { fetched: { lastError: unknown } }>;
    };
    const entry = state.sources["@a/b"];
    if (entry !== undefined) {
      entry.fetched.lastError = { kind: "network", message: "old", at: "2026-09-19T00:00:00.000Z" };
    }
    writeState(scenario, state);
    const run = await runCli(scenario, ["update", "--dry-run"]);
    expect(run.stderr).toBe("");
    expect(run.code).toBe(0);
    expect(run.stdout).not.toContain("not in your selection");
    scenario.options.syncReport = { failed: [{ key: "@a/b", message: "rate limited" }] };
    const failed = await runCli(scenario, ["update", "--dry-run", "--json"]);
    expect(failed.code).toBe(2);
    expect(JSON.parse(failed.stdout)).toMatchObject({ ok: false, code: 2 });
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
    const run = await runCli(scenario, ["install"]);
    expect(run.stderr).toBe("");
    expect(run.code).toBe(0);
    expect(scenario.engine.calls.disabled).toEqual([
      { scope: "project", name: mn("skip-unfit-skills"), disabled: true, dryRun: false },
    ]);
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
    expect(run.stderr).toBe(" ERROR  manifest source ../outside leaves the project root\n");
  });
});

test("a live project source is projected as . and sync does not report it missing", async () => {
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
    const sync = await runCli(scenario, ["sync"]);
    expect(sync.code).toBe(0);
    expect(sync.stderr).toBe("");
    expect(sync.stdout).not.toContain("run maxims install");
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
    const edit = scenario.engine.calls.disabled.at(-1);
    expect(edit?.dryRun).toBe(true);
    expect(Object.keys(edit?.base?.sources ?? {})).toEqual(["@a/b"]);
    expect(Object.keys(scenario.engine.calls.sync.at(-1)?.preview?.state.sources ?? {})).toEqual([
      "@a/b",
    ]);
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
    expect(run.stderr).toBe(" ERROR  manifest source rules leaves the project root\n");
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
    expect(Object.keys(lock.sources)).toEqual(["constructor"]);
  });
});

test("a project directory the manifest grammar cannot name is refused before anything is written", async () => {
  await withScenario({ project: true }, async (scenario) => {
    for (const name of ["a:rules", "__proto__"]) {
      mkdirSync(join(scenario.cwd, name, "memories"), { recursive: true });
      writeFileSync(
        join(scenario.cwd, name, "memories", "own-rule.md"),
        "---\nname: own-rule\ndescription: Ours\n---\n",
      );
      const before = await snapshot(scenario.root);
      const run = await runCli(scenario, ["add", `./${name}`, "-p", "-a", "codex"]);
      expect(run.code).toBe(1);
      expect(run.stderr).toContain("cannot be written into");
      expect(await snapshot(scenario.root)).toBe(before);
    }
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
    expect(Object.keys(lock.sources)).toEqual(["rules"]);
    expect(Object.keys((readState(scenario) as { sources: object }).sources)).toEqual([
      realpathSync(join(scenario.cwd, "rules")),
    ]);
    const sync = await runCli(scenario, ["sync"]);
    expect(sync.code).toBe(0);
    expect(sync.stdout).not.toContain("run maxims install");
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

test("sync names each source whose refresh failed and exits 2, except under --quiet", async () => {
  await withScenario(
    {
      github: { "a/b": SKILLS },
      syncReport: { failed: [{ key: "@a/b", message: "connect timed out" }] },
    },
    async (scenario) => {
      await installSkills(scenario);
      const run = await runCli(scenario, ["sync"]);
      expect(run.code).toBe(2);
      expect(run.stdout).toContain("x  @a/b: connect timed out\n");
      expect(run.stdout).toContain("o  Synced 1 sources, 0 rule lines\n");
      const json = await runCli(scenario, ["sync", "--json"]);
      expect(json.code).toBe(2);
      expect(JSON.parse(json.stdout)).toMatchObject({
        ok: false,
        failed: [{ key: "@a/b", message: "connect timed out" }],
      });
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
      const block = "<!-- maxims:@a/b -->\n- skip-unfit-skills\n<!-- /maxims -->\n";
      const target = cursor.targets.project;
      if (target === null || target.kind !== "rules-dir" || target.frontmatter === undefined) {
        throw new Error("the cursor definition no longer declares a rules-dir frontmatter");
      }
      mkdirSync(join(scenario.cwd, ".cursor", "rules"), { recursive: true });
      const mdc = join(scenario.cwd, ".cursor", "rules", "maxims-a-b.mdc");
      writeFileSync(mdc, `${target.frontmatter({})}${block}`);
      const rules = join(scenario.cwd, ".rules");
      writeFileSync(rules, `# zed\n\n${block}`);
      const healthy = await runCli(scenario, ["doctor", "--expect", "skip-unfit-skills"]);
      expect(healthy.code).toBe(0);
      expect(healthy.stdout).toContain(`ok  cursor: ${mdc}\n`);
      expect(healthy.stdout).toContain(`ok  zed: ${rules}\n`);
      expect(healthy.stdout).toContain("ok  expect skip-unfit-skills: rule line in place\n");
      writeFileSync(mdc, block);
      const bare = await runCli(scenario, ["doctor"]);
      expect(bare.code).toBe(1);
      expect(bare.stdout).toContain(
        `x   cursor: ${mdc} lacks the frontmatter Cursor needs to load it every session\n`,
      );
    },
  );
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
