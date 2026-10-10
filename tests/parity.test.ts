// Fails if maxims drifts from the `npx skills` surface captured from skills@1.7.2 into
// tests/fixtures/golden/skills-help.txt: a shared flag respelled or re-shaped, a short letter
// reassigned while `skills` keeps the old one, a documented alias dropped, a usage error that
// stops exiting 1, or an upstream flag or verb that no parity decision in scripts/lib/parity.ts
// claims yet. The flag table on docs/parity.md is rendered from those decisions, so it has no
// pin here.
import { expect, test } from "bun:test";
import { join } from "node:path";
import {
  ANALOG_FLAGS,
  DIVERGE_FLAGS,
  DIVERGE_VERBS,
  FIXTURE,
  MAXIMS_FLAGS,
  maximsFlag,
  SAME_FLAGS,
  SAME_VERBS,
  SCAN_FLAGS,
  UNCLAIMED_VERBS,
  UPSTREAM,
  type UpstreamFlag,
  upstreamFlag,
  upstreamVerb,
} from "../scripts/lib/parity.ts";
import { normalizeHelp } from "../scripts/lib/skills_help.ts";
import type { FlagSpec } from "../src/commands/frame/options.ts";
import { ExitCode } from "../src/util/exit-codes.ts";
import { VERSION } from "../src/version.ts";
import { FIXTURES, runCli, type Scenario, withScenario } from "./cli/harness.ts";

const SKILLS = join(FIXTURES, "skills");

// `rm` is documented only by an example line, which names no verb, so the mapping is a decision.
const EXAMPLE_ONLY_ALIASES: Record<string, string> = { rm: "remove" };
for (const [alias, verb] of Object.entries(EXAMPLE_ONLY_ALIASES)) {
  if (!UPSTREAM.exampleWords.has(alias)) throw new Error(`no example uses ${alias}`);
  upstreamVerb(verb).aliases.push(alias);
}

type Shape = Pick<UpstreamFlag, "long" | "short" | "kind">;

const shape = ({ long, short, kind }: UpstreamFlag): Shape => ({ long, short, kind });

function comparable(flag: FlagSpec): Shape {
  return { long: flag.name, short: flag.short ?? null, kind: flag.kind };
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
  expect(comparable(maximsFlag(long))).toEqual(shape(upstreamFlag(long)));
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
  expect(shape(upstreamFlag(upstreamLong))).toEqual({ long: "skill", short: "s", kind: "list" });
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
  expect(MAXIMS_FLAGS.map((flag) => flag.name)).not.toContain(long);
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
