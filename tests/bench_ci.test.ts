// Fails if the CI latency verdict drifts from the gates the architecture fixes: a regression past
// 25% on the hook path or the bundle must fail the job, the same regression on the interactive
// path must only warn, and exactly the threshold is not past it. Fails if a base that is no CLI (a
// version-only stub bundle, or one whose bench run dies) is judged instead of skipped: the first
// real bundle after a stub read a six-figure percentage on size and blocked the merge. Also fails
// if the report that becomes the PR comment changes shape or figures silently, or if measured data
// can be written inside the repository, where a commit would publish one machine's timings,
// including through a symlink or a /proc alias whose lexical path lies outside the checkout.
import { expect, test } from "bun:test";
import { mkdtempSync, realpathSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import {
  compare,
  type Judged,
  judge,
  MIN_COMPARABLE_BUNDLE_BYTES,
  type Report,
  renderJson,
  renderMarkdown,
  type Side,
  type Signal,
  verdict,
} from "../scripts/bench_ci.ts";

const repoRoot = resolve(import.meta.dir, "..");
const realRepoRoot = realpathSync.native(repoRoot);

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

const BASE_SHA = "abcdef0123456789abcdef0123456789abcdef01";
const HEAD_SHA = "89abcdef0123456789abcdef0123456789abcdef";
const COMMANDS = [
  ["node", "dist/cli.js", "sync", "--quiet"],
  ["node", "dist/cli.js", "add", "@example/repo", "--list", "--no-fetch"],
];
const frame = {
  base: { ref: "origin/main", sha: BASE_SHA },
  head: { sha: HEAD_SHA },
  runs: 10,
  commands: COMMANDS,
};

const timings =
  (syncMs: number, addMs: number): Side["medianMs"] =>
  (argv) =>
    argv[0] === "sync" ? syncMs : addMs;
const dies =
  (message: string): Side["medianMs"] =>
  () => {
    throw new Error(message);
  };
const realHead: Side = { bytes: 1200000, medianMs: timings(130, 210) };

const headOnly = (notComparable: string, head: Side, bundleBytes: number): Report => ({
  ...frame,
  notComparable,
  signals: [
    { name: "sync --quiet", unit: "ms", head: head.medianMs(["sync"], 0) },
    { name: "add --list", unit: "ms", head: head.medianMs(["add"], 1) },
    { name: "bundle size", unit: "bytes", head: bundleBytes },
  ],
});

// A base under the floor is never timed: its timing function dies, and the report must not carry
// that death as the reason. A base whose bench run dies is skipped for that reason, and the head
// is measured in full on both. The base at the floor is compared.
const comparisons: [string, Side, Side, Report, "pass" | "fail" | "skip"][] = [
  [
    "a version-only stub as base",
    { bytes: 160, medianMs: dies("the base was timed") },
    realHead,
    headOnly("its bundle is 160 bytes, under the 16,384-byte floor", realHead, 1200000),
    "skip",
  ],
  [
    "a base one byte under the floor",
    { bytes: MIN_COMPARABLE_BUNDLE_BYTES - 1, medianMs: dies("the base was timed") },
    realHead,
    headOnly("its bundle is 16,383 bytes, under the 16,384-byte floor", realHead, 1200000),
    "skip",
  ],
  [
    "a base whose bench run dies",
    { bytes: 1000000, medianMs: dies("node cli.js sync --quiet exited with code 1") },
    realHead,
    headOnly(
      "timing its bundle failed: node cli.js sync --quiet exited with code 1",
      realHead,
      1200000,
    ),
    "skip",
  ],
  [
    "a base at the floor",
    { bytes: MIN_COMPARABLE_BUNDLE_BYTES, medianMs: timings(100, 200) },
    { bytes: 20480, medianMs: timings(130, 210) },
    {
      ...frame,
      signals: [
        {
          name: "sync --quiet",
          unit: "ms",
          gate: "fail",
          base: 100,
          head: 130,
          ratio: 0.3,
          status: "fail",
        },
        {
          name: "add --list",
          unit: "ms",
          gate: "warn",
          base: 200,
          head: 210,
          ratio: 0.05,
          status: "ok",
        },
        {
          name: "bundle size",
          unit: "bytes",
          gate: "fail",
          base: 16384,
          head: 20480,
          ratio: 0.25,
          status: "warn",
        },
      ],
    },
    "fail",
  ],
  [
    "two real bundles",
    { bytes: 1250000, medianMs: timings(40, 80) },
    { bytes: 1200000, medianMs: timings(42.4, 104) },
    {
      ...frame,
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
          base: 1250000,
          head: 1200000,
          ratio: -0.04,
          status: "ok",
        },
      ],
    },
    "pass",
  ],
];

test.each(comparisons)("compare with %s", (_name, base, head, report, expected) => {
  const actual = compare(frame, base, head);
  expect(actual).toEqual(report);
  expect(verdict(actual)).toBe(expected);
});

// A head that cannot be timed is the run's own failure whatever the base is; only the base's
// timing is caught into a skip.
const headDies: [string, Side][] = [
  ["a version-only stub", { bytes: 160, medianMs: dies("the base was timed") }],
  ["a real bundle", { bytes: 1250000, medianMs: timings(40, 80) }],
];

test.each(headDies)("compare against %s propagates a head timing failure", (_name, base) => {
  const head: Side = {
    bytes: 1200000,
    medianMs: dies("node cli.js sync --quiet exited with code 1"),
  };
  expect(() => compare(frame, base, head)).toThrow("node cli.js sync --quiet exited with code 1");
});

const skipped: Report = headOnly(
  "its bundle is 160 bytes, under the 16,384-byte floor",
  realHead,
  1200000,
);

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

// The JSON line is pinned byte for byte: a parse-and-compare would let key order, whitespace, or a
// stray prefix drift under it.
const reports: [string, Report, "pass" | "fail" | "skip", string, string][] = [
  [
    "a passing report with a warning on the interactive path",
    passing,
    "pass",
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
    [
      '{"base":{"ref":"origin/main","sha":"0123456789abcdef0123456789abcdef01234567"},',
      '"head":{"sha":"89abcdef0123456789abcdef0123456789abcdef"},"runs":10,',
      '"commands":[["node","dist/cli.js","sync","--quiet"],',
      '["node","dist/cli.js","add","@example/repo","--list","--no-fetch"]],',
      '"signals":[',
      '{"name":"sync --quiet","unit":"ms","gate":"fail","base":40,"head":42.4,"ratio":0.06,"status":"ok"},',
      '{"name":"add --list","unit":"ms","gate":"warn","base":80,"head":104,"ratio":0.3,"status":"warn"},',
      '{"name":"bundle size","unit":"bytes","gate":"fail","base":1234567,"head":1200000,"ratio":-0.028,"status":"ok"}',
      '],"verdict":"pass"}\n',
    ].join(""),
  ],
  [
    "a failing report naming every failed signal",
    failing,
    "fail",
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
    [
      '{"base":{"ref":"fedcba9876543210fedcba9876543210fedcba98",',
      '"sha":"fedcba9876543210fedcba9876543210fedcba98"},',
      '"head":{"sha":"89abcdef0123456789abcdef0123456789abcdef"},"runs":3,',
      '"commands":[["node","dist/cli.js","sync","--quiet"]],',
      '"signals":[',
      '{"name":"sync --quiet","unit":"ms","gate":"fail","base":40,"head":52,"ratio":0.3,"status":"fail"},',
      '{"name":"add --list","unit":"ms","gate":"warn","base":80,"head":78,"ratio":-0.025,"status":"ok"},',
      '{"name":"bundle size","unit":"bytes","gate":"fail","base":1000,"head":1300,"ratio":0.3,"status":"fail"}',
      '],"verdict":"fail"}\n',
    ].join(""),
  ],
  [
    "a report whose base is a stub, with the head's figures and no deltas",
    skipped,
    "skip",
    [
      "## Latency and bundle size",
      "",
      "Head `89abcde` against base `abcdef0` (`origin/main`): median of 10 cold starts of the head, built and timed on this runner.",
      "",
      "| signal | base | head | delta | status |",
      "|---|---|---|---|---|",
      "| sync --quiet | n/a | 130.0 ms | n/a | skip |",
      "| add --list | n/a | 210.0 ms | n/a | skip |",
      "| bundle size | n/a | 1,200,000 bytes | n/a | skip |",
      "",
      "Verdict: skip. Base `abcdef0` is not comparable (its bundle is 160 bytes, under the 16,384-byte floor); deltas not judged.",
      "",
      "Commands timed: `node dist/cli.js sync --quiet`, `node dist/cli.js add @example/repo --list --no-fetch`.",
      "",
    ].join("\n"),
    [
      '{"base":{"ref":"origin/main","sha":"abcdef0123456789abcdef0123456789abcdef01"},',
      '"head":{"sha":"89abcdef0123456789abcdef0123456789abcdef"},"runs":10,',
      '"commands":[["node","dist/cli.js","sync","--quiet"],',
      '["node","dist/cli.js","add","@example/repo","--list","--no-fetch"]],',
      '"notComparable":"its bundle is 160 bytes, under the 16,384-byte floor",',
      '"signals":[',
      '{"name":"sync --quiet","unit":"ms","head":130},',
      '{"name":"add --list","unit":"ms","head":210},',
      '{"name":"bundle size","unit":"bytes","head":1200000}',
      '],"verdict":"skip"}\n',
    ].join(""),
  ],
];

test.each(reports)(
  "%s renders the comment markdown and one JSON line",
  (_name, report, expected, markdown, json) => {
    expect(verdict(report)).toBe(expected);
    expect(renderMarkdown(report)).toBe(markdown);
    expect(renderJson(report)).toBe(json);
  },
);

// A ref no repository holds. Argument checks run before the ref lookup, so a refusal that has
// regressed stops at the lookup with status 1 and a git error instead of building and timing
// both bundles and writing a report into the checkout.
const UNRESOLVED_BASE = "refs/heads/bench-ci-test-unresolved";

function runBenchCi(args: string[]) {
  return Bun.spawnSync(["bun", "scripts/bench_ci.ts", ...args], {
    cwd: repoRoot,
    stdout: "pipe",
    stderr: "pipe",
  });
}

function expectRefused(proc: ReturnType<typeof runBenchCi>, message: string): void {
  expect(proc.exitCode).toBe(2);
  expect(proc.stdout.toString()).toBe("");
  expect(proc.stderr.toString()).toBe(
    `bench_ci: ${message}\nusage: bun scripts/bench_ci.ts --base <ref> [--runs N] [--out dir]\n`,
  );
}

const usageErrors: [string[], string][] = [
  [[], "--base <ref> is required"],
  [["--base", UNRESOLVED_BASE, "--runs", "0"], "--runs must be a positive integer, got 0"],
];

test.each(usageErrors)(
  "bun scripts/bench_ci.ts %p is refused before anything is built",
  (args, message) => {
    expectRefused(runBenchCi(args), message);
  },
);

interface OutTarget {
  outArg: string;
  refusal: string;
}

const insideRepo = (dir: string): string =>
  `refusing to write measured data inside the repository: ${dir}`;

// Names carry the test's own temp-dir token so a directory another run left behind cannot
// collide. The harness runs with the repository as cwd, which is what makes the /proc alias
// point at it.
const outTargets: [string, (dir: string, token: string) => OutTarget][] = [
  [
    "a relative path inside the repository",
    (_dir, token) => ({
      outArg: join("dist", token),
      refusal: insideRepo(join(realRepoRoot, "dist", token)),
    }),
  ],
  [
    "a symlink in the temp dir pointing at the repository",
    (dir, token) => {
      symlinkSync(repoRoot, join(dir, "repo"));
      return { outArg: join(dir, "repo", token), refusal: insideRepo(join(realRepoRoot, token)) };
    },
  ],
  [
    "a dangling symlink in the temp dir pointing into the repository",
    (dir, token) => {
      const link = join(dir, "dangling");
      symlinkSync(join(realRepoRoot, token), link);
      return { outArg: link, refusal: `refusing to write through the dangling symlink ${link}` };
    },
  ],
  ...(process.platform === "linux"
    ? ([
        [
          "a /proc/self/cwd alias of the repository",
          (_dir, token) => ({
            outArg: join("/proc/self/cwd", token),
            refusal: insideRepo(join(realRepoRoot, token)),
          }),
        ],
      ] satisfies [string, (dir: string, token: string) => OutTarget][])
    : []),
];

test.each(outTargets)("--out with %s is refused by where the bytes would land", (_name, plan) => {
  const dir = mkdtempSync(join(tmpdir(), "maxims-bench-ci-"));
  try {
    const { outArg, refusal } = plan(dir, basename(dir));
    expectRefused(runBenchCi(["--base", UNRESOLVED_BASE, "--out", outArg]), refusal);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
