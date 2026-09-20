// Fails if the CI latency verdict drifts from the gates the architecture fixes: a regression past
// 25% on the hook path or the bundle must fail the job, the same regression on the interactive
// path must only warn, and exactly the threshold is not past it. Also fails if the report that
// becomes the PR comment changes shape or figures silently, or if measured data can be written
// inside the repository, where a commit would publish one machine's timings.
import { expect, test } from "bun:test";
import { resolve } from "node:path";
import {
  failed,
  type Judged,
  judge,
  type Report,
  renderJson,
  renderMarkdown,
  type Signal,
} from "../scripts/bench_ci.ts";

const repoRoot = resolve(import.meta.dir, "..");

const shape = (gate: Signal["gate"], base: number, head: number): Signal => ({
  name: "signal",
  unit: "ms",
  gate,
  base,
  head,
});

// Each row sits on one side of a threshold. The exact-threshold rows guard the strict compare, and
// the 24.4 to 30.5 row is 25% in decimal but a hair above it in binary.
const verdicts: [Signal, Pick<Judged, "ratio" | "status">][] = [
  [shape("fail", 100, 110), { ratio: 0.1, status: "ok" }],
  [shape("fail", 100, 111), { ratio: 0.11, status: "warn" }],
  [shape("fail", 100, 125), { ratio: 0.25, status: "warn" }],
  [shape("fail", 24.4, 30.5), { ratio: 0.25, status: "warn" }],
  [shape("fail", 100, 126), { ratio: 0.26, status: "fail" }],
  [shape("warn", 100, 126), { ratio: 0.26, status: "warn" }],
  [shape("warn", 1000, 1300), { ratio: 0.3, status: "warn" }],
  [shape("fail", 200, 100), { ratio: -0.5, status: "ok" }],
];

test.each(verdicts)("judge(%p) yields %p", (signal, expected) => {
  expect(judge(signal)).toEqual({ ...signal, ...expected });
});

const passing: Report = {
  base: { ref: "origin/main", sha: "0123456789abcdef0123456789abcdef01234567" },
  head: { sha: "89abcdef0123456789abcdef0123456789abcdef" },
  runs: 10,
  commands: [
    ["node", "dist/cli.js", "sync", "--quiet"],
    ["node", "dist/cli.js", "add", "@example/repo", "--list", "--no-fetch"],
  ],
  signals: [
    {
      name: "sync --quiet",
      unit: "ms",
      gate: "fail",
      base: 40,
      head: 42.4,
      ratio: 0.06,
      status: "ok",
    },
    {
      name: "add --list",
      unit: "ms",
      gate: "warn",
      base: 80,
      head: 104,
      ratio: 0.3,
      status: "warn",
    },
    {
      name: "bundle size",
      unit: "bytes",
      gate: "fail",
      base: 1234567,
      head: 1200000,
      ratio: -0.028,
      status: "ok",
    },
  ],
};

const failing: Report = {
  base: {
    ref: "fedcba9876543210fedcba9876543210fedcba98",
    sha: "fedcba9876543210fedcba9876543210fedcba98",
  },
  head: { sha: "89abcdef0123456789abcdef0123456789abcdef" },
  runs: 3,
  commands: [["node", "dist/cli.js", "sync", "--quiet"]],
  signals: [
    {
      name: "sync --quiet",
      unit: "ms",
      gate: "fail",
      base: 40,
      head: 52,
      ratio: 0.3,
      status: "fail",
    },
    {
      name: "add --list",
      unit: "ms",
      gate: "warn",
      base: 80,
      head: 78,
      ratio: -0.025,
      status: "ok",
    },
    {
      name: "bundle size",
      unit: "bytes",
      gate: "fail",
      base: 1000,
      head: 1300,
      ratio: 0.3,
      status: "fail",
    },
  ],
};

const reports: [string, Report, boolean, string][] = [
  [
    "a passing report with a warning on the interactive path",
    passing,
    false,
    [
      "## Latency and bundle size",
      "",
      "Head `89abcde` against base `0123456` (`origin/main`): median of 10 cold starts each, both bundles built and timed on this runner.",
      "",
      "| signal | base | head | delta | status |",
      "|---|---|---|---|---|",
      "| sync --quiet | 40.0 ms | 42.4 ms | +6.0% | ok |",
      "| add --list | 80.0 ms | 104.0 ms | +30.0% | warn |",
      "| bundle size | 1,234,567 bytes | 1,200,000 bytes | -2.8% | ok |",
      "",
      "Verdict: pass. A regression past 25% fails the job on a signal marked fail; past 10% it warns.",
      "",
      "Commands timed: `node dist/cli.js sync --quiet`, `node dist/cli.js add @example/repo --list --no-fetch`.",
      "",
    ].join("\n"),
  ],
  [
    "a failing report naming every failed signal",
    failing,
    true,
    [
      "## Latency and bundle size",
      "",
      "Head `89abcde` against base `fedcba9` (`fedcba9876543210fedcba9876543210fedcba98`): median of 3 cold starts each, both bundles built and timed on this runner.",
      "",
      "| signal | base | head | delta | status |",
      "|---|---|---|---|---|",
      "| sync --quiet | 40.0 ms | 52.0 ms | +30.0% | FAIL |",
      "| add --list | 80.0 ms | 78.0 ms | -2.5% | ok |",
      "| bundle size | 1,000 bytes | 1,300 bytes | +30.0% | FAIL |",
      "",
      "Verdict: FAIL. sync --quiet regressed +30.0% (limit 25%); bundle size regressed +30.0% (limit 25%).",
      "",
      "Commands timed: `node dist/cli.js sync --quiet`.",
      "",
    ].join("\n"),
  ],
];

test.each(reports)(
  "%s renders the comment markdown and one JSON line",
  (_name, report, fails, markdown) => {
    expect(failed(report.signals)).toBe(fails);
    expect(renderMarkdown(report)).toBe(markdown);
    const json = renderJson(report);
    expect(json.endsWith("\n")).toBe(true);
    expect(json.slice(0, -1)).not.toContain("\n");
    expect(JSON.parse(json)).toEqual({ ...report, verdict: fails ? "fail" : "pass" });
  },
);

const usageErrors: [string[], string][] = [
  [[], "--base <ref> is required"],
  [["--base", "HEAD", "--runs", "0"], "--runs must be a positive integer, got 0"],
  [
    ["--base", "HEAD", "--out", "dist/bench"],
    `refusing to write measured data inside the repository: ${resolve(repoRoot, "dist/bench")}`,
  ],
];

test.each(usageErrors)(
  "bun scripts/bench_ci.ts %p is refused before anything is built",
  (args, message) => {
    const proc = Bun.spawnSync(["bun", "scripts/bench_ci.ts", ...args], {
      cwd: repoRoot,
      stdout: "pipe",
      stderr: "pipe",
    });
    expect(proc.exitCode).toBe(2);
    expect(proc.stdout.toString()).toBe("");
    expect(proc.stderr.toString()).toBe(
      `bench_ci: ${message}\nusage: bun scripts/bench_ci.ts --base <ref> [--runs N] [--out dir]\n`,
    );
  },
);
