// Fails if the flag grammar drifts from the table `docs/cli.md` renders: a refusal that stops
// firing (two destinations, --json without -y, --all with names), an alias that stops resolving,
// `--flag=value` or comma lists that stop composing, or `--help` that starts touching the disk.
import { expect, test } from "bun:test";
import { mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { VERSION } from "../../../src/version.ts";
import { FIXTURES, runCli, snapshot, withScenario } from "../fake-engine.ts";

const SKILLS = join(FIXTURES, "skills");

// A refusal at the door reaches no engine runner.
const NO_ENGINE_CALLS = { sync: [], remove: [], list: [], mcpServe: 0 };

const refusals: [string, string[], string][] = [
  ["two scopes", ["add", "@a/b", "-g", "-p"], "two destinations given"],
  ["scope with out", ["add", "@a/b", "-g", "-o", "x"], "two destinations given"],
  [
    "all with a @name suffix",
    ["add", "@a/b@skip-unfit-skills", "--all"],
    "Cannot combine --all with specific memory names.",
  ],
  ["link on github", ["add", "@a/b", "--link"], "--link applies to a local directory"],
  [
    "pin on local",
    ["add", "./dir", "--pin", "abc"],
    "--pin applies to a GitHub or git source, not a directory",
  ],
  [
    "bad cooldown",
    ["add", "@a/b", "--cooldown", "x"],
    '--cooldown expects a non-negative integer, got "x"',
  ],
  ["bad cap", ["sync", "--cap", "x"], '--cap expects a positive integer, got "x"'],
  [
    "bad rename pair",
    ["add", "@a/b", "--rename", "nope"],
    '--rename expects <upstream>=<local>, got "nope"',
  ],
  [
    "unknown agent",
    ["add", "@a/b", "-a", "codx"],
    "Invalid agents: codx\nValid agents: claude-code, codex, cursor\ndid you mean codex?",
  ],
  ["link without agent", ["link", "@a/b"], "link needs -a <harness>"],
  [
    "disable with agent",
    ["disable", "foo", "-a", "codex"],
    "disable applies per scope, not per harness; drop -a\nTip: maxims unlink <source> -a <harness> removes one harness's copy",
  ],
  [
    "remove all with name",
    ["remove", "foo", "--all"],
    "Cannot combine --all with specific memory names.",
  ],
  [
    "config unknown key",
    ["config", "set", "colour", "true"],
    "unknown config key: colour (valid: agents, yes, addHook, rule, cooldownDays, ruleCap, lastAgents)",
  ],
  ["init bad name", ["init", "Not_Kebab"], '"Not_Kebab" is not a kebab-case memory name'],
  ["empty value", ["add", "@a/b", "--from", ""], "option --from needs a value"],
  ["empty pin", ["add", "@a/b", "--pin="], "option --pin needs a value"],
  ["blank list", ["remove", "--all", "-m", " , "], "option --memory needs a value"],
  [
    "no-fetch without list",
    ["add", "@a/b", "--no-fetch"],
    "--no-fetch on add previews the store copy; add --list\nTip: an install always fetches; run sync --no-fetch for an offline apply",
  ],
  [
    "inherited word as verb",
    ["constructor"],
    "Unknown command: constructor\nTip: Run maxims --help for usage.",
  ],
  [
    "show without name",
    ["show"],
    "show needs a memory or source name\nTip: maxims show <memory or source>",
  ],
  ["show neither name nor source", ["show", "Not_Kebab"], "Not_Kebab is not installed"],
  ["show with out", ["show", "x", "-o", "dir"], "unknown option: -o"],
  ["show two scopes", ["show", "x", "-g", "-p"], "two destinations given"],
  ["show with nothing installed", ["show", "x"], "x is not installed"],
  ["yes on disable", ["disable", "skip-unfit-skills", "-y"], "unknown option: -y"],
  ["extra word on remove", ["remove", "@a/b", "@a/c", "-y"], "unexpected argument: @a/c"],
  [
    "extra word on config unset",
    ["config", "unset", "rule", "false"],
    "unexpected argument: false",
  ],
];

test.each(refusals)(
  "%s exits 1 with the usage message and writes nothing",
  async (_name, argv, message) => {
    await withScenario({}, async (scenario) => {
      const before = await snapshot(scenario.root);
      const run = await runCli(scenario, argv);
      expect(run.code).toBe(1);
      expect(run.stderr).toBe(` ERROR  ${message}\n`);
      expect(run.stdout).toBe("");
      expect(await snapshot(scenario.root)).toBe(before);
      expect(scenario.engine.calls).toEqual(NO_ENGINE_CALLS);
    });
  },
);

// Under --json the refusal itself is the one JSON document, on stdout.
const jsonRefusals: [string, string[], string][] = [
  [
    "json without yes",
    ["add", "@a/b", "--json"],
    "The --json flag requires --yes (or --all) to run non-interactively.",
  ],
  [
    "json without yes on install, which has no --all",
    ["install", "--json"],
    "The --json flag requires --yes to run non-interactively.",
  ],
  [
    "json with list",
    ["add", "@a/b", "--json", "-y", "--list"],
    "The --json flag cannot be combined with --list.",
  ],
  [
    "remove --all with -m",
    ["remove", "--all", "-m", "skip-unfit-skills", "--json"],
    "Cannot combine --all with specific memory names.",
  ],
];

test.each(jsonRefusals)("%s exits 1 with one JSON document", async (_name, argv, message) => {
  await withScenario({}, async (scenario) => {
    const run = await runCli(scenario, argv);
    expect(run.code).toBe(1);
    expect(run.stderr).toBe("");
    expect(JSON.parse(run.stdout)).toEqual({ ok: false, code: 1, message, hint: null });
    expect(scenario.engine.calls).toEqual(NO_ENGINE_CALLS);
  });
});

const VERBS = [
  "add",
  "sync",
  "update",
  "remove",
  "list",
  "show",
  "install",
  "link",
  "unlink",
  "disable",
  "enable",
  "doctor",
  "config",
  "init",
  "lint",
  "mcp-serve",
];

test.each(VERBS.map((verb) => [verb] as const))(
  "%s --help prints usage before any I/O and changes nothing",
  async (verb) => {
    await withScenario({ github: { "a/b": SKILLS } }, async (scenario) => {
      const before = await snapshot(scenario.root);
      const run = await runCli(scenario, [verb, "@a/b", "-y", "--help"]);
      expect(run.code).toBe(0);
      expect(run.stdout.startsWith(`Usage: maxims ${verb}`)).toBe(true);
      expect(scenario.fetches).toEqual([]);
      expect(scenario.engine.calls.sync).toEqual([]);
      expect(await snapshot(scenario.root)).toBe(before);
    });
  },
);

// The control for the snapshot above: a verb that only created an empty directory must not pass.
test("the snapshot changes when an empty directory appears", async () => {
  await withScenario({}, async (scenario) => {
    const before = await snapshot(scenario.root);
    mkdirSync(join(scenario.root, "control"));
    expect(await snapshot(scenario.root)).not.toBe(before);
  });
});

test("-h anywhere on the line wins over an unknown flag, and -v prints the version", async () => {
  await withScenario({}, async (scenario) => {
    const attached = await runCli(scenario, ["add", "@a/b", "-o/home/user/vault", "-y", "--json"]);
    expect(attached.code).not.toBe(0);
    expect(attached.stdout).not.toContain(`maxims ${VERSION}`);
    expect(attached.stdout).not.toContain("Usage:");
    const help = await runCli(scenario, ["add", "--frobnicate", "-h"]);
    expect(help.code).toBe(0);
    expect(help.stdout).toContain("Usage: maxims add <source>");
    const version = await runCli(scenario, ["sync", "-v"]);
    expect(version).toEqual({ code: 0, stdout: `maxims ${VERSION}\n`, stderr: "" });
    const bare = await runCli(scenario, []);
    expect(bare.code).toBe(0);
    expect(bare.stdout).toContain("Commands:");
    expect(bare.stdout).not.toContain("mcp-serve");
    const bogus = await runCli(scenario, ["--bogus", "--json"]);
    expect(bogus.code).toBe(1);
    expect(JSON.parse(bogus.stdout)).toMatchObject({
      ok: false,
      message: "unknown option: --bogus",
    });
    expect((await runCli(scenario, ["--quiet"])).code).toBe(0);
  });
});

// `--json` promises one JSON document on stdout whatever else the line says, help and version
// included; neither loads the engine.
test("--json wraps --version, --help and the bare invocation in one document", async () => {
  await withScenario({}, async (scenario) => {
    const version = await runCli(scenario, ["--json", "--version"]);
    expect(version.code).toBe(0);
    expect(JSON.parse(version.stdout)).toEqual({ ok: true, version: VERSION });
    const help = await runCli(scenario, ["add", "-h", "--json"]);
    expect(help.code).toBe(0);
    const helpBody = JSON.parse(help.stdout) as { ok: boolean; help: string };
    expect(helpBody.ok).toBe(true);
    expect(helpBody.help).toContain("Usage: maxims add <source>");
    const bare = await runCli(scenario, ["--json"]);
    expect(bare.code).toBe(0);
    const bareBody = JSON.parse(bare.stdout) as { ok: boolean; help: string };
    expect(bareBody.help).toContain("Commands:");
    expect(bare.stderr).toBe("");
  });
});

const aliases: [string, string][] = [
  ["a", "add"],
  ["rm", "remove"],
  ["r", "remove"],
  ["ls", "list"],
  ["check", "update"],
  ["upgrade", "update"],
  ["i", "install"],
];

test.each(aliases)("alias %s resolves to %s", async (alias, verb) => {
  await withScenario({}, async (scenario) => {
    const run = await runCli(scenario, [alias, "--help"]);
    expect(run.stdout.startsWith(`Usage: maxims ${verb}`)).toBe(true);
  });
});

// The same selection spelled four ways reaches the state file as one list.
const selectionSpellings: [string, string[]][] = [
  ["comma list", ["-m", "gate-exit-conditions-the-merge,skip-unfit-skills"]],
  ["repetition", ["-m", "gate-exit-conditions-the-merge", "-m", "skip-unfit-skills"]],
  ["equals form", ["--memory=gate-exit-conditions-the-merge", "--memory=skip-unfit-skills"]],
  ["mixed", ["--memory", "gate-exit-conditions-the-merge", "-m", "skip-unfit-skills"]],
  ["attached short value", ["-mgate-exit-conditions-the-merge", "-mskip-unfit-skills"]],
];

test.each(selectionSpellings)("%s composes into one selection", async (_name, flags) => {
  await withScenario({ github: { "a/b": SKILLS } }, async (scenario) => {
    const run = await runCli(scenario, ["add", "@a/b", "-g", "-a", "codex", ...flags]);
    expect(run.code).toBe(0);
    const state = JSON.parse(readFileSync(join(scenario.home, "state.json"), "utf8")) as {
      sources: Record<string, { intent: { select: string[] } }>;
    };
    expect(state.sources["@a/b"]?.intent.select).toEqual([
      "gate-exit-conditions-the-merge",
      "skip-unfit-skills",
    ]);
  });
});
