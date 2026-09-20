// Fails if maxims drifts from the `npx skills` surface captured from skills@1.7.0 into
// tests/fixtures/golden/skills-help.txt: a shared flag respelled or re-shaped, a short letter
// reassigned while `skills` keeps the old one, a documented alias dropped, a usage error that
// stops exiting 1, or an upstream flag or verb that no parity decision claims yet.
import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { normalizeHelp } from "../scripts/lib/skills_help.ts";
import { FLAGS, type FlagSpec, GLOBAL_FLAGS } from "../src/commands/shared/options.ts";
import { ExitCode } from "../src/util/exit-codes.ts";
import { VERSION } from "../src/version.ts";
import { FIXTURES, runCli, type Scenario, withScenario } from "./cli/harness.ts";

const FIXTURE = readFileSync(
  join(import.meta.dir, "fixtures", "golden", "skills-help.txt"),
  "utf8",
);
const SKILLS = join(FIXTURES, "skills");

type Kind = FlagSpec["kind"];
type UpstreamFlag = { long: string; short: string | null; kind: Kind };
type UpstreamVerb = { verb: string; aliases: string[] };

// A flag row is two spaces, the flag in either order (`-g, --global` or `--help, -h`), an optional
// `<placeholder>`, then at least two spaces before its summary. A verb row is two spaces and a
// lower-case word; continuation lines are indented deeper and example lines start with `$ skills`.
const FLAG_LINE = /^ {2}(?:-([a-zA-Z]), )?--([a-z][a-z-]*)(?:, -([a-zA-Z]))?( <[^>]+>)? {2,}\S/;
const VERB_LINE = /^ {2}([a-z][a-z_]*)(?:, ([a-z]+))?(?: |$)(.*)$/;
const ALIAS_NOTE = /\(alias: ([a-z]+)\)/;
const EXAMPLE_LINE = /^ {2}\$ skills ([a-z_]+)/;

// The page marks a list-valued flag only by a plural placeholder (`<agents>`, `<skills>`); a
// scalar one is singular (`<json>`, `<owner>`). `use` takes one skill and one agent where `add`
// takes lists, so a flag repeated across verbs keeps the widest shape the page documents.
function kindOf(placeholder: string | undefined): Kind {
  if (placeholder === undefined) return "boolean";
  return placeholder.endsWith("s>") ? "list" : "value";
}

const KIND_WIDTH: Record<Kind, number> = { boolean: 0, value: 1, list: 2 };

function parseUpstream(page: string): {
  flags: Map<string, UpstreamFlag>;
  verbs: Map<string, UpstreamVerb>;
  exampleWords: Set<string>;
} {
  const flags = new Map<string, UpstreamFlag>();
  const verbs = new Map<string, UpstreamVerb>();
  const exampleWords = new Set<string>();
  for (const line of page.split("\n")) {
    const flag = FLAG_LINE.exec(line);
    if (flag !== null) {
      const [, shortBefore, long = "", shortAfter, placeholder] = flag;
      const row = { long, short: shortBefore ?? shortAfter ?? null, kind: kindOf(placeholder) };
      const seen = flags.get(long);
      if (seen === undefined) flags.set(long, row);
      else if (seen.short !== row.short || (seen.kind === "boolean") !== (row.kind === "boolean")) {
        throw new Error(`--${long} is documented two ways in the fixture`);
      } else if (KIND_WIDTH[row.kind] > KIND_WIDTH[seen.kind]) flags.set(long, row);
      continue;
    }
    const example = EXAMPLE_LINE.exec(line);
    if (example !== null) {
      exampleWords.add(example[1] ?? "");
      continue;
    }
    const verb = VERB_LINE.exec(line);
    if (verb === null) continue;
    const [, name = "", inlineAlias, rest = ""] = verb;
    if (verbs.has(name)) throw new Error(`${name} is documented twice in the fixture`);
    const noted = ALIAS_NOTE.exec(rest)?.[1];
    const aliases = [inlineAlias, noted].filter((alias): alias is string => alias !== undefined);
    verbs.set(name, { verb: name, aliases });
  }
  return { flags, verbs, exampleWords };
}

const UPSTREAM = parseUpstream(FIXTURE);

// `rm` is documented only by an example line, which names no verb, so the mapping is a decision.
const EXAMPLE_ONLY_ALIASES: Record<string, string> = { rm: "remove" };
for (const [alias, verb] of Object.entries(EXAMPLE_ONLY_ALIASES)) {
  if (!UPSTREAM.exampleWords.has(alias)) throw new Error(`no example uses ${alias}`);
  upstreamVerb(verb).aliases.push(alias);
}

// The parity decisions. Every upstream flag and verb belongs to exactly one list, so the census
// below fails on the first flag or verb `skills` adds until a decision places it.
const SAME_FLAGS = [
  "global",
  "project",
  "agent",
  "list",
  "yes",
  "all",
  "copy",
  "full-depth",
  "json",
];
const SCAN_FLAGS = ["help", "version"];
const ANALOG_FLAGS: Record<string, FlagSpec> = { skill: FLAGS.memory };
const DIVERGE_FLAGS = ["metadata", "subagent", "owner"];
const SAME_VERBS = ["add", "remove", "list", "update"];
const DIVERGE_VERBS = ["use", "find"];
const UNCLAIMED_VERBS = ["experimental_install", "experimental_sync", "init"];

const MAXIMS_FLAGS: readonly FlagSpec[] = [...GLOBAL_FLAGS, ...Object.values(FLAGS)];

function maximsFlag(long: string): FlagSpec | undefined {
  return MAXIMS_FLAGS.find((flag) => flag.name === long);
}

function comparable(flag: FlagSpec): UpstreamFlag {
  return { long: flag.name, short: flag.short ?? null, kind: flag.kind };
}

function upstreamFlag(long: string): UpstreamFlag {
  const row = UPSTREAM.flags.get(long);
  if (row === undefined) throw new Error(`the fixture documents no --${long}`);
  return row;
}

function upstreamVerb(name: string): UpstreamVerb {
  const row = UPSTREAM.verbs.get(name);
  if (row === undefined) throw new Error(`the fixture documents no ${name} verb`);
  return row;
}

test("the fixture is the normalized page and every upstream flag and verb has a parity row", () => {
  expect([...FIXTURE].filter((char) => char === "\x1b" || char === "\r")).toEqual([]);
  expect(normalizeHelp(FIXTURE)).toBe(FIXTURE);
  expect(FIXTURE.split("\n").find((line) => line !== "")).toStartWith("Usage: skills ");
  const claimedFlags = [
    ...SAME_FLAGS,
    ...SCAN_FLAGS,
    ...Object.keys(ANALOG_FLAGS),
    ...DIVERGE_FLAGS,
  ];
  const claimedVerbs = [...SAME_VERBS, ...DIVERGE_VERBS, ...UNCLAIMED_VERBS];
  const knownWords = [...UPSTREAM.verbs.values()].flatMap((row) => [row.verb, ...row.aliases]);
  expect({
    unclaimedFlags: [...UPSTREAM.flags.keys()].filter((long) => !claimedFlags.includes(long)),
    staleFlagRows: claimedFlags.filter((long) => !UPSTREAM.flags.has(long)),
    unclaimedVerbs: [...UPSTREAM.verbs.keys()].filter((verb) => !claimedVerbs.includes(verb)),
    staleVerbRows: claimedVerbs.filter((verb) => !UPSTREAM.verbs.has(verb)),
    undocumentedExampleWords: [...UPSTREAM.exampleWords].filter((w) => !knownWords.includes(w)),
  }).toEqual({
    unclaimedFlags: [],
    staleFlagRows: [],
    unclaimedVerbs: [],
    staleVerbRows: [],
    undocumentedExampleWords: [],
  });
});

test.each(SAME_FLAGS)("--%s keeps the skills short letter and value shape", (long) => {
  const ours = maximsFlag(long);
  if (ours === undefined) throw new Error(`maxims has no --${long}`);
  expect(comparable(ours)).toEqual(upstreamFlag(long));
});

test.each(SCAN_FLAGS)("--%s answers under both skills spellings and exits 0", async (long) => {
  const { short } = upstreamFlag(long);
  const expected = long === "help" ? /^Usage: maxims |\nUsage: maxims / : `maxims ${VERSION}\n`;
  await withScenario({}, async (scenario) => {
    for (const spelling of [`--${long}`, `-${short}`]) {
      const run = await runCli(scenario, ["add", "@a/b", spelling]);
      expect({ spelling, code: run.code, stderr: run.stderr }).toEqual({
        spelling,
        code: 0,
        stderr: "",
      });
      expect(run.stdout).toMatch(expected);
    }
  });
});

function listedNames(stdout: string): string[] {
  return [...stdout.matchAll(/^\|\s{4}([a-z][a-z0-9-]*)$/gm)].map((match) => match[1] ?? "");
}

test("-s, --skill <skills> has the counterpart -m, --memory <names> with the comma-list shape", async () => {
  const [upstreamLong, ours] = Object.entries(ANALOG_FLAGS)[0] ?? [];
  if (upstreamLong === undefined || ours === undefined) throw new Error("no analog row");
  expect(upstreamFlag(upstreamLong)).toEqual({ long: "skill", short: "s", kind: "list" });
  expect(comparable(ours)).toEqual({ long: "memory", short: "m", kind: "list" });
  await withScenario({}, async (scenario) => {
    const two = await runCli(scenario, [
      "add",
      SKILLS,
      "-m",
      "gate-exit-conditions-the-merge,skip-unfit-skills",
      "--list",
    ]);
    expect({ code: two.code, stderr: two.stderr }).toEqual({ code: 0, stderr: "" });
    expect(listedNames(two.stdout)).toEqual([
      "gate-exit-conditions-the-merge",
      "skip-unfit-skills",
    ]);
    const star = await runCli(scenario, ["add", SKILLS, "-m", "*", "--list"]);
    expect({ code: star.code, stderr: star.stderr }).toEqual({ code: 0, stderr: "" });
    expect(listedNames(star.stdout)).toEqual([
      "gate-exit-conditions-the-merge",
      "no-sleep-waiting-on-subagents",
      "rubber-duck-before-every-commit",
      "skip-unfit-skills",
    ]);
  });
});

test.each(DIVERGE_FLAGS)("--%s stays absent from maxims", async (long) => {
  upstreamFlag(long);
  expect(maximsFlag(long)).toBeUndefined();
  await withScenario({}, async (scenario) => {
    const run = await runCli(scenario, ["add", "@a/b", `--${long}`, "x"]);
    expect({ code: run.code, stderr: run.stderr }).toEqual({
      code: 1,
      stderr: ` ERROR  unknown option: --${long}\n`,
    });
  });
});

function helpAliases(help: string, verb: string): string[] {
  const line = help.split("\n").find((candidate) => candidate.startsWith(`  ${verb} `));
  if (line === undefined) throw new Error(`maxims --help lists no ${verb}`);
  return /\(([^)]*)\)$/.exec(line)?.[1]?.split(", ") ?? [];
}

test.each(SAME_VERBS)(
  "%s and every alias the fixture documents for it dispatch in maxims",
  async (verb) => {
    const { aliases } = upstreamVerb(verb);
    await withScenario({}, async (scenario) => {
      const help = await runCli(scenario, ["--help"]);
      expect(helpAliases(help.stdout, verb)).toEqual(expect.arrayContaining(aliases));
      for (const word of [verb, ...aliases]) {
        const run = await runCli(scenario, [word, "--help"]);
        expect({ word, code: run.code }).toEqual({ word, code: 0 });
        expect(run.stdout).toMatch(new RegExp(`^Usage: maxims ${verb}\\b`));
      }
    });
  },
);

// The upstream usage errors maxims shares exit 1 with the skills wording; the diverging verbs are
// unknown commands, which is the same exit.
const USAGE_ERRORS: [string, string[], string][] = [
  ...DIVERGE_VERBS.map((verb): [string, string[], string] => [
    `the ${verb} verb`,
    [verb],
    ` ERROR  Unknown command: ${verb}\nTip: Run maxims --help for usage.\n`,
  ]),
  ["a missing source", ["add"], " ERROR  Missing required argument: source\n"],
  [
    "--all with named memories",
    ["add", "@a/b", "--all", "-m", "skip-unfit-skills"],
    " ERROR  Cannot combine --all with specific memory names.\n",
  ],
];

test.each(USAGE_ERRORS)("%s exits 1 as skills does", async (_name, argv, stderr) => {
  for (const verb of DIVERGE_VERBS) upstreamVerb(verb);
  await withScenario({}, async (scenario) => {
    const run = await runCli(scenario, argv);
    expect({ code: run.code, stderr: run.stderr }).toEqual({ code: 1, stderr });
  });
});

test("--json without --yes exits 1 with the skills wording inside the JSON document", async () => {
  await withScenario({}, async (scenario) => {
    const run = await runCli(scenario, ["add", "@a/b", "--json"]);
    expect({ code: run.code, stderr: run.stderr }).toEqual({ code: 1, stderr: "" });
    expect(JSON.parse(run.stdout)).toEqual({
      ok: false,
      code: 1,
      message: "The --json flag requires --yes (or --all) to run non-interactively.",
    });
  });
});

// `skills` exits 1 for every failure; maxims keeps its richer table, so a source that cannot be
// read is distinguishable from a usage error by exit code alone.
test("a missing local source exits with the unresolvable-source code, not 1", async () => {
  await withScenario({}, async (scenario: Scenario) => {
    const run = await runCli(scenario, ["add", join(scenario.root, "absent"), "-y"]);
    expect(run.code).toBe(ExitCode.SourceUnresolvable);
    expect(run.code).not.toBe(1);
    expect(run.stdout).toContain("x  Failed to read directory\n");
  });
});
