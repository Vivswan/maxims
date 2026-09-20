// Fails if a rung's expected exit code, argv, HOME, or PATH drifts from the ladder's contract
// without anyone noticing until the runner runs, if a rung that exits unexpectedly stops failing
// the run with its stderr, or if a remote's credentials could reach the issue body.
import { describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, readdirSync, readlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  type CliRunner,
  LADDER,
  mirrorPathWithoutGit,
  runLiveNetwork,
  type StepResult,
  summarizeLadder,
} from "../../scripts/nightly/live_network.ts";
import { withTempDir } from "../shared/temp_dir.ts";

type Call = { argv: readonly string[]; env: Record<string, string> };

function recorder(exitCodes: readonly number[]): { calls: Call[]; run: CliRunner } {
  const calls: Call[] = [];
  const run: CliRunner = async (argv, env) => {
    calls.push({ argv, env });
    return { exitCode: exitCodes[calls.length - 1] ?? 0, stderr: "" };
  };
  return { calls, run };
}

const ADD = ["add", "@Vivswan/skills", "-g", "--rule", "-a", "claude-code", "-y"];

test("the ladder runs every rung against the bundle with the expected homes and PATHs", async () => {
  await withTempDir(async (dir) => {
    const bundle = join(dir, "cli.js");
    writeFileSync(bundle, "");
    const { calls, run } = recorder([0, 0, 0, 0, 2]);
    const outcome = await runLiveNetwork(bundle, run);
    expect(outcome.status).toBe("pass");
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
});

// The mirror must resolve a name the way the shell does: the first executable regular file wins;
// a directory or a plain file of that name earlier on PATH does not shadow it.
test("mirroring PATH drops git and keeps the first executable of every other name", async () => {
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
});

describe("summarizeLadder", () => {
  const result = (index: number, exitCode: number, stderr = ""): StepResult => ({
    ...LADDER[index],
    exitCode,
    stderr,
  });
  const table = [
    "| step | argv | expected | exit | verdict |",
    "|---|---|---|---|---|",
    "| add through a sparse clone | `maxims add @Vivswan/skills -g --rule -a claude-code -y` | 0 | 0 | ok |",
    "| config set cooldownDays 0 | `maxims config set cooldownDays 0` | 0 | 0 | ok |",
    "| update short-circuits on the pinned sha | `maxims update` | 0 | 0 | ok |",
    "| add through the codeload tarball with no git on PATH | `maxims add @Vivswan/skills -g --rule -a claude-code -y` | 0 | 3 | FAIL |",
    "| add a repository that does not exist | `maxims add @Vivswan/maxims-nightly-missing-repo` | 2 | 2 | ok |",
  ].join("\n");

  test("one rung off its expected exit fails with every rung's redacted stderr", () => {
    const results = [
      result(0, 0),
      result(1, 0),
      result(2, 0),
      result(3, 3, "fetch https://example-user:hunter2@codeload.github.com/tar failed\n"),
      result(4, 2, "maxims: @Vivswan/maxims-nightly-missing-repo: not found\n"),
    ];
    const outcome = summarizeLadder(results);
    expect(outcome.status).toBe("fail");
    expect(outcome.summary).toBe(`## Live network ladder\n\n${table}\n`);
    const body = outcome.status === "fail" ? outcome.report.body : "";
    expect(body.startsWith(`${table}\n\n### add through a sparse clone\n`)).toBe(true);
    expect(body).toContain(
      [
        "### add through the codeload tarball with no git on PATH",
        "",
        "`maxims add @Vivswan/skills -g --rule -a claude-code -y` (git off-path) expected exit 0, got 3.",
        "",
        "```text",
        "fetch https://codeload.github.com/tar failed",
        "```",
      ].join("\n"),
    );
    expect(body).not.toContain("hunter2");
    expect(
      body.endsWith(
        [
          "### add a repository that does not exist",
          "",
          "`maxims add @Vivswan/maxims-nightly-missing-repo` (git on-path) expected exit 2, got 2.",
          "",
          "```text",
          "maxims: @Vivswan/maxims-nightly-missing-repo: not found",
          "```",
          "",
        ].join("\n"),
      ),
    ).toBe(true);
  });
});
