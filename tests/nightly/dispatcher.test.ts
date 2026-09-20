// Fails if the failure report leaves the layout the tracking-issue action reads (heading on line
// 1, the replay block right under it), if the step summary stops reaching the file GitHub reads
// or stdout when there is none, or if the dispatcher accepts a category it has no module for, a
// flag the category ignores, or a report directory inside the repository.
import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { writeFailureReport, writeStepSummary } from "../../scripts/nightly/report.ts";
import { CATEGORIES } from "../../scripts/nightly.ts";
import { withTempDir } from "../shared/temp_dir.ts";

const repoRoot = resolve(import.meta.dir, "..", "..");
// The refusal names where the bytes would land, which on Windows expands a short-name checkout.
const realRepoRoot = realpathSync.native(repoRoot);

test("the failure report lands at <dir>/<category>/report.md with the heading and replay first", async () => {
  await withTempDir((dir) => {
    writeFailureReport(dir, "harness-drift", {
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
