// Fails if the smoke run stops pinning the exact published version it fetched, lets the user's
// MAXIMS_HOME or npm cache leak into the throwaway HOME, writes a fixture the memory contract
// would refuse, judges a step by anything but its exit code plus what it left on disk or printed,
// keeps going after a step missed, reports a red step without the version pair, the step's own
// output, or the registry failure that stopped it, or lets a grandchild holding the pipes keep the
// runner past its budget.
import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  type Command,
  type CommandResult,
  type CommandRunner,
  FIXTURE_MEMORIES,
  PACKAGE,
  runPublishedSmoke,
  SEEDED_RULE_FILE,
  spawnCommand,
  TOTAL_BUDGET_MS,
  VERSION_ARGV,
} from "../../scripts/nightly/published_smoke.ts";
import { parseMemory } from "../../src/memory/contract.ts";
import { WINDOWS } from "../shared/platform.ts";

const VERSION = "0.0.1-main.42.20260101.gabcdef0";
const SPEC = `${PACKAGE}@${VERSION}`;

const ok = (stdout = ""): CommandResult => ({ exitCode: 0, stdout, stderr: "" });

const ruleFile = (home: string): string => join(home, ".codex", "AGENTS.md");

// What a healthy package leaves behind: the seeded lines, then one block line per memory.
function installedRuleFile(home: string): string {
  const lines = FIXTURE_MEMORIES.map(
    (memory) =>
      `- ${memory.description} (detail: ${join(home, ".agents", "maxims", "store", `${memory.name}.md`)}, 0123abc)`,
  );
  return `${SEEDED_RULE_FILE}\n<!-- maxims:begin fixture -->\n${lines.join("\n")}\n<!-- maxims:end fixture -->\n`;
}

// A published package that behaves, step by step, with `overrides` standing in for the verbs a
// row wants to see misbehave. The verb is the first argument after the package spec.
function scripted(
  overrides: Partial<Record<string, (command: Command) => CommandResult>> = {},
  view: CommandResult = ok(`${VERSION}\n`),
): { calls: Command[]; run: CommandRunner } {
  const calls: Command[] = [];
  const run: CommandRunner = async (command) => {
    calls.push(command);
    if (command.argv[0] === "npm") return view;
    const verb = command.argv[3] ?? "";
    const override = overrides[verb];
    if (override !== undefined) return override(command);
    const home = command.env.HOME ?? "";
    switch (verb) {
      case "--version":
        return ok(`maxims ${command.argv[2]?.slice(PACKAGE.length + 1)}\n`);
      case "add":
        writeFileSync(ruleFile(home), installedRuleFile(home));
        return ok("Installed 2 memories\n");
      case "sync":
        return ok();
      case "remove":
        writeFileSync(ruleFile(home), SEEDED_RULE_FILE);
        return ok("Removed 2 memories\n");
      default:
        throw new Error(`unexpected verb ${verb}`);
    }
  };
  return { calls, run };
}

// The scratch HOME sits under the launcher's temp HOME, where the launcher removes it after an
// interrupted run; RUNNER_TEMP is what the scratch helper reads first.
async function withScratchUnderHome<T>(fn: () => Promise<T>): Promise<T> {
  const previous = process.env.RUNNER_TEMP;
  process.env.RUNNER_TEMP = process.env.HOME;
  try {
    return await fn();
  } finally {
    if (previous === undefined) delete process.env.RUNNER_TEMP;
    else process.env.RUNNER_TEMP = previous;
  }
}

const mustFail = (outcome: Awaited<ReturnType<typeof runPublishedSmoke>>) => {
  if (outcome.status !== "fail") throw new Error(`expected a fail outcome, got ${outcome.status}`);
  return outcome;
};

describe("runPublishedSmoke", () => {
  test("a healthy package passes with every step pinned to the fetched version", async () => {
    const { calls, run } = scripted();
    const outcome = await withScratchUnderHome(() => runPublishedSmoke(run));
    expect(outcome.status).toBe("pass");
    expect(outcome.summary).toContain(`\`${VERSION_ARGV.join(" ")}\`: ${VERSION}\n`);
    expect(outcome.summary.match(/\| ok \|/g)).toHaveLength(4);
    expect(outcome.summary).not.toContain("FAIL");

    const [view, ...steps] = calls;
    expect(view?.argv).toEqual([...VERSION_ARGV]);
    const fixture = steps[1]?.argv[4] ?? "";
    expect(steps.map((call) => call.argv)).toEqual([
      ["npx", "-y", SPEC, "--version"],
      ["npx", "-y", SPEC, "add", fixture, "-g", "--rule", "-a", "codex", "-y"],
      ["npx", "-y", SPEC, "sync", "--quiet"],
      ["npx", "-y", SPEC, "remove", fixture, "-y"],
    ]);
    expect(fixture).not.toBe("");
    expect(fixture.startsWith(process.env.HOME ?? "/nowhere")).toBe(true);
    // Every spawn shares the one HOME and npm cache, both inside the scratch directory, and the
    // seed is in place before the first step runs.
    const home = view?.env.HOME ?? "";
    expect(home).not.toBe("");
    for (const call of calls) {
      expect(call.cwd).toBe(home);
      expect(call.env.HOME).toBe(home);
      expect(call.env.USERPROFILE).toBe(home);
      expect(call.env.MAXIMS_HOME).toBeUndefined();
      expect(call.env.npm_config_cache).toBe(join(home, "..", "npm-cache"));
      expect(call.env.npm_config_registry).toBe("https://registry.npmjs.org/");
      expect(call.timeoutMs).toBeGreaterThan(0);
      expect(call.timeoutMs).toBeLessThanOrEqual(TOTAL_BUDGET_MS);
    }
    expect(existsSync(join(home, ".."))).toBe(false);
  });

  // The fixture is what the published package reads, so it must pass the memory contract the
  // package enforces on every source; a frontmatter the contract refuses would fail `add` for a
  // reason that is this script's, not the package's.
  test("the fixture holds one memory per FIXTURE_MEMORIES entry that the memory contract accepts", async () => {
    let parsed: unknown[] = [];
    const { run } = scripted({
      add: (command) => {
        const memories = join(command.argv[4] ?? "", "memories");
        parsed = readdirSync(memories)
          .sort()
          .map((file) => parseMemory(file, readFileSync(join(memories, file), "utf8")));
        return ok();
      },
      remove: () => ok(),
    });
    await withScratchUnderHome(() => runPublishedSmoke(run));
    expect(parsed).toEqual(
      FIXTURE_MEMORIES.map((memory) => ({
        ok: true,
        memory: expect.objectContaining({ name: memory.name, description: memory.description }),
      })),
    );
  });

  test("a --version that names another version fails naming both and runs nothing after it", async () => {
    const { calls, run } = scripted({ "--version": () => ok("maxims 0.0.1-main.337.g0000000\n") });
    const outcome = mustFail(await withScratchUnderHome(() => runPublishedSmoke(run)));
    expect(calls).toHaveLength(2);
    expect(outcome.report.title).toBe("The published next package failed its smoke run");
    expect(outcome.report.body).toContain(
      `- printed \`maxims 0.0.1-main.337.g0000000\`, expected \`maxims ${VERSION}\``,
    );
    expect(outcome.report.body.match(/\| not run \|/g)).toHaveLength(3);
    expect(outcome.summary).toBe(`## Published smoke\n\n${outcome.report.body}`);
  });

  test("a step that exits non-zero fails with its exit code and its own output in the body", async () => {
    const { calls, run } = scripted({
      add: () => ({ exitCode: 3, stdout: "", stderr: " ERROR  the store is read-only\n" }),
    });
    const outcome = mustFail(await withScratchUnderHome(() => runPublishedSmoke(run)));
    expect(calls.map((call) => (call.argv[0] === "npm" ? "npm" : call.argv[3]))).toEqual([
      "npm",
      "--version",
      "add",
    ]);
    expect(outcome.report.body).toContain("### add installs the fixture into the codex rule file");
    expect(outcome.report.body).toContain("- exited 3, expected 0\n");
    expect(outcome.report.body).toContain("- no rule line for alpha-rule in ~/.codex/AGENTS.md\n");
    expect(outcome.report.body).toContain("```text\n ERROR  the store is read-only\n```");
  });

  // Exit 0 is not enough: each verb has something it must leave behind or keep quiet about.
  const silentDefects: [
    string,
    Partial<Record<string, (command: Command) => CommandResult>>,
    string,
  ][] = [
    [
      "add that writes no rule line for a memory",
      {
        add: (command) => {
          const home = command.env.HOME ?? "";
          writeFileSync(ruleFile(home), installedRuleFile(home).replace("beta", "gamma"));
          return ok();
        },
      },
      "- no rule line for beta-rule in ~/.codex/AGENTS.md",
    ],
    [
      "add that drops the seeded lines",
      {
        add: (command) => {
          const home = command.env.HOME ?? "";
          writeFileSync(ruleFile(home), installedRuleFile(home).slice(SEEDED_RULE_FILE.length));
          return ok();
        },
      },
      "- the seeded lines above the block changed",
    ],
    [
      "add that leaves a directory where the rule file was",
      {
        add: (command) => {
          const path = ruleFile(command.env.HOME ?? "");
          rmSync(path);
          mkdirSync(path);
          return ok();
        },
      },
      "- ~/.codex/AGENTS.md could not be read: EISDIR",
    ],
    [
      "sync --quiet that speaks",
      { sync: () => ({ exitCode: 0, stdout: "", stderr: "warn: something\n" }) },
      "- wrote to stderr",
    ],
    [
      "remove that leaves the block behind",
      { remove: () => ok() },
      "- ~/.codex/AGENTS.md is not the seeded file again",
    ],
  ];

  // The EISDIR row ends in the OS's own wording, so it is matched without the closing newline.
  test.each(silentDefects)("an %s fails", async (_name, overrides, problem) => {
    const { run } = scripted(overrides);
    const outcome = mustFail(await withScratchUnderHome(() => runPublishedSmoke(run)));
    expect(outcome.report.body).toContain(problem);
  });

  test("a step the runner killed fails naming the budget and shows timeout as its exit", async () => {
    const { run } = scripted({
      add: () => ({ exitCode: "timeout", stdout: "", stderr: "" }),
    });
    const outcome = mustFail(await withScratchUnderHome(() => runPublishedSmoke(run)));
    expect(outcome.report.body).toMatch(
      new RegExp(`- killed after \\d+ ms, past the ${TOTAL_BUDGET_MS} ms budget\\n`),
    );
    expect(outcome.report.body).toContain("| timeout |");
  });

  test("a registry that answers no version fails before any npx step, naming the failure", async () => {
    const { calls, run } = scripted(
      {},
      { exitCode: 1, stdout: "", stderr: "npm error code ENOTFOUND\nnpm error network\n" },
    );
    const outcome = mustFail(await withScratchUnderHome(() => runPublishedSmoke(run)));
    expect(calls).toHaveLength(1);
    expect(outcome.report.body).toBe(
      `\`${VERSION_ARGV.join(" ")}\` exited 1 without a version:\n\n` +
        "```text\nnpm error code ENOTFOUND\nnpm error network\n```\n",
    );
    expect(outcome.summary).toBe(`## Published smoke\n\n${outcome.report.body}`);
  });
});

// `npx` runs the package as a grandchild that inherits the pipes; a runner that waited for them to
// close would hang for as long as the grandchild lived after the kill. The shell here plays npx:
// its background child keeps stdout and stderr, and `exec` makes the shell itself the process the
// runner kills.
test.skipIf(WINDOWS)(
  "the runner returns at its budget while a grandchild still holds the pipes",
  async () => {
    const started = performance.now();
    const result = await spawnCommand({
      argv: ["sh", "-c", "sleep 5 & exec sleep 5"],
      cwd: process.env.HOME ?? "",
      env: { PATH: process.env.PATH ?? "" },
      timeoutMs: 200,
    });
    const elapsed = performance.now() - started;
    expect(result).toEqual({ exitCode: "timeout", stdout: "", stderr: "" });
    expect(elapsed).toBeLessThan(3_000);
  },
);
