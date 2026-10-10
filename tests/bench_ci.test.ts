// Fails if the CI latency verdict drifts from the gates the architecture fixes: a regression past
// 25% on the hook path or the bundle must fail the job, the same regression on the interactive
// path must only warn, and exactly the threshold is not past it. Fails if the gate goes back to
// timing one side whole before the other, which blocked three merges of unchanged bundles. Fails
// if a base that is no CLI (a stub bundle, or one whose cold start dies) is judged instead of
// skipped: the first real bundle after a stub read a six-figure percentage on size. Also fails if
// the report that becomes the PR comment changes shape or figures silently, or if measured data
// can be written inside the repository, including through a symlink or a /proc alias.
import { expect, test } from "bun:test";
import { realpathSync, symlinkSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { summarize } from "../scripts/bench.ts";
import {
  compare,
  type Judged,
  judge,
  MIN_COMPARABLE_BUNDLE_BYTES,
  type Report,
  renderJson,
  renderMarkdown,
  type Sampler,
  type Series,
  type SideName,
  type Signal,
  verdict,
} from "../scripts/bench_ci.ts";
import { withTempDir } from "./shared/temp_dir.ts";

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
  runs: 5,
  commands: COMMANDS,
};

type PathMs = [sync: number, add: number];

// A runner with no noise at all: every cold start of a path takes the same time on a side.
const steady =
  (ms: Record<SideName, PathMs>): Sampler =>
  (side, argv) =>
    ms[side][argv[0] === "sync" ? 0 : 1];
const baseDies =
  (message: string, head: PathMs): Sampler =>
  (side, argv) => {
    if (side === "base") throw new Error(message);
    return head[argv[0] === "sync" ? 0 : 1];
  };
// Five runs trim one start from each end.
const flat = (ms: number): Series => ({ warmup: ms, kept: [ms, ms, ms], trimmed: [ms, ms] });

const headOnly = (notComparable: string, head: PathMs, bundleBytes: number): Report => ({
  ...frame,
  notComparable,
  signals: [
    { name: "sync --quiet", unit: "ms", head: head[0], series: { head: flat(head[0]) } },
    { name: "add --list", unit: "ms", head: head[1], series: { head: flat(head[1]) } },
    { name: "bundle size", unit: "bytes", head: bundleBytes },
  ],
});

const judgedMs = (
  name: string,
  gate: Signal["gate"],
  base: number,
  head: number,
  ratio: number,
  status: Judged["status"],
): Judged => ({
  name,
  unit: "ms",
  gate,
  base,
  head,
  series: { base: flat(base), head: flat(head) },
  ratio,
  status,
});

// A base under the floor is never timed: its cold start dies, and the report must not carry that
// death as the reason. A base whose cold start dies is skipped for that reason, and the head is
// measured in full on both. The base at the floor is compared.
const comparisons: [string, Record<SideName, number>, Sampler, Report, "pass" | "fail" | "skip"][] =
  [
    [
      "a version-only stub as base",
      { base: 160, head: 1200000 },
      baseDies("the base was timed", [130, 210]),
      headOnly("its bundle is 160 bytes, under the 16,384-byte floor", [130, 210], 1200000),
      "skip",
    ],
    [
      "a base one byte under the floor",
      { base: MIN_COMPARABLE_BUNDLE_BYTES - 1, head: 1200000 },
      baseDies("the base was timed", [130, 210]),
      headOnly("its bundle is 16,383 bytes, under the 16,384-byte floor", [130, 210], 1200000),
      "skip",
    ],
    [
      "a base whose cold start dies",
      { base: 1000000, head: 1200000 },
      baseDies("node cli.js sync --quiet exited with code 1", [130, 210]),
      headOnly(
        "timing its bundle failed: node cli.js sync --quiet exited with code 1",
        [130, 210],
        1200000,
      ),
      "skip",
    ],
    [
      "a base at the floor",
      { base: MIN_COMPARABLE_BUNDLE_BYTES, head: 20480 },
      steady({ base: [100, 200], head: [130, 210] }),
      {
        ...frame,
        signals: [
          judgedMs("sync --quiet", "fail", 100, 130, 0.3, "fail"),
          judgedMs("add --list", "warn", 200, 210, 0.05, "ok"),
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
      { base: 1250000, head: 1200000 },
      steady({ base: [40, 80], head: [42.4, 104] }),
      {
        ...frame,
        signals: [
          judgedMs("sync --quiet", "fail", 40, 42.4, 0.06, "ok"),
          judgedMs("add --list", "warn", 80, 104, 0.3, "warn"),
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

test.each(comparisons)("compare with %s", async (_name, bytes, sample, report, expected) => {
  const actual = await compare(frame, bytes, sample);
  expect(actual).toEqual(report);
  expect(verdict(actual)).toBe(expected);
});

// A head that cannot be timed is the run's own failure whatever the base is; only the base's
// cold start is caught into a skip.
const headDies: [string, Record<SideName, number>][] = [
  ["a version-only stub", { base: 160, head: 1200000 }],
  ["a real bundle", { base: 1250000, head: 1200000 }],
];

test.each(headDies)("compare against %s propagates a head timing failure", async (_name, bytes) => {
  const sample: Sampler = (side) => {
    if (side === "head") throw new Error("node cli.js sync --quiet exited with code 1");
    return 40;
  };
  await expect(compare(frame, bytes, sample)).rejects.toThrow(
    "node cli.js sync --quiet exited with code 1",
  );
});

interface FalseFailure {
  name: string;
  // Milliseconds per cold start of the hook path, in the order the starts would run: the ten the
  // head took first, then the ten the base took, then two more of the settled runner.
  profile: number[];
  // The figures the turn-about schedule and the trimmed mean read off the same profile.
  trimmedMean: Record<SideName, number>;
}

// Hand-written profiles shaped after the three merges this gate blocked on unchanged bundles: each
// matches the rounded median, min, and max the job printed, nothing finer. The same bytes on both
// sides make a profile the runner's drift alone.
const falseFailures: FalseFailure[] = [
  {
    name: "a head read at 173 ms over a base at 99",
    trimmedMean: { base: 108.167, head: 100.167 },
    profile: [
      603, 300, 230, 190, 176, 170, 150, 104, 101, 99, 99, 98, 100, 97, 99, 101, 98, 100, 99, 99,
      100, 98,
    ],
  },
  {
    name: "a head read at 100 ms over a base at 73",
    trimmedMean: { base: 76.667, head: 74.667 },
    profile: [
      443, 200, 130, 110, 102, 98, 90, 80, 75, 74, 73, 74, 72, 73, 75, 73, 72, 74, 73, 73, 74, 73,
    ],
  },
  {
    name: "a head read at 129 ms over a base at 77",
    trimmedMean: { base: 84.667, head: 81.5 },
    profile: [
      484, 250, 180, 150, 132, 126, 110, 95, 88, 85, 77, 76, 78, 77, 75, 79, 77, 76, 78, 77, 77, 76,
    ],
  },
];

// The runner replayed under another schedule: the starts are handed out in profile order to
// whichever side asks, one cursor per timed path. `headCost` scales the head's starts for a
// bundle that is slower in truth.
function replay(profile: number[], headCost: number): Sampler {
  const cursors = new Map<string, number>();
  return (side, argv) => {
    const at = cursors.get(argv[0]) ?? 0;
    cursors.set(argv[0], at + 1);
    const ms = profile[at];
    if (ms === undefined) throw new Error(`the profile has no start ${at}`);
    return side === "head" ? ms * headCost : ms;
  };
}

const sameBundles = { base: 1352745, head: 1352745 };
const tenRuns = { ...frame, runs: 10 };

const hookPath = (report: Report): Judged => {
  if ("notComparable" in report) throw new Error(report.notComparable);
  const signal = report.signals.find((s) => s.name === "sync --quiet");
  if (signal === undefined) throw new Error("the hook path was not judged");
  return signal;
};

test.each(falseFailures)(
  "$name: the median of the head's series, timed whole before the base's, failed the gate",
  ({ profile }) => {
    const head = summarize(profile.slice(0, 10)).medianMs;
    const base = summarize(profile.slice(10, 20)).medianMs;
    const judged = judge({ name: "sync --quiet", unit: "ms", gate: "fail", base, head });
    expect(judged.status).toBe("fail");
    expect(judged.ratio).toBeGreaterThan(0.25);
  },
);

test.each(falseFailures)(
  "$name: the same runner, timed turn about and judged on the trimmed mean, passes",
  async ({ profile, trimmedMean }) => {
    const report = await compare(tenRuns, sameBundles, replay(profile, 1));
    const signal = hookPath(report);
    expect(signal.status).toBe("ok");
    expect(signal.base).toBe(trimmedMean.base);
    expect(signal.head).toBe(trimmedMean.head);
    expect(signal.series?.base.warmup).toBe(profile[0]);
    expect(signal.series?.head.warmup).toBe(profile[1]);
    expect(verdict(report)).toBe("pass");
  },
);

test.each(falseFailures)(
  "$name: a head 40% slower in truth still fails under the same runner",
  async ({ profile }) => {
    const report = await compare(tenRuns, sameBundles, replay(profile, 1.4));
    const signal = hookPath(report);
    expect(signal.status).toBe("fail");
    expect(signal.ratio).toBeGreaterThan(0.25);
    expect(verdict(report)).toBe("fail");
  },
);

const skipped: Report = headOnly(
  "its bundle is 160 bytes, under the 16,384-byte floor",
  [130, 210],
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
      series: {
        base: { warmup: 95.5, kept: [39, 39.5, 40, 40, 40.5, 41], trimmed: [37, 38.5, 44, 120] },
        head: { warmup: 90, kept: [41, 42, 42.4, 42.5, 43, 43.5], trimmed: [40, 40.5, 45, 46] },
      },
      ratio: 0.06,
      status: "ok",
    },
    {
      name: "add --list",
      unit: "ms",
      gate: "warn",
      base: 80,
      head: 104,
      series: {
        base: { warmup: 150, kept: [78, 79, 80, 80, 81, 82], trimmed: [70, 77, 83, 99] },
        head: { warmup: 160, kept: [102, 103, 104, 104, 105, 106], trimmed: [99, 101, 107, 130] },
      },
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

// Three runs trim nothing.
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
      series: {
        base: { warmup: 60, kept: [39, 40, 41], trimmed: [] },
        head: { warmup: 70, kept: [51, 52, 53], trimmed: [] },
      },
      ratio: 0.3,
      status: "fail",
    },
    {
      name: "add --list",
      unit: "ms",
      gate: "warn",
      base: 80,
      head: 78,
      series: {
        base: { warmup: 100, kept: [79, 80, 81], trimmed: [] },
        head: { warmup: 99, kept: [77, 78, 79], trimmed: [] },
      },
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
      "Head `89abcde` against base `0123456` (`origin/main`): 20% trimmed mean of 10 cold starts each, the two bundles built on this runner and timed turn about.",
      "",
      "| signal | base | head | delta | status |",
      "|---|---|---|---|---|",
      "| sync --quiet | 40.0 ms | 42.4 ms | +6.0% | ok |",
      "| add --list | 80.0 ms | 104.0 ms | +30.0% | warn |",
      "| bundle size | 1,234,567 bytes | 1,200,000 bytes | -2.8% | ok |",
      "",
      "Verdict: pass. A regression past 25% fails the job on a signal marked fail; past 10% it warns.",
      "",
      "Cold starts in ms, sorted; the judged figure is the mean of the kept column, after one untimed warm-up.",
      "",
      "| signal | side | kept | trimmed | warm-up |",
      "|---|---|---|---|---|",
      "| sync --quiet | base | 39.0 39.5 40.0 40.0 40.5 41.0 | 37.0 38.5 44.0 120.0 | 95.5 |",
      "| sync --quiet | head | 41.0 42.0 42.4 42.5 43.0 43.5 | 40.0 40.5 45.0 46.0 | 90.0 |",
      "| add --list | base | 78.0 79.0 80.0 80.0 81.0 82.0 | 70.0 77.0 83.0 99.0 | 150.0 |",
      "| add --list | head | 102.0 103.0 104.0 104.0 105.0 106.0 | 99.0 101.0 107.0 130.0 | 160.0 |",
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
      '{"name":"sync --quiet","unit":"ms","gate":"fail","base":40,"head":42.4,',
      '"series":{"base":{"warmup":95.5,"kept":[39,39.5,40,40,40.5,41],"trimmed":[37,38.5,44,120]},',
      '"head":{"warmup":90,"kept":[41,42,42.4,42.5,43,43.5],"trimmed":[40,40.5,45,46]}},',
      '"ratio":0.06,"status":"ok"},',
      '{"name":"add --list","unit":"ms","gate":"warn","base":80,"head":104,',
      '"series":{"base":{"warmup":150,"kept":[78,79,80,80,81,82],"trimmed":[70,77,83,99]},',
      '"head":{"warmup":160,"kept":[102,103,104,104,105,106],"trimmed":[99,101,107,130]}},',
      '"ratio":0.3,"status":"warn"},',
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
      "Head `89abcde` against base `fedcba9` (`fedcba9876543210fedcba9876543210fedcba98`): 20% trimmed mean of 3 cold starts each, the two bundles built on this runner and timed turn about.",
      "",
      "| signal | base | head | delta | status |",
      "|---|---|---|---|---|",
      "| sync --quiet | 40.0 ms | 52.0 ms | +30.0% | FAIL |",
      "| add --list | 80.0 ms | 78.0 ms | -2.5% | ok |",
      "| bundle size | 1,000 bytes | 1,300 bytes | +30.0% | FAIL |",
      "",
      "Verdict: FAIL. sync --quiet regressed +30.0% (limit 25%); bundle size regressed +30.0% (limit 25%).",
      "",
      "Cold starts in ms, sorted; the judged figure is the mean of the kept column, after one untimed warm-up.",
      "",
      "| signal | side | kept | trimmed | warm-up |",
      "|---|---|---|---|---|",
      "| sync --quiet | base | 39.0 40.0 41.0 |  | 60.0 |",
      "| sync --quiet | head | 51.0 52.0 53.0 |  | 70.0 |",
      "| add --list | base | 79.0 80.0 81.0 |  | 100.0 |",
      "| add --list | head | 77.0 78.0 79.0 |  | 99.0 |",
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
      '{"name":"sync --quiet","unit":"ms","gate":"fail","base":40,"head":52,',
      '"series":{"base":{"warmup":60,"kept":[39,40,41],"trimmed":[]},',
      '"head":{"warmup":70,"kept":[51,52,53],"trimmed":[]}},',
      '"ratio":0.3,"status":"fail"},',
      '{"name":"add --list","unit":"ms","gate":"warn","base":80,"head":78,',
      '"series":{"base":{"warmup":100,"kept":[79,80,81],"trimmed":[]},',
      '"head":{"warmup":99,"kept":[77,78,79],"trimmed":[]}},',
      '"ratio":-0.025,"status":"ok"},',
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
      "Head `89abcde` against base `abcdef0` (`origin/main`): 20% trimmed mean of 5 cold starts of the head, built and timed on this runner.",
      "",
      "| signal | base | head | delta | status |",
      "|---|---|---|---|---|",
      "| sync --quiet | n/a | 130.0 ms | n/a | skip |",
      "| add --list | n/a | 210.0 ms | n/a | skip |",
      "| bundle size | n/a | 1,200,000 bytes | n/a | skip |",
      "",
      "Verdict: skip. Base `abcdef0` is not comparable (its bundle is 160 bytes, under the 16,384-byte floor); deltas not judged.",
      "",
      "Cold starts in ms, sorted; the judged figure is the mean of the kept column, after one untimed warm-up.",
      "",
      "| signal | side | kept | trimmed | warm-up |",
      "|---|---|---|---|---|",
      "| sync --quiet | head | 130.0 130.0 130.0 | 130.0 130.0 | 130.0 |",
      "| add --list | head | 210.0 210.0 210.0 | 210.0 210.0 | 210.0 |",
      "",
      "Commands timed: `node dist/cli.js sync --quiet`, `node dist/cli.js add @example/repo --list --no-fetch`.",
      "",
    ].join("\n"),
    [
      '{"base":{"ref":"origin/main","sha":"abcdef0123456789abcdef0123456789abcdef01"},',
      '"head":{"sha":"89abcdef0123456789abcdef0123456789abcdef"},"runs":5,',
      '"commands":[["node","dist/cli.js","sync","--quiet"],',
      '["node","dist/cli.js","add","@example/repo","--list","--no-fetch"]],',
      '"notComparable":"its bundle is 160 bytes, under the 16,384-byte floor",',
      '"signals":[',
      '{"name":"sync --quiet","unit":"ms","head":130,"series":{"head":{"warmup":130,"kept":[130,130,130],"trimmed":[130,130]}}},',
      '{"name":"add --list","unit":"ms","head":210,"series":{"head":{"warmup":210,"kept":[210,210,210],"trimmed":[210,210]}}},',
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

test.each(outTargets)(
  "--out with %s is refused by where the bytes would land",
  async (_name, plan) => {
    await withTempDir((dir) => {
      const { outArg, refusal } = plan(dir, basename(dir));
      expectRefused(runBenchCi(["--base", UNRESOLVED_BASE, "--out", outArg]), refusal);
    });
  },
);
