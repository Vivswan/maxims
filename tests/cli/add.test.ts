// Fails if `add` stops honoring its one-commit-point contract: a validation failure (exit 3, 6,
// 7, 8) that writes anything, a `--list` that fetches under `--no-fetch` or touches state, a
// re-add that unions instead of replacing the selection, a `.` source that registers a hook, or
// a sync that stops receiving `noFetch: true` and the chosen harnesses.
import { expect, test } from "bun:test";
import { existsSync, lstatSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { STRINGS } from "../../src/console/strings.ts";
import { homePaths } from "../../src/util/home.ts";
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

type SourceRecord = {
  intent: {
    select: string | string[];
    rename: Record<string, string>;
    harnesses: string[];
    destination: { scope: string; path?: string };
    from: { type: string; live?: boolean; ref?: string; path?: string };
    rule: boolean;
    auth: boolean;
    paths?: string[];
  };
  fetched?: { sha: string; memories: Record<string, unknown> };
  addedAt: string;
};

function source(scenario: Scenario, key: string): SourceRecord {
  const state = readState(scenario) as { sources: Record<string, SourceRecord> };
  const entry = state.sources[key];
  if (entry === undefined) throw new Error(`${key} not in state`);
  return entry;
}

test("add records intent and the fetch, lays the store entry, then syncs once with noFetch", async () => {
  await withScenario(
    { github: { "vivswan/skills": SKILLS }, syncReport: { rules: 4, tokens: 103 } },
    async (scenario) => {
      const run = await runCli(scenario, [
        "add",
        "@Vivswan/skills",
        "-g",
        "--rule",
        "--add-hook",
        "-a",
        "claude-code,codex",
      ]);
      expect(run.stderr).toBe("");
      expect(run.code).toBe(0);
      expect(run.stdout).toContain("o  Found 4 memories\n");
      expect(run.stdout).toContain("o  Installed 4 memories, 4 rule lines (~103 tokens)\n");
      expect(run.stdout.match(/Hook registered/g)?.length).toBe(2);
      const entry = source(scenario, "@Vivswan/skills");
      expect(entry.intent).toMatchObject({
        select: "*",
        rule: true,
        harnesses: ["claude-code", "codex"],
        destination: { scope: "global" },
        from: { type: "github", ref: "HEAD" },
        auth: false,
      });
      expect(Object.keys(entry.fetched?.memories ?? {}).sort()).toEqual([
        "gate-exit-conditions-the-merge",
        "no-sleep-waiting-on-subagents",
        "rubber-duck-before-every-commit",
        "skip-unfit-skills",
      ]);
      expect((readState(scenario) as { hooks: string[] }).hooks).toEqual(["claude-code", "codex"]);
      const store = join(scenario.home, "store", "vivswan", "skills", "memories");
      expect(existsSync(join(store, "skip-unfit-skills.md"))).toBe(true);
      expect(scenario.engine.calls.sync).toEqual([
        {
          quiet: false,
          dryRun: false,
          json: false,
          noFetch: true,
          agents: ["claude-code", "codex"],
          force: false,
        },
      ]);
    },
  );
});

test("a file that fails the contract is skipped with one warning naming the reason", async () => {
  await withScenario({ github: { "a/d": DOTFILES } }, async (scenario) => {
    const run = await runCli(scenario, ["add", "@a/d", "-g", "-a", "codex"]);
    expect(run.code).toBe(0);
    expect(run.stdout).toContain(
      '!  README.md is not a memory: filename stem "README" is not kebab-case\n',
    );
    expect(run.stdout).toContain("o  Found 1 memory (1 internal, hidden)\n");
  });
});

test("re-adding with a different -m replaces the selection and says so first", async () => {
  await withScenario({ github: { "a/b": SKILLS } }, async (scenario) => {
    await runCli(scenario, ["add", "@a/b", "-g", "-a", "codex", "-m", "skip-unfit-skills"]);
    const first = source(scenario, "@a/b");
    const run = await runCli(scenario, [
      "add",
      "@a/b",
      "-g",
      "-a",
      "codex",
      "-m",
      "gate-exit-conditions-the-merge",
    ]);
    expect(run.code).toBe(0);
    const lines = run.stdout.split("\n");
    const replaced = lines.indexOf(
      "o  Selection replaced: skip-unfit-skills -> gate-exit-conditions-the-merge",
    );
    const plan = lines.indexOf("o  Memories to install");
    expect(replaced).toBeGreaterThan(0);
    expect(replaced).toBeLessThan(plan);
    const second = source(scenario, "@a/b");
    expect(second.intent.select).toEqual(["gate-exit-conditions-the-merge"]);
    expect(second.addedAt).toBe(first.addedAt);
  });
});

const nothingWritten: [string, string[], number, string, Record<string, string>][] = [
  [
    "a -m name the source lacks",
    ["add", "@a/b", "-g", "-a", "codex", "-m", "not-there"],
    3,
    "No matching memories found for: not-there",
    {},
  ],
  [
    "a hidden character without --allow-hidden",
    ["add", "@a/c", "-g", "-a", "codex"],
    3,
    "sneaky: U+200B zero-width space at column 8",
    {},
  ],
  [
    "an unmet wikilink",
    ["add", "@a/b", "-g", "-a", "codex", "-m", "no-sleep-waiting-on-subagents"],
    7,
    "no-sleep-waiting-on-subagents links to [[rubber-duck-before-every-commit]], which is not installed",
    {},
  ],
  [
    "a collision without --rename",
    ["add", "@a/d", "-g", "-a", "codex"],
    6,
    "gate-exit-conditions-the-merge is owned by @a/b",
    {},
  ],
  [
    "a source over the cap",
    ["add", "@a/b", "-g", "-a", "codex", "--cap", "3"],
    8,
    "@a/b would publish 4 rule lines, over the cap of 3",
    {},
  ],
  [
    "a --rename for a memory the source lacks",
    ["add", "@a/b", "-g", "-a", "codex", "--rename", "ghost=phantom"],
    3,
    "--rename names memories the source lacks: ghost",
    {},
  ],
];

test.each(nothingWritten)(
  "%s exits with its code and leaves home and project untouched",
  async (_name, argv, code, message) => {
    await withScenario(
      { github: { "a/b": SKILLS, "a/c": "", "a/d": DOTFILES }, project: true },
      async (scenario) => {
        const hidden = join(scenario.root, "hidden", "memories");
        mkdirSync(hidden, { recursive: true });
        writeFileSync(
          join(hidden, "sneaky.md"),
          "---\nname: sneaky\ndescription: A quiet\u200b instruction that renders as nothing\n---\n",
        );
        scenario.options.github = {
          ...scenario.options.github,
          "a/c": join(scenario.root, "hidden"),
        };
        if (argv.includes("@a/d")) {
          const first = await runCli(scenario, [
            "add",
            "@a/b",
            "-g",
            "-a",
            "codex",
            "-m",
            "gate-exit-conditions-the-merge",
          ]);
          expect(first.code).toBe(0);
        }
        const before = await snapshot(scenario.root);
        const syncCalls = scenario.engine.calls.sync.length;
        const run = await runCli(scenario, argv);
        expect(run.code).toBe(code);
        expect(run.stderr).toContain(` ERROR  ${message}`);
        expect(await snapshot(scenario.root)).toBe(before);
        expect(scenario.engine.calls.sync.length).toBe(syncCalls);
      },
    );
  },
);

test("--allow-hidden lets the hidden character through and --rename resolves a known collision", async () => {
  await withScenario({ github: { "a/b": SKILLS, "a/d": DOTFILES } }, async (scenario) => {
    const hidden = join(scenario.root, "hidden", "memories");
    mkdirSync(hidden, { recursive: true });
    writeFileSync(
      join(hidden, "sneaky.md"),
      "---\nname: sneaky\ndescription: A quiet\u200b instruction\n---\n",
    );
    scenario.options.github = { ...scenario.options.github, "a/c": join(scenario.root, "hidden") };
    expect(
      (await runCli(scenario, ["add", "@a/c", "-g", "-a", "codex", "--allow-hidden"])).code,
    ).toBe(0);
    expect((await runCli(scenario, ["add", "@a/b", "-g", "-a", "codex"])).code).toBe(0);
    const run = await runCli(scenario, [
      "add",
      "@a/d",
      "-g",
      "-a",
      "codex",
      "--rename",
      "gate-exit-conditions-the-merge=gate-exit-conditions-the-merge-dotfiles",
    ]);
    expect(run.stderr).toBe("");
    expect(run.code).toBe(0);
    expect(source(scenario, "@a/d").intent.rename).toEqual({
      "gate-exit-conditions-the-merge": "gate-exit-conditions-the-merge-dotfiles",
    });
    expect(run.stdout).toContain("|    gate-exit-conditions-the-merge-dotfiles\n");
    expect(run.stdout).toContain("o  Found 1 memory (1 internal, hidden)\n");
  });
});

test("--list prints every item, warns on ignored flags, and never writes or syncs", async () => {
  await withScenario({ github: { "a/b": SKILLS } }, async (scenario) => {
    const before = await snapshot(scenario.root);
    const run = await runCli(scenario, ["add", "@a/b", "--list", "--rule", "-y"]);
    expect(run.code).toBe(0);
    expect(run.stdout).toContain("!  --rule is ignored with --list\n");
    expect(run.stdout).toContain("!  --yes is ignored with --list\n");
    expect(run.stdout.match(/^\| {4}[a-z-]+$/gm)).toEqual([
      "|    gate-exit-conditions-the-merge",
      "|    no-sleep-waiting-on-subagents",
      "|    rubber-duck-before-every-commit",
      "|    skip-unfit-skills",
    ]);
    expect(run.stdout.endsWith("|\no  Run without --list to install\n\n")).toBe(true);
    expect(await snapshot(scenario.root)).toBe(before);
    expect(scenario.engine.calls.sync).toEqual([]);
  });
});

test("--list shows a source whose install would collide", async () => {
  await withScenario({ github: { "a/b": SKILLS, "a/d": DOTFILES } }, async (scenario) => {
    expect((await runCli(scenario, ["add", "@a/b", "-g", "-a", "codex"])).code).toBe(0);
    const listed = await runCli(scenario, ["add", "@a/d", "--list"]);
    expect(listed.code).toBe(0);
    expect(listed.stdout).toContain("|    gate-exit-conditions-the-merge\n");
    const installed = await runCli(scenario, ["add", "@a/d", "-g", "-a", "codex"]);
    expect(installed.code).toBe(6);
  });
});

test("--list --no-fetch stays offline: the store copy when present, the empty line otherwise", async () => {
  await withScenario({ github: { "example/repo": SKILLS } }, async (scenario) => {
    const empty = await runCli(scenario, ["add", "@example/repo", "--list", "--no-fetch"]);
    expect(empty.code).toBe(0);
    expect(empty.stdout).toContain("o  Found 0 memories (store empty; run without --no-fetch)\n");
    expect(scenario.fetches).toEqual([]);
    expect(existsSync(homePaths(scenario.home).state)).toBe(false);
    expect((await runCli(scenario, ["add", "@example/repo", "-g", "-a", "codex"])).code).toBe(0);
    const fetches = scenario.fetches.length;
    const listed = await runCli(scenario, ["add", "@example/repo", "--list", "--no-fetch"]);
    expect(listed.code).toBe(0);
    expect(listed.stdout).toContain("o  Found 4 memories\n");
    expect(scenario.fetches.length).toBe(fetches);
  });
});

test("a . source is live, links the store entry, and ignores --add-hook", async () => {
  await withScenario({}, async (scenario) => {
    mkdirSync(join(scenario.cwd, "memories"));
    writeFileSync(
      join(scenario.cwd, "memories", "local-rule.md"),
      "---\nname: local-rule\ndescription: A rule edited in place\n---\n",
    );
    const run = await runCli(scenario, ["add", ".", "-g", "-a", "codex", "--add-hook"]);
    expect(run.stderr).toBe("");
    expect(run.code).toBe(0);
    const entry = source(scenario, scenario.cwd);
    expect(entry.intent.from).toEqual({ type: "local", path: scenario.cwd, live: true });
    expect(entry.fetched).toBeUndefined();
    expect((readState(scenario) as { hooks: string[] }).hooks).toEqual([]);
    expect(run.stdout).not.toContain("Hook registered");
    const store = join(scenario.home, "store", "_local");
    const [entryName] = require("node:fs").readdirSync(store) as string[];
    expect(lstatSync(join(store, entryName ?? "")).isSymbolicLink()).toBe(true);
  });
});

test("a local source into the project scope warns with the repository path", async () => {
  await withScenario({ project: true }, async (scenario) => {
    const run = await runCli(scenario, ["add", DOTFILES, "-p", "-a", "codex"]);
    expect(run.code).toBe(0);
    expect(run.stdout).toContain(
      `!  installing a local source into the project at ${scenario.cwd}: its text lands in files that repository may commit\n`,
    );
    expect(existsSync(join(scenario.cwd, ".agents", "maxims.lock"))).toBe(false);
    const github = await runCli(scenario, ["add", "@a/b", "-p", "-a", "codex"]);
    expect(github.code).toBe(2);
  });
});

test("a project-scope github add writes the manifest as a sorted projection of intent", async () => {
  await withScenario(
    { project: true, github: { "a/b": SKILLS, "a/d": DOTFILES } },
    async (scenario) => {
      expect(
        (await runCli(scenario, ["add", "@a/d", "-a", "codex", "--paths", "src/**"])).code,
      ).toBe(0);
      expect(
        (
          await runCli(scenario, [
            "add",
            "@a/b",
            "-a",
            "cursor",
            "--rule",
            "-m",
            "skip-unfit-skills",
          ])
        ).code,
      ).toBe(0);
      const lock = JSON.parse(
        readFileSync(join(scenario.cwd, ".agents", "maxims.lock"), "utf8"),
      ) as { sources: Record<string, unknown> };
      expect(Object.keys(lock.sources)).toEqual(["@a/b", "@a/d"]);
      expect(lock.sources["@a/b"]).toEqual({
        from: { type: "github", repo: "a/b" },
        select: ["skip-unfit-skills"],
        rule: true,
        harnesses: ["cursor"],
      });
      expect(lock.sources["@a/d"]).toMatchObject({ paths: ["src/**"] });
      expect(source(scenario, "@a/b").intent.destination).toEqual({ scope: "project" });
    },
  );
});

test("harness selection: detected first, then config.agents, then a global-less harness is skipped", async () => {
  await withScenario(
    { github: { "a/b": SKILLS }, env: { FIXTURE_DETECT: "codex" } },
    async (scenario) => {
      const detected = await runCli(scenario, ["add", "@a/b", "-g"]);
      expect(detected.code).toBe(0);
      expect(source(scenario, "@a/b").intent.harnesses).toEqual(["codex"]);
      scenario.options.env = { FIXTURE_DETECT: "" };
      writeConfig(scenario, { agents: ["claude-code"] });
      expect((await runCli(scenario, ["add", "@a/b", "-g"])).code).toBe(0);
      expect(source(scenario, "@a/b").intent.harnesses).toEqual(["claude-code"]);
      const skipped = await runCli(scenario, ["add", "@a/b", "-g", "-a", "cursor,codex"]);
      expect(skipped.code).toBe(0);
      expect(skipped.stdout).toContain("!  cursor has no global target; skipped\n");
      expect(source(scenario, "@a/b").intent.harnesses).toEqual(["codex"]);
      const none = await runCli(scenario, ["add", "@a/b", "-g", "-a", "cursor"]);
      expect(none.code).toBe(0);
      expect(source(scenario, "@a/b").intent.harnesses).toEqual([]);
      expect(Object.keys(lastSyncCall(scenario))).not.toContain("agents");
      writeConfig(scenario, {});
      const star = await runCli(scenario, ["add", "@a/b", "-g", "-a", "*"]);
      expect(star.code).toBe(0);
      expect(source(scenario, "@a/b").intent.harnesses).toEqual(["claude-code", "codex"]);
      const nothing = await runCli(scenario, ["add", "@a/b", "-g"]);
      expect(nothing.code).toBe(1);
      expect(nothing.stderr).toContain("no harness detected on this machine");
    },
  );
});

test("--cooldown and --cap land in config.json and an explicit flag wins over the file", async () => {
  await withScenario({ github: { "a/b": SKILLS } }, async (scenario) => {
    writeConfig(scenario, { ruleCap: 2 });
    const capped = await runCli(scenario, ["add", "@a/b", "-g", "-a", "codex"]);
    expect(capped.code).toBe(8);
    const raised = await runCli(scenario, [
      "add",
      "@a/b",
      "-g",
      "-a",
      "codex",
      "--cap",
      "10",
      "--cooldown",
      "3",
    ]);
    expect(raised.code).toBe(0);
    const config = await runCli(scenario, ["config", "get"]);
    expect(JSON.parse(config.stdout)).toEqual({ ruleCap: 10, cooldownDays: 3 });
  });
});

test("--json emits exactly one document on success and on every failure", async () => {
  await withScenario({ github: { "a/b": SKILLS } }, async (scenario) => {
    const ok = await runCli(scenario, ["add", "@a/b", "-g", "-a", "codex", "-y", "--json"]);
    expect(ok.code).toBe(0);
    const body = JSON.parse(ok.stdout) as {
      ok: boolean;
      source: string;
      memories: string[];
      plan: { changes: unknown[] };
    };
    expect(body.ok).toBe(true);
    expect(body.source).toBe("@a/b");
    expect(body.memories.length).toBe(4);
    expect(body.plan.changes.length).toBeGreaterThan(0);
    const failed = await runCli(scenario, [
      "add",
      "@a/b",
      "-g",
      "-a",
      "codex",
      "-y",
      "--json",
      "-m",
      "ghost",
    ]);
    expect(failed.code).toBe(3);
    expect(failed.stderr).toBe("");
    expect(JSON.parse(failed.stdout)).toMatchObject({ ok: false, code: 3 });
  });
});

test("--quiet turns every failure into exit 0 with one log line", async () => {
  await withScenario({ github: { "a/b": SKILLS } }, async (scenario) => {
    const run = await runCli(scenario, [
      "add",
      "@a/b",
      "-g",
      "-a",
      "codex",
      "-m",
      "ghost",
      "--quiet",
    ]);
    expect(run).toEqual({ code: 0, stdout: "", stderr: "" });
    const log = readFileSync(homePaths(scenario.home).log, "utf8");
    expect(log).toBe(
      "maxims: add failed (exit 3): No matching memories found for: ghost\nAvailable memories:\n  - gate-exit-conditions-the-merge\n  - no-sleep-waiting-on-subagents\n  - rubber-duck-before-every-commit\n  - skip-unfit-skills\n",
    );
  });
});

test("--dry-run shows the plan, writes no state, and hands dryRun to the engine", async () => {
  await withScenario({ github: { "a/b": SKILLS } }, async (scenario) => {
    const before = await snapshot(scenario.root);
    const run = await runCli(scenario, ["add", "@a/b", "-g", "-a", "codex", "--dry-run"]);
    expect(run.code).toBe(0);
    expect(run.stdout).toContain("write   ");
    expect(run.stdout).toContain("skip-unfit-skills.md");
    expect(await snapshot(scenario.root)).toBe(before);
    expect(scenario.engine.calls.sync[0]?.dryRun).toBe(true);
  });
});

test("a corrupt state file is quarantined with a warning and the add proceeds on an empty intent", async () => {
  await withScenario({ github: { "a/b": SKILLS } }, async (scenario) => {
    writeState(scenario, {
      version: 1,
      writtenBy: "x",
      hooks: [],
      sources: { "@a/b": { bogus: true } },
    });
    const run = await runCli(scenario, ["add", "@a/b", "-g", "-a", "codex"]);
    expect(run.code).toBe(0);
    expect(run.stdout).toContain("was moved aside to");
    expect(source(scenario, "@a/b").intent.select).toBe("*");
  });
});

test("re-adding a GitHub source in another case continues the recorded entry", async () => {
  await withScenario({ github: { "a/b": SKILLS } }, async (scenario) => {
    expect((await runCli(scenario, ["add", "@a/b", "-g", "-a", "codex"])).code).toBe(0);
    const run = await runCli(scenario, [
      "add",
      "@A/B",
      "-g",
      "-a",
      "codex",
      "-m",
      "skip-unfit-skills",
    ]);
    expect(run.code).toBe(0);
    const state = readState(scenario) as { sources: Record<string, SourceRecord> };
    expect(Object.keys(state.sources)).toEqual(["@a/b"]);
    expect(state.sources["@a/b"]?.intent.select).toEqual(["skip-unfit-skills"]);
    const listed = await runCli(scenario, ["add", "@a/b", "--list", "--no-fetch"]);
    expect(listed.stdout).toContain("Found 4 memories");
  });
});

test("moving a source from the project to the user scope retires it from the manifest", async () => {
  await withScenario({ project: true, github: { "a/b": SKILLS } }, async (scenario) => {
    expect((await runCli(scenario, ["add", "@a/b", "-p", "-a", "codex"])).code).toBe(0);
    const lock = join(scenario.cwd, ".agents", "maxims.lock");
    expect(existsSync(lock)).toBe(true);
    expect((await runCli(scenario, ["add", "@a/b", "-g", "-a", "codex"])).code).toBe(0);
    expect(existsSync(lock)).toBe(false);
  });
});

test("an -o folder outside any git checkout is planned without a project root", async () => {
  await withScenario({ github: { "a/b": SKILLS } }, async (scenario) => {
    const run = await runCli(scenario, ["add", "@a/b", "-o", "./team-rules", "-a", "codex"]);
    expect(run.stderr).toBe("");
    expect(run.code).toBe(0);
    expect(run.stdout).toContain(`   A B -> ${join(scenario.cwd, "team-rules")}\n`);
    expect(source(scenario, "@a/b").intent.destination).toEqual({
      scope: "out",
      path: join(scenario.cwd, "team-rules"),
    });
  });
});

test("--dry-run hands the engine the state the add would have written", async () => {
  await withScenario({ github: { "a/b": SKILLS } }, async (scenario) => {
    const run = await runCli(scenario, ["add", "@a/b", "-g", "-a", "codex", "--rule", "--dry-run"]);
    expect(run.code).toBe(0);
    const planned = scenario.engine.calls.sync[0]?.preview;
    expect(planned?.state.sources["@a/b"]?.intent.rule).toBe(true);
    expect(
      planned?.changes.some(
        (change) => change.kind === "write" && change.path.endsWith("skip-unfit-skills.md"),
      ),
    ).toBe(true);
    expect(existsSync(homePaths(scenario.home).state)).toBe(false);
  });
});

test("a failed fetch closes the spinner with the failure line", async () => {
  await withScenario({}, async (scenario) => {
    const run = await runCli(scenario, ["add", "@nobody/nothing", "-g", "-a", "codex"]);
    expect(run.code).toBe(2);
    expect(run.stdout).toContain("x  Failed to clone repository\n");
  });
});

test("pinned sources get their own rules-file stem on the plan screen", async () => {
  await withScenario({ github: { "a/b": SKILLS } }, async (scenario) => {
    const argv = ["add", "@a/b", "-g", "--rule", "-a", "claude-code", "--pin", "v2"];
    const run = await runCli(scenario, argv);
    expect(run.code).toBe(0);
    const pinnedPath = /A B -> (~\/\.claude\/rules\/maxims-a-b-v2-[0-9a-f]{8}\.md)\n/.exec(
      run.stdout,
    );
    expect(pinnedPath).not.toBeNull();
    scenario.options.github = { ...scenario.options.github, "a/b-v2": SKILLS };
    const hyphen = await runCli(scenario, [
      "add",
      "@a/b-v2",
      "-g",
      "--rule",
      "-a",
      "claude-code",
      "-m",
      "skip-unfit-skills",
      "--rename",
      "skip-unfit-skills=skip-unfit-v2",
    ]);
    expect(hyphen.code).toBe(0);
    const hyphenPath = /A B V2 -> (~\/\.claude\/rules\/maxims-a-b-v2-[0-9a-f]{8}\.md)\n/.exec(
      hyphen.stdout,
    );
    expect(hyphenPath).not.toBeNull();
    expect(hyphenPath?.[1]).not.toBe(pinnedPath?.[1]);
  });
});

test("a repeated -m name is one selection and a hookless harness registers no hook", async () => {
  await withScenario({ project: true, github: { "a/b": SKILLS } }, async (scenario) => {
    const argv = [
      "add",
      "@a/b",
      "-p",
      "-a",
      "cursor",
      "--add-hook",
      "-m",
      "skip-unfit-skills",
      "-m",
      "skip-unfit-skills",
    ];
    const run = await runCli(scenario, argv);
    expect(run.code).toBe(0);
    expect(run.stdout).not.toContain("Hook registered");
    expect(run.stdout).toContain("o  Selected 1 memory: skip-unfit-skills\n");
    expect((readState(scenario) as { hooks: string[] }).hooks).toEqual([]);
    expect(source(scenario, "@a/b").intent.select).toEqual(["skip-unfit-skills"]);
  });
});

test("a long pinned ref still yields a rules-file stem a filesystem accepts", async () => {
  await withScenario({ github: { "a/b": SKILLS } }, async (scenario) => {
    const ref = "r".repeat(240);
    const run = await runCli(scenario, [
      "add",
      "@a/b",
      "-g",
      "--rule",
      "-a",
      "claude-code",
      "--pin",
      ref,
    ]);
    expect(run.code).toBe(0);
    const path = /A B -> ~\/\.claude\/rules\/(maxims-[^\n]+\.md)\n/.exec(run.stdout)?.[1] ?? "";
    expect(path.length).toBeGreaterThan(0);
    expect(path.length).toBeLessThan(100);
  });
});

test("a --pin the state schema refuses is a usage error naming the flag, and nothing is written", async () => {
  await withScenario({ github: { "a/b": SKILLS } }, async (scenario) => {
    const before = await snapshot(scenario.root);
    const run = await runCli(scenario, [
      "add",
      "@a/b",
      "-g",
      "-a",
      "codex",
      "--pin",
      "release-->v1",
      "-y",
    ]);
    expect(run.code).toBe(1);
    expect(run.stderr).toBe(' ERROR  --pin "release-->v1": a ref cannot contain -->\n');
    expect(scenario.fetches).toEqual([]);
    expect(await snapshot(scenario.root)).toBe(before);
  });
});

// The harness prompt is the one place `lastAgents` is written. The next prompt offers it as the
// pre-selected answer (Enter alone keeps it, where an empty selection would be refused), and a
// silent run takes it without asking, instead of failing with "no harness detected".
test("the harnesses chosen at the prompt are remembered, pre-selected, and reused silently", async () => {
  await withScenario(
    {
      github: { "a/b": SKILLS },
      tty: true,
      answers: { [STRINGS.whichAgents]: " \r", [STRINGS.proceed]: "\r" },
    },
    async (scenario) => {
      const chosen = await runCli(scenario, ["add", "@a/b", "-g"]);
      expect(chosen.code).toBe(0);
      expect(source(scenario, "@a/b").intent.harnesses).toEqual(["claude-code"]);
      const config = homePaths(scenario.home).config;
      expect(JSON.parse(readFileSync(config, "utf8"))).toEqual({ lastAgents: ["claude-code"] });
      const before = readFileSync(config, "utf8");
      scenario.options.answers = { [STRINGS.whichAgents]: "\r", [STRINGS.proceed]: "\r" };
      const kept = await runCli(scenario, ["add", "@a/b", "-g", "-m", "skip-unfit-skills"]);
      expect(kept.code).toBe(0);
      expect(source(scenario, "@a/b").intent.harnesses).toEqual(["claude-code"]);
      const silent = await runCli(scenario, ["add", "@a/b", "-g", "-y"]);
      expect(silent.code).toBe(0);
      expect(source(scenario, "@a/b").intent.harnesses).toEqual(["claude-code"]);
      expect(readFileSync(config, "utf8")).toBe(before);
    },
  );
});

// The manifest carries the memory folder, depth and copy flags only when `add` was told them,
// and `install` on a fresh machine records the same intent `add` did, so a replay reads the
// folder the author named instead of the default one.
test("--from, --full-depth and --copy round-trip through the manifest into a fresh install", async () => {
  await withScenario({ project: true, github: { "a/b": SKILLS } }, async (scenario) => {
    mkdirSync(join(scenario.cwd, "src", "rules"), { recursive: true });
    writeFileSync(
      join(scenario.cwd, "src", "rules", "own-rule.md"),
      "---\nname: own-rule\ndescription: Ours\n---\n",
    );
    const flagged = await runCli(scenario, [
      "add",
      "./src",
      "-p",
      "-a",
      "codex",
      "--from",
      "rules",
      "--full-depth",
      "--copy",
    ]);
    expect(flagged.code).toBe(0);
    expect((await runCli(scenario, ["add", "@a/b", "-p", "-a", "codex"])).code).toBe(0);
    const lockPath = join(scenario.cwd, ".agents", "maxims.lock");
    const written = readFileSync(lockPath, "utf8");
    const lock = JSON.parse(written) as { sources: Record<string, unknown> };
    expect(Object.keys(lock.sources)).toEqual(["@a/b", "src"]);
    expect(lock.sources.src).toEqual({
      from: { type: "local", path: "src" },
      select: "*",
      rule: false,
      harnesses: ["codex"],
      memoryPath: "rules",
      fullDepth: true,
      copy: true,
    });
    expect(lock.sources["@a/b"]).toEqual({
      from: { type: "github", repo: "a/b" },
      select: "*",
      rule: false,
      harnesses: ["codex"],
    });
    rmSync(homePaths(scenario.home).state);
    const replayed = await runCli(scenario, ["install"]);
    expect(replayed.code).toBe(0);
    const state = readState(scenario) as {
      sources: Record<
        string,
        {
          intent: {
            memoryPath: string;
            fullDepth: boolean;
            copy: boolean;
            from: { path?: string };
          };
        }
      >;
    };
    const own = Object.values(state.sources).find((entry) => entry.intent.from.path !== undefined);
    expect(own?.intent).toMatchObject({ memoryPath: "rules", fullDepth: true, copy: true });
    expect(state.sources["@a/b"]?.intent).toMatchObject({
      memoryPath: "memories",
      fullDepth: false,
      copy: false,
    });
    expect(readFileSync(lockPath, "utf8")).toBe(written);
  });
});

const CORRUPT_STATE = {
  version: 1,
  writtenBy: "x",
  hooks: [],
  sources: { "@a/b": { bogus: true } },
};

// A read that must not write keeps its hands off a corrupt file: the locking read would move it
// aside (a write) and, before that, create the home to take the lock. The notice names the verb
// that settles it.
test("add --dry-run refuses a corrupt state file and add --list warns, both leaving it in place", async () => {
  await withScenario({ github: { "a/b": SKILLS } }, async (scenario) => {
    writeState(scenario, CORRUPT_STATE);
    const before = await snapshot(scenario.home);
    const dry = await runCli(scenario, ["add", "@a/b", "-g", "-a", "codex", "--dry-run"]);
    expect(dry.code).toBe(1);
    expect(dry.stderr).toBe(
      " ERROR  state.json is corrupt: sources.@a/b.intent: Invalid input: expected object, received undefined; run maxims sync to quarantine it\n",
    );
    expect(await snapshot(scenario.home)).toBe(before);
    const listed = await runCli(scenario, ["add", "@a/b", "--list"]);
    expect(listed.code).toBe(0);
    expect(listed.stdout).toContain(
      "!  state.json is corrupt: sources.@a/b.intent: Invalid input: expected object, received undefined; run maxims sync to quarantine it\n",
    );
    expect(listed.stdout).toContain("|    skip-unfit-skills\n");
    expect(await snapshot(scenario.home)).toBe(before);
    expect((await runCli(scenario, ["link", "@a/b", "-a", "claude-code", "--dry-run"])).code).toBe(
      1,
    );
    expect(await snapshot(scenario.home)).toBe(before);
  });
});
