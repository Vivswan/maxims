// Fails if the failure report leaves the layout the tracking-issue action reads (heading on line
// 1, the replay block right under it), if the step summary stops reaching the file GitHub reads
// or stdout when there is none, if a passing category's summary stops reaching the job log ahead
// of its status line, if the dispatcher accepts a category it has no module for, a flag the
// category ignores, or a report or trend path inside the repository, or if a category that throws
// stops leaving a report behind for the issue.
import { describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { writeFailureReport, writeStepSummary } from "../../scripts/nightly/report.ts";
import { CATEGORIES } from "../../scripts/nightly.ts";
import { withTempDir } from "../shared/temp_dir.ts";

const repoRoot = resolve(import.meta.dir, "..", "..");
// The refusal names where the bytes would land, which on Windows expands a short-name checkout.
const realRepoRoot = realpathSync.native(repoRoot);

test("the failure report lands at <dir>/<category>/report.md with the heading and replay first", async () => {
  await withTempDir((dir) => {
    writeFailureReport(dir, "harness-drift", "bun run nightly harness-drift", {
      title: "Harness documentation drift",
      body: "| id |\n|---|\n| codex |\n\n",
    });
    expect(readFileSync(join(dir, "harness-drift", "report.md"), "utf8")).toBe(
      [
        "# Harness documentation drift",
        "",
        "```sh",
        "bun run nightly harness-drift",
        "```",
        "",
        "| id |",
        "|---|",
        "| codex |",
        "",
      ].join("\n"),
    );
  });
});

describe("writeStepSummary", () => {
  test("appends to GITHUB_STEP_SUMMARY when it is set", async () => {
    await withTempDir((dir) => {
      const summary = join(dir, "summary.md");
      writeFileSync(summary, "## earlier step\n");
      writeStepSummary("## nightly\n\npass\n", { GITHUB_STEP_SUMMARY: summary });
      expect(readFileSync(summary, "utf8")).toBe("## earlier step\n## nightly\n\npass\n");
    });
  });

  test("prints to stdout when no summary file is set", () => {
    const script =
      'import { writeStepSummary } from "./scripts/nightly/report.ts";' +
      'writeStepSummary("## nightly\\n", { GITHUB_STEP_SUMMARY: "" });';
    const proc = Bun.spawnSync(["bun", "-e", script], {
      cwd: repoRoot,
      stdout: "pipe",
      stderr: "pipe",
    });
    expect({ exitCode: proc.exitCode, stdout: proc.stdout.toString() }).toEqual({
      exitCode: 0,
      stdout: "## nightly\n",
    });
  });
});

// The step summary is one click away from the job log; a passing run whose table sits only there
// shows in the log nothing of which rungs ran. The status line stays last, so a reader who tails
// the log still ends on it.
test("a pass outcome prints its summary to the log ahead of the status line and to the step summary", async () => {
  await withTempDir((dir) => {
    const summary = join(dir, "summary.md");
    writeFileSync(summary, "");
    const script =
      'import { announce } from "./scripts/nightly.ts";' +
      'announce("parity-drift", { status: "pass", summary: "## Parity drift\\n\\nno drift\\n" }, process.env);';
    const proc = Bun.spawnSync(["bun", "-e", script], {
      cwd: repoRoot,
      env: { ...process.env, GITHUB_STEP_SUMMARY: summary },
      stdout: "pipe",
      stderr: "pipe",
    });
    expect({
      exitCode: proc.exitCode,
      stdout: proc.stdout.toString(),
      stderr: proc.stderr.toString(),
      stepSummary: readFileSync(summary, "utf8"),
    }).toEqual({
      exitCode: 0,
      stdout: "## Parity drift\n\nno drift\nnightly parity-drift: pass\n",
      stderr: "",
      stepSummary: "## Parity drift\n\nno drift\n",
    });
  });
});

const USAGE =
  "usage: bun scripts/nightly.ts <category> [--report-dir <dir>] [--trend <file>] [--iterations <n>]\n" +
  `categories: ${CATEGORIES.join(" | ")}\n`;

function runNightly(args: string[]) {
  return Bun.spawnSync(["bun", "scripts/nightly.ts", ...args], {
    cwd: repoRoot,
    stdout: "pipe",
    stderr: "pipe",
  });
}

// Usage refusals happen before any category runs, so none of these reaches the network. The
// usage text is what a workflow author reads when a job names a category wrong.
const refusals: [string[], string][] = [
  [["full-moon"], "unknown category full-moon"],
  [["harness-drift", "--trend", "trend.json"], "harness-drift does not take --trend"],
  [
    ["harness-drift", "--report-dir", "dist/nightly-report"],
    `refusing to write the failure report inside the repository: ${join(realRepoRoot, "dist", "nightly-report")}`,
  ],
  [
    ["latency-trend", "--trend", "dist/trend.json"],
    `refusing to write the trend file inside the repository: ${join(realRepoRoot, "dist", "trend.json")}`,
  ],
];

test.each(refusals)("bun scripts/nightly.ts %p exits 2 with usage", (args, message) => {
  const proc = runNightly(args);
  expect({
    exitCode: proc.exitCode,
    stdout: proc.stdout.toString(),
    stderr: proc.stderr.toString(),
  }).toEqual({
    exitCode: 2,
    stdout: "",
    stderr: `nightly: ${message}\n${USAGE}`,
  });
  expect(existsSync(join(repoRoot, "dist", "nightly-report"))).toBe(false);
});

// A PATH holding only bun and git: the dispatcher itself still runs, and live-network throws at
// its first step because no node can run the bundle.
test("a category that throws exits 1 and leaves its report with the error", async () => {
  await withTempDir((dir) => {
    const bin = join(dir, "bin");
    mkdirSync(bin);
    for (const tool of ["bun", "git"]) symlinkSync(Bun.which(tool) ?? "", join(bin, tool));
    const reportDir = join(dir, "nightly-report");
    const proc = Bun.spawnSync(
      ["bun", "scripts/nightly.ts", "live-network", "--report-dir", reportDir],
      {
        cwd: repoRoot,
        env: { ...process.env, PATH: bin, GITHUB_STEP_SUMMARY: "" },
        stdout: "pipe",
        stderr: "pipe",
      },
    );
    const report = readFileSync(join(reportDir, "live-network", "report.md"), "utf8");
    expect({ exitCode: proc.exitCode, stderr: proc.stderr.toString() }).toEqual({
      exitCode: 1,
      stderr: "",
    });
    expect(proc.stdout.toString()).toContain("nightly live-network: fail\n");
    expect(report.split("\n").slice(0, 6)).toEqual([
      "# Nightly live-network did not complete",
      "",
      "```sh",
      "bun run nightly live-network",
      "```",
      "",
    ]);
    expect(report).toContain("Error: no node on PATH to run the bundle with");
  });
});
