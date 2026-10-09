// Drives the PUBLISHED `next` package, not the bundle built in this checkout, through one install
// round trip under a throwaway HOME: `npx` fetches the exact version the dist-tag names, and each
// step has one expected exit code plus what it must leave on disk or print. Every other suite runs
// `dist/cli.js`, so a defect that only exists in the npm artifact is visible here alone.
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { inheritedEnv } from "../lib/env.ts";
import { markdownTable, type Outcome } from "./report.ts";
import { type RuleFile, readRuleFile } from "./rule_file.ts";
import { withScratchDir } from "./scratch.ts";

export const PACKAGE = "@vivswan/maxims";
export const DIST_TAG = "next";
export const VERSION_ARGV = ["npm", "view", PACKAGE, `dist-tags.${DIST_TAG}`] as const;

// The whole round trip, fetch included, must finish inside this budget; the fetch is the slow
// step and a registry that hangs is a red night, not a long one.
export const TOTAL_BUDGET_MS = 5 * 60_000;

// One line per memory in the rule file; two prove the block holds more than one line.
export const FIXTURE_MEMORIES = [
  { name: "alpha-rule", description: "Smoke rule alpha for the published package" },
  { name: "beta-rule", description: "Smoke rule beta for the published package" },
] as const;

// The rule file is seeded so `remove` has something to restore; a run that only proved deletion
// would not see a shared block that ate the user's own lines.
export const SEEDED_RULE_FILE = "# Agents\n\nA line maxims must leave alone.\n";

export type Command = {
  argv: readonly string[];
  cwd: string;
  env: Record<string, string>;
  timeoutMs: number;
};
export type CommandResult = { exitCode: number | "timeout"; stdout: string; stderr: string };
export type CommandRunner = (command: Command) => Promise<CommandResult>;

export type World = { home: string; version: string };

export type Step = {
  name: string;
  // The arguments after the package spec.
  argv: readonly string[];
  judge: (result: CommandResult, world: World) => string[];
};

export type StepResult =
  | { step: Step; ran: false }
  | { step: Step; ran: true; result: CommandResult; problems: string[]; ms: number };

const CODEX_RULE_FILE = ".codex/AGENTS.md";
const codexRuleFile = (home: string): string => join(home, CODEX_RULE_FILE);
const codexRule = (home: string): RuleFile => readRuleFile(home, CODEX_RULE_FILE, "is gone");

function exitZero(result: CommandResult): string[] {
  return result.exitCode === 0 ? [] : [`exited ${result.exitCode}, expected 0`];
}

export const STEPS: readonly Step[] = [
  {
    name: "--version names the published version",
    argv: ["--version"],
    judge: (result, world) => {
      const expected = `maxims ${world.version}`;
      const printed = result.stdout.trim();
      return [
        ...exitZero(result),
        ...(printed === expected ? [] : [`printed \`${printed}\`, expected \`${expected}\``]),
      ];
    },
  },
  {
    name: "add installs the fixture into the codex rule file",
    argv: ["add", "<fixture>", "-g", "--rule", "-a", "codex", "-y"],
    judge: (result, world) => {
      const file = codexRule(world.home);
      if ("problem" in file) return [...exitZero(result), file.problem];
      const { text } = file;
      const missing = FIXTURE_MEMORIES.filter(
        (memory) => !text.includes(`\n- ${memory.description} (detail: `),
      );
      return [
        ...exitZero(result),
        ...missing.map((memory) => `no rule line for ${memory.name} in ~/.codex/AGENTS.md`),
        ...(text.startsWith(SEEDED_RULE_FILE) ? [] : ["the seeded lines above the block changed"]),
      ];
    },
  },
  {
    name: "sync --quiet exits 0 and says nothing",
    argv: ["sync", "--quiet"],
    judge: (result) => [
      ...exitZero(result),
      ...(result.stdout === "" ? [] : ["wrote to stdout"]),
      ...(result.stderr === "" ? [] : ["wrote to stderr"]),
    ],
  },
  {
    name: "remove restores the codex rule file",
    argv: ["remove", "<fixture>", "-y"],
    judge: (result, world) => {
      const file = codexRule(world.home);
      if ("problem" in file) return [...exitZero(result), file.problem];
      return [
        ...exitZero(result),
        ...(file.text === SEEDED_RULE_FILE
          ? []
          : ["~/.codex/AGENTS.md is not the seeded file again"]),
      ];
    },
  },
];

// MAXIMS_HOME stays unset on purpose: the package must find its default store under HOME. The
// registry is pinned past any mirror in the user's npmrc, which can lag behind a fresh `next`, and
// the update notice is off so `sync --quiet` has no stderr that is npm's rather than maxims's.
function childEnv(home: string, npmCache: string): Record<string, string> {
  return {
    ...inheritedEnv(),
    HOME: home,
    USERPROFILE: home,
    NO_COLOR: "1",
    CI: "1",
    COLUMNS: "80",
    TERM: "dumb",
    npm_config_cache: npmCache,
    npm_config_registry: "https://registry.npmjs.org/",
    npm_config_update_notifier: "false",
  };
}

// Bun kills the process at its budget; SIGKILL is the runner's own signal, nothing else in the
// smoke run sends it, so a child that died by it is one the budget killed. Its output is given up
// unread: `npx` runs the package as a grandchild that inherits the pipes, and a read would wait
// for it. Bun buffers the pipes while the child runs, so a read after a normal exit has it all.
export const spawnCommand: CommandRunner = async (command) => {
  const proc = Bun.spawn([...command.argv], {
    cwd: command.cwd,
    env: command.env,
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
    timeout: command.timeoutMs,
    killSignal: "SIGKILL",
  });
  const exitCode = await proc.exited;
  if (proc.signalCode === "SIGKILL") return { exitCode: "timeout", stdout: "", stderr: "" };
  const [stdout, stderr] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  return { exitCode, stdout, stderr };
};

function writeFixture(dir: string): void {
  mkdirSync(join(dir, "memories"), { recursive: true });
  for (const memory of FIXTURE_MEMORIES) {
    writeFileSync(
      join(dir, "memories", `${memory.name}.md`),
      [
        "---",
        `name: ${memory.name}`,
        `description: ${memory.description}`,
        "metadata:",
        "  node_type: memory",
        "  type: feedback",
        "---",
        "",
        "**Why:** it exists to be installed by the smoke run.",
        "",
      ].join("\n"),
    );
  }
}

const TITLE = `The published ${DIST_TAG} package failed its smoke run`;
const HEADING = "## Published smoke";
const versionLine = (version: string): string => `\`${VERSION_ARGV.join(" ")}\`: ${version}`;

function fail(body: string): Outcome {
  return { status: "fail", summary: `${HEADING}\n\n${body}`, report: { title: TITLE, body } };
}

export function summarizeSteps(version: string, results: readonly StepResult[]): Outcome {
  const table = markdownTable(
    ["step", "argv", "exit", "ms", "verdict"],
    results.map((row) => [
      row.step.name,
      `\`maxims ${row.step.argv.join(" ")}\``,
      ...(row.ran
        ? [String(row.result.exitCode), String(row.ms), row.problems.length === 0 ? "ok" : "FAIL"]
        : ["-", "-", "not run"]),
    ]),
  );
  const summary = `${HEADING}\n\n${versionLine(version)}\n\n${table}\n`;
  const failed = results.flatMap((row) => (row.ran && row.problems.length > 0 ? [row] : []));
  if (failed.length === 0) return { status: "pass", summary };
  const details = failed.map(({ step, result, problems }) =>
    [
      `### ${step.name}`,
      "",
      ...problems.map((problem) => `- ${problem}`),
      "",
      "```text",
      `${result.stdout}${result.stderr}`.trimEnd(),
      "```",
    ].join("\n"),
  );
  return fail(`${versionLine(version)}\n\n${table}\n\n${details.join("\n\n")}\n`);
}

// `sync` and `remove` after a failed `add` would only report the same defect from further away.
export async function runPublishedSmoke(run: CommandRunner = spawnCommand): Promise<Outcome> {
  const started = performance.now();
  const remaining = (): number => Math.max(1, TOTAL_BUDGET_MS - (performance.now() - started));
  return withScratchDir("maxims-published-smoke-", async (scratch) => {
    const home = join(scratch, "home");
    const fixture = join(scratch, "fixture");
    const npmCache = join(scratch, "npm-cache");
    mkdirSync(join(home, ".codex"), { recursive: true });
    writeFileSync(codexRuleFile(home), SEEDED_RULE_FILE);
    writeFixture(fixture);
    const env = childEnv(home, npmCache);
    const command = (argv: readonly string[]): Command => ({
      argv,
      cwd: home,
      env,
      timeoutMs: remaining(),
    });

    const resolved = await run(command(VERSION_ARGV));
    const version = resolved.stdout.trim();
    if (resolved.exitCode !== 0 || version === "") {
      const shown = `\`${VERSION_ARGV.join(" ")}\` exited ${resolved.exitCode} without a version`;
      return fail(`${shown}:\n\n\`\`\`text\n${resolved.stderr.trimEnd()}\n\`\`\`\n`);
    }
    const world: World = { home, version };
    const spec = `${PACKAGE}@${version}`;

    const results: StepResult[] = [];
    let stopped = false;
    for (const step of STEPS) {
      if (stopped) {
        results.push({ step, ran: false });
        continue;
      }
      const argv = step.argv.map((arg) => (arg === "<fixture>" ? fixture : arg));
      const before = performance.now();
      const result = await run(command(["npx", "-y", spec, ...argv]));
      const ms = Math.round(performance.now() - before);
      const problems =
        result.exitCode === "timeout"
          ? [`killed after ${ms} ms, past the ${TOTAL_BUDGET_MS} ms budget`]
          : step.judge(result, world);
      results.push({ step, ran: true, result, problems, ms });
      stopped = problems.length > 0;
    }
    return summarizeSteps(version, results);
  });
}
