// Fails if the frame drifts from the mirrored `npx skills` shape: the golden files under
// tests/fixtures/golden are the bytes a user sees at width 80 with color off, and the clack
// renderer must draw the same lines as the plain one once glyphs and ANSI are folded away, so
// one string table serves both.
import { expect, test } from "bun:test";
import { readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { PassThrough } from "node:stream";
import { createClackConsole } from "../../src/console/clack.ts";
import type { Console, ConsoleMode } from "../../src/console/contract.ts";
import { agentIdFrom, consoleMode } from "../../src/console/mode.ts";
import { createPlainConsole } from "../../src/console/plain.ts";
import { FIXTURES, runCli, type Scenario, withScenario } from "../cli/harness.ts";

const GOLDEN = resolve(import.meta.dir, "..", "fixtures", "golden");
const SKILLS = join(FIXTURES, "skills");
const DOTFILES = join(FIXTURES, "dotfiles");
const RISKY = join(FIXTURES, "risky");

function golden(name: string): string {
  return readFileSync(join(GOLDEN, `${name}.txt`), "utf8");
}

type Golden = [string, Parameters<typeof withScenario>[0], (scenario: Scenario) => Promise<string>];

const goldens: Golden[] = [
  [
    "add-install",
    {
      tty: true,
      agent: "claude-code",
      github: { "vivswan/skills": SKILLS },
      syncReport: { rules: 4, tokens: 103 },
    },
    async (scenario) => {
      const run = await runCli(scenario, [
        "add",
        "@Vivswan/skills",
        "-g",
        "--rule",
        "--add-hook",
        "-a",
        "claude-code",
      ]);
      expect(run.code).toBe(0);
      return run.stdout;
    },
  ],
  [
    "add-list",
    { github: { "vivswan/skills": SKILLS } },
    async (scenario) => (await runCli(scenario, ["add", "@Vivswan/skills", "--list"])).stdout,
  ],
  [
    "add-plain-all-items",
    { github: { "vivswan/skills": SKILLS }, syncReport: { rules: 4, tokens: 103 } },
    async (scenario) =>
      (await runCli(scenario, ["add", "@Vivswan/skills", "-g", "--rule", "-a", "codex"])).stdout,
  ],
  [
    "add-risk-warnings",
    { github: { "a/r": RISKY }, syncReport: { rules: 2, tokens: 60 } },
    async (scenario) => {
      const run = await runCli(scenario, ["add", "@a/r", "-g", "--rule", "-a", "codex"]);
      expect(run.code).toBe(0);
      return run.stdout;
    },
  ],
  [
    "collision-error",
    { github: { "a/b": SKILLS, "a/d": DOTFILES } },
    async (scenario) => {
      await runCli(scenario, ["add", "@a/b", "-g", "-a", "codex"]);
      const run = await runCli(scenario, ["add", "@a/d", "-g", "-a", "codex"]);
      expect(run.code).toBe(6);
      return run.stdout + run.stderr;
    },
  ],
  [
    "remove-refused",
    { github: { "a/b": SKILLS } },
    async (scenario) => {
      await runCli(scenario, ["add", "@a/b", "-g", "-a", "codex"]);
      const run = await runCli(scenario, ["remove", "@a/b"]);
      expect(run.code).toBe(1);
      return run.stdout + run.stderr;
    },
  ],
  [
    "update-run",
    {
      github: { "a/b": SKILLS },
      syncReport: {
        fetched: ["@a/b"],
        upstreamChanges: { "@a/b": ["+ skip-unfit-skills", "- old-rule"] },
        notices: [
          "maxims: @a/b has new memories not in your selection: gate-exit-conditions-the-merge, no-sleep-waiting-on-subagents, rubber-duck-before-every-commit",
        ],
      },
    },
    async (scenario) => {
      await runCli(scenario, ["add", "@a/b", "-g", "-a", "codex", "-m", "skip-unfit-skills"]);
      return (await runCli(scenario, ["update"])).stdout;
    },
  ],
  [
    "usage-errors",
    {},
    async (scenario) => {
      const lines: string[] = [];
      for (const argv of [
        ["add"],
        ["add", "@a/b", "-g", "-o", "x"],
        ["add", "@a/b", "--json"],
        ["frob"],
      ]) {
        lines.push((await runCli(scenario, argv)).stderr);
      }
      return lines.join("");
    },
  ],
];

// MAXIMS_UPDATE_GOLDEN=1 rewrites the fixtures from the current output; the diff is then reviewed
// like any other change to what the user sees.
test.each(goldens)("golden %s matches byte for byte", async (name, options, produce) => {
  await withScenario({ columns: 80, ...options }, async (scenario) => {
    const actual = await produce(scenario);
    if (process.env.MAXIMS_UPDATE_GOLDEN === "1")
      writeFileSync(join(GOLDEN, `${name}.txt`), actual);
    expect(actual).toBe(golden(name));
  });
});

// Clack decides its glyph set once from the terminal, so the comparison folds every glyph it may
// pick to the ASCII the plain console prints, and drops ANSI sequences and spinner frames.
const GLYPHS: [RegExp, string][] = [
  [/[\u2502\u250c\u2514]/g, "|"],
  [/\u25c7/g, "o"],
  [/\u25b2/g, "!"],
  [/\u25a0/g, "x"],
];
const SPINNER_FRAME = /^[\u25d0-\u25d3|o*x!]\s*$/;

const ANSI = new RegExp(`${String.fromCharCode(27)}\\[[0-9;?]*[A-Za-z]`, "g");

function normalize(text: string): string {
  let out = text.replace(ANSI, "").replace(/\r/g, "\n");
  for (const [glyph, ascii] of GLYPHS) out = out.replace(glyph, ascii);
  return out
    .split("\n")
    .filter(
      (line) =>
        !line.includes("Cloning repository...") && !SPINNER_FRAME.test(line) && line.trim() !== "",
    )
    .join("\n");
}

function scenarioLines(console: Console): void {
  console.intro();
  console.step("Source: https://github.com/Vivswan/skills.git");
  console.spinner("Cloning repository...").stop("Repository cloned");
  console.warn("README.md is not a memory: missing frontmatter");
  console.step("Found 4 memories");
  console.gap();
  console.note("Vivswan Skills -> ~/.claude/rules/maxims-vivswan-skills.md", "Memories to install");
  console.gap();
  console.item(
    "rubber-duck-before-every-commit",
    "Use when about to commit or merge ANY change, however trivial - the rubber-duck review WITH CODEX must run and converge first",
  );
  console.more(3);
  console.error("gate-exit-conditions-the-merge is owned by @a/b");
  console.outro("Run without --list to install");
}

test("the clack and plain renderers print the same lines minus glyphs, ANSI and spinner frames", async () => {
  const mode: ConsoleMode = {
    tty: true,
    stdinTty: true,
    agent: null,
    yes: true,
    quiet: false,
    json: false,
    width: 80,
  };
  let plain = "";
  scenarioLines(createPlainConsole(mode, { write: (chunk: string) => (plain += chunk) }));
  const output = new PassThrough();
  let clack = "";
  output.on("data", (chunk: Buffer) => (clack += chunk.toString()));
  const input = new PassThrough();
  scenarioLines(createClackConsole(mode, { output, input }));
  await new Promise((done) => setTimeout(done, 20));
  expect(normalize(clack)).toBe(normalize(plain));
  // The control: a one-word change on one side must survive normalization, or the comparison
  // above proves nothing.
  expect(normalize(clack.replace("Found 4", "Found 5"))).not.toBe(normalize(plain));
});

// The non-interactive matrix, row by row: which rows show the banner and which ever prompt.
const matrix: [string, { isTTY: boolean }, boolean, string | null, boolean, boolean, boolean][] = [
  ["tty, no agent, no yes", { isTTY: true }, true, null, false, true, false],
  ["tty out, piped in", { isTTY: true }, false, null, false, false, false],
  ["tty, no agent, yes", { isTTY: true }, true, null, true, false, false],
  ["tty, agent", { isTTY: true }, true, "claude", false, false, true],
  ["no tty", { isTTY: false }, true, "claude", false, false, false],
];

test.each(matrix)("mode row %s", async (_name, stdout, stdinTty, agent, yes, prompts, banner) => {
  const { promptsAllowed } = await import("../../src/console/contract.ts");
  const mode = consoleMode({ stdout, stdinTty, agent, yes, quiet: false, json: false });
  expect(promptsAllowed(mode)).toBe(prompts);
  let out = "";
  createPlainConsole(mode, { write: (chunk: string) => (out += chunk) }).intro();
  expect(out.includes("Agent detected")).toBe(banner && agent !== null && stdout.isTTY);
});

// The detector reads the real environment, so each row runs against a process env holding only
// the variables named; the Cursor IDE's terminal marker must not count while its agent's does.
const cursorRows: [string, Record<string, string>, string | null][] = [
  ["a Cursor IDE terminal", { CURSOR_TRACE_ID: "trace" }, null],
  ["the Cursor agent", { CURSOR_AGENT: "1" }, "cursor-cli"],
  ["a plain shell", {}, null],
];

test.each(cursorRows)(
  "%s is read from @vercel/detect-agent as expected",
  async (_name, env, id) => {
    const { determineAgent } = await import("@vercel/detect-agent");
    const saved = { ...process.env };
    for (const key of Object.keys(process.env)) delete process.env[key];
    Object.assign(process.env, env);
    try {
      expect(agentIdFrom(await determineAgent())).toBe(id);
    } finally {
      for (const key of Object.keys(process.env)) delete process.env[key];
      Object.assign(process.env, saved);
    }
  },
);
