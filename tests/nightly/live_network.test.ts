// Fails if a rung's expected exit code, argv, HOME, or PATH drifts from the ladder's contract
// without anyone noticing until the runner runs, if a bundle that exits 0 and installs nothing
// passes the ladder, if a rung that fails stops failing the run with its stderr, or if a remote's
// credentials could reach the issue body.
import { describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, readdirSync, readlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import {
  type CliRunner,
  LADDER,
  mirrorPathWithoutGit,
  runLiveNetwork,
  type StepResult,
  summarizeLadder,
} from "../../scripts/nightly/live_network.ts";
import type { Outcome } from "../../scripts/nightly/report.ts";
import { WINDOWS } from "../shared/platform.ts";
import { withTempDir } from "../shared/temp_dir.ts";

type Call = { argv: readonly string[]; env: Record<string, string> };

const ADD = ["add", "@Vivswan/skills", "-g", "--rule", "-a", "claude-code", "-y"];

// Where `maxims add @Vivswan/skills -g --rule -a claude-code` puts its rule file under HOME: the
// claude-code global rules directory and the source's slug (src/commands/shared/slug.ts). Spelled
// here rather than imported so a ladder that reads a different path fails on this file.
const RULE_FILE = ".claude/rules/maxims-vivswan-skills.md";
const RULE_FILE_SHOWN = `~/${RULE_FILE}`;

// What a working bundle leaves in the rule file: one rule line between the block markers.
const INSTALLED = [
  "<!-- maxims:begin @Vivswan/skills sha=0123456789abcdef0123456789abcdef01234567 -->",
  "- Keep a rule file a real file, never a symlink (detail: ~/.agents/memories/real-file.md, 0123456)",
  "<!-- maxims:end @Vivswan/skills -->",
  "",
].join("\n");
const EMPTY_BLOCK = [
  "<!-- maxims:begin @Vivswan/skills sha=0123456789abcdef0123456789abcdef01234567 -->",
  "<!-- maxims:end @Vivswan/skills -->",
  "",
].join("\n");
// The renderer fences a detail path holding an `@`, comma included, as a HOME under a runner's
// temp dir can hold one (src/rulefile/block.ts); the judge must read that line as a rule too.
const INSTALLED_FENCED = INSTALLED.replace(
  "(detail: ~/.agents/memories/real-file.md, 0123456)",
  "(detail: `/tmp/runner@2/home/.agents/memories/real-file.md,` 0123456)",
);

// A stand-in for the bundle: records every call, exits as told, and on each `add` of the
// reference source writes `installs` into the rule file of the HOME it ran in, or nothing.
function fakeBundle(
  exitCodes: readonly number[],
  installs: string | null,
): { calls: Call[]; run: CliRunner } {
  const calls: Call[] = [];
  const run: CliRunner = async (argv, env) => {
    calls.push({ argv, env });
    if (installs !== null && argv.includes("add") && argv.includes("@Vivswan/skills")) {
      const file = join(env.HOME, RULE_FILE);
      mkdirSync(dirname(file), { recursive: true });
      writeFileSync(file, installs);
    }
    return { exitCode: exitCodes[calls.length - 1] ?? 0, stderr: "" };
  };
  return { calls, run };
}

// The ladder as the step summary and the report print it, spelled once for every expected table
// and report below.
const RUNGS = [
  {
    name: "add through a sparse clone",
    argv: "maxims add @Vivswan/skills -g --rule -a claude-code -y",
    expected: 0,
    git: "on-path",
  },
  {
    name: "config set cooldownDays 0",
    argv: "maxims config set cooldownDays 0",
    expected: 0,
    git: "on-path",
  },
  {
    name: "update short-circuits on the pinned sha",
    argv: "maxims update",
    expected: 0,
    git: "on-path",
  },
  {
    name: "add through the codeload tarball with no git on PATH",
    argv: "maxims add @Vivswan/skills -g --rule -a claude-code -y",
    expected: 0,
    git: "off-path",
  },
  {
    name: "add a repository that does not exist",
    argv: "maxims add @Vivswan/maxims-nightly-missing-repo",
    expected: 2,
    git: "on-path",
  },
] as const;

type Rung = {
  exit: number;
  verdict: "ok" | "FAIL";
  problems?: readonly string[];
  // As the report prints it: redacted and trimmed.
  stderr?: string;
};

const table = (rungs: readonly Rung[]): string =>
  [
    "| step | argv | expected | exit | verdict |",
    "|---|---|---|---|---|",
    ...rungs.map((rung, index) => {
      const { name, argv, expected } = RUNGS[index] ?? RUNGS[0];
      return `| ${name} | \`${argv}\` | ${expected} | ${rung.exit} | ${rung.verdict} |`;
    }),
  ].join("\n");

const detail = (rung: Rung, index: number): string => {
  const { name, argv, expected, git } = RUNGS[index] ?? RUNGS[0];
  const problems = rung.problems ?? [];
  return [
    `### ${name}`,
    "",
    `\`${argv}\` (git ${git}) expected exit ${expected}, got ${rung.exit}.`,
    ...(problems.length === 0 ? [] : ["", ...problems.map((problem) => `- ${problem}`)]),
    "",
    "```text",
    rung.stderr ?? "",
    "```",
  ].join("\n");
};

const heading = "## Live network ladder";

const passed: Outcome = {
  status: "pass",
  summary: `${heading}\n\n${table([
    { exit: 0, verdict: "ok" },
    { exit: 0, verdict: "ok" },
    { exit: 0, verdict: "ok" },
    { exit: 0, verdict: "ok" },
    { exit: 2, verdict: "ok" },
  ])}\n`,
};

const failed = (rungs: readonly Rung[]): Outcome => ({
  status: "fail",
  summary: `${heading}\n\n${table(rungs)}\n`,
  report: {
    title: "Live fetch ladder against Vivswan/skills failed",
    body: `${table(rungs)}\n\n${rungs.map(detail).join("\n\n")}\n`,
  },
});

// The mirror picks executables by POSIX mode bits and symlinks them by bare name, which is not
// how a Windows PATH resolves a program.
const posixPath = test.skipIf(WINDOWS);

posixPath(
  "the ladder runs every rung against the bundle with the expected homes and PATHs",
  async () => {
    await withTempDir(async (dir) => {
      const bundle = join(dir, "cli.js");
      writeFileSync(bundle, "");
      const { calls, run } = fakeBundle([0, 0, 0, 0, 2], INSTALLED);
      const outcome = await runLiveNetwork(bundle, run);
      expect(outcome).toEqual(passed);
      const node = Bun.which("node") ?? "";
      expect(node).not.toBe("");
      expect(calls.map((call) => call.argv.slice(2))).toEqual([
        ADD,
        ["config", "set", "cooldownDays", "0"],
        ["update"],
        ADD,
        ["add", "@Vivswan/maxims-nightly-missing-repo"],
      ]);
      for (const call of calls) {
        expect(call.argv.slice(0, 2)).toEqual([node, bundle]);
        expect(call.env.MAXIMS_HOME).toBe(join(call.env.HOME, ".agents", "maxims"));
        expect(call.env.HOME).not.toBe(process.env.HOME);
      }
      const homes = calls.map((call) => call.env.HOME);
      expect(homes[0]).toBe(homes[1]);
      expect(homes[1]).toBe(homes[2]);
      expect(homes[3]).toBe(homes[4]);
      expect(homes[2]).not.toBe(homes[3]);
      const paths = calls.map((call) => call.env.PATH);
      expect(paths[0]).toBe(process.env.PATH ?? "");
      expect(paths[3]).not.toBe(process.env.PATH ?? "");
      expect(paths[3].split(":").length).toBe(1);
    });
  },
);

// The exit code is the bundle's own word for what it did. Without the rule file read back, a
// bundle that exits 0 and installs nothing climbs the whole ladder green, and the `update` rung
// after it passes with nothing to update.
posixPath.each([
  ["installs nothing", null, `${RULE_FILE_SHOWN} is missing`],
  ["writes a block with no rule line", EMPTY_BLOCK, `no rule line in ${RULE_FILE_SHOWN}`],
])("a bundle that exits as expected but %s fails the ladder", async (_case, installs, problem) => {
  await withTempDir(async (dir) => {
    const bundle = join(dir, "cli.js");
    writeFileSync(bundle, "");
    const { run } = fakeBundle([0, 0, 0, 0, 2], installs);
    const outcome = await runLiveNetwork(bundle, run);
    expect(outcome).toEqual(
      failed([
        { exit: 0, verdict: "FAIL", problems: [problem] },
        { exit: 0, verdict: "ok" },
        { exit: 0, verdict: "FAIL", problems: [problem] },
        { exit: 0, verdict: "FAIL", problems: [problem] },
        { exit: 2, verdict: "ok" },
      ]),
    );
  });
});

posixPath("a rule line whose detail path is fenced for an @ counts as installed", async () => {
  await withTempDir(async (dir) => {
    const bundle = join(dir, "cli.js");
    writeFileSync(bundle, "");
    const { run } = fakeBundle([0, 0, 0, 0, 2], INSTALLED_FENCED);
    const outcome = await runLiveNetwork(bundle, run);
    expect(outcome).toEqual(passed);
  });
});

// The mirror must resolve a name the way the shell does: the first executable regular file wins;
// a directory or a plain file of that name earlier on PATH does not shadow it.
posixPath(
  "mirroring PATH drops git and keeps the first executable of every other name",
  async () => {
    await withTempDir((dir) => {
      const first = join(dir, "first");
      const middle = join(dir, "middle");
      const second = join(dir, "second");
      const into = join(dir, "into");
      for (const d of [first, middle, second, into]) mkdirSync(d);
      const executable = (d: string, name: string): void => {
        writeFileSync(join(d, name), "");
        chmodSync(join(d, name), 0o755);
      };
      for (const name of ["git", "node", "sh"]) executable(first, name);
      mkdirSync(join(first, "tar"), { mode: 0o755 });
      writeFileSync(join(middle, "tar"), "not a program");
      for (const name of ["git", "node", "tar"]) executable(second, name);
      const path = [first, middle, join(dir, "absent"), second].join(":");
      expect(mirrorPathWithoutGit(path, into)).toBe(into);
      expect(readdirSync(into).sort()).toEqual(["node", "sh", "tar"]);
      expect(readlinkSync(join(into, "node"))).toBe(join(first, "node"));
      expect(readlinkSync(join(into, "tar"))).toBe(join(second, "tar"));
    });
  },
);

describe("summarizeLadder", () => {
  const result = (
    index: number,
    exitCode: number,
    stderr = "",
    problems: readonly string[] = [],
  ): StepResult => ({
    ...LADDER[index],
    exitCode,
    stderr,
    problems,
  });

  test("one rung off its expected exit fails with every rung's redacted stderr", () => {
    const outcome = summarizeLadder([
      result(0, 0),
      result(1, 0),
      result(2, 0),
      result(3, 3, "fetch https://example-user:hunter2@codeload.github.com/tar failed\n"),
      result(4, 2, "maxims: @Vivswan/maxims-nightly-missing-repo: not found\n"),
    ]);
    expect(outcome).toEqual(
      failed([
        { exit: 0, verdict: "ok" },
        { exit: 0, verdict: "ok" },
        { exit: 0, verdict: "ok" },
        { exit: 3, verdict: "FAIL", stderr: "fetch https://codeload.github.com/tar failed" },
        {
          exit: 2,
          verdict: "ok",
          stderr: "maxims: @Vivswan/maxims-nightly-missing-repo: not found",
        },
      ]),
    );
  });

  // A rung whose exit code matched but whose HOME holds nothing is the quiet failure; the exit
  // columns alone would read it as ok.
  test("a rung that exits as expected but leaves a problem fails the run", () => {
    const problem = `${RULE_FILE_SHOWN} is missing`;
    const outcome = summarizeLadder([result(0, 0, "", [problem])]);
    expect(outcome).toEqual(failed([{ exit: 0, verdict: "FAIL", problems: [problem] }]));
  });
});
