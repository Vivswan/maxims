// Fails if the verdict reads the baseline's stored figures instead of its bundle rebuilt and timed
// beside HEAD on tonight's runner: the night an unchanged hook path failed against a week-old
// figure from a faster runner. The rows also pin which sha gets rebuilt, the skip a baseline no
// toolchain can build turns into, and the entry each night records whatever the verdict.
import { describe, expect, test } from "bun:test";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  type Judged,
  type Measured,
  type Report,
  renderComparison,
  type Sampler,
  type Series,
  type SideName,
  TIMED_COMMANDS,
} from "../../scripts/bench_ci.ts";
import {
  type BaseSide,
  type Entry,
  type Measurement,
  readTrend,
  runLatencyTrend,
} from "../../scripts/nightly/latency_trend.ts";
import { WINDOWS } from "../shared/platform.ts";
import { withTempDir } from "../shared/temp_dir.ts";

const NOW = new Date("2026-09-21T06:41:00Z");
const daysAgo = (days: number): string =>
  new Date(NOW.getTime() - days * 24 * 60 * 60 * 1000).toISOString();

const entry = (days: number, sha: string, sync = 40, list = 80, bytes = 800_000): Entry => ({
  at: daysAgo(days),
  sha,
  node: "v22.23.2",
  runs: 10,
  medianMs: { "sync --quiet": sync, "add --list": list },
  bundleBytes: bytes,
});

const measurement = (sync: number, bytes: number): Measurement => ({
  sha: "0000000",
  node: "v22.23.2",
  medianMs: { "sync --quiet": sync, "add --list": 80 },
  bundleBytes: bytes,
});

type PathMs = [sync: number, list: number];

const steady =
  (ms: Record<SideName, PathMs>): Sampler =>
  (side, argv) =>
    ms[side][argv[0] === "sync" ? 0 : 1];

const headOnly =
  (ms: PathMs): Sampler =>
  (side, argv) => {
    if (side === "base") throw new Error("the base was timed");
    return ms[argv[0] === "sync" ? 0 : 1];
  };

const noBase: BaseSide = {
  bytes: { notComparable: "a base was measured where none was expected" },
  sample: () => {
    throw new Error("a base was measured where none was expected");
  },
};

const TITLE = "Hook-path latency or bundle size regressed against 7 days ago";

// Ten runs after one warm-up: the trimmed mean keeps six starts and drops two from each end.
const flat = (ms: number): Series => ({
  warmup: ms,
  kept: Array<number>(6).fill(ms),
  trimmed: Array<number>(4).fill(ms),
});

const judgedMs = (
  name: string,
  gate: Judged["gate"],
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

const judgedBytes = (
  base: number,
  head: number,
  ratio: number,
  status: Judged["status"],
): Judged => ({ name: "bundle size", unit: "bytes", gate: "fail", base, head, ratio, status });

const headMs = (name: string, head: number): Measured => ({
  name,
  unit: "ms",
  head,
  series: { head: flat(head) },
});

// What the trend hands compare: the baseline's sha on both base fields, HEAD's sha, the
// recorded run count, and the commands the PR gate times.
const frame = (baseline: Entry) => ({
  base: { ref: baseline.sha, sha: baseline.sha },
  head: { sha: "0000000" },
  runs: 10,
  commands: TIMED_COMMANDS,
});

const against = (baseline: Entry): string =>
  `Head \`0000000\` against the baseline \`${baseline.sha}\` at ${baseline.at}, the newest entry at least 7 days old`;

interface Night {
  name: string;
  history: Entry[];
  // The entry whose sha the night rebuilds.
  baseline: Entry;
  head: Measurement;
  base: BaseSide;
  report: Report;
  status: "pass" | "fail";
}

const regressed = entry(8, "8888888");
const warned = entry(9, "9999999", 40, 60);
// The stored figures sit far below what tonight's runner reads for either side.
const slowRunner = entry(7, "7777777", 50, 50);
const unbuildable = entry(8, "8888888");

const nights: Night[] = [
  {
    name: "a hook-path regression past the gate fails with both sides timed tonight",
    history: [entry(15, "1515151", 30), regressed, entry(1, "1111111", 52)],
    baseline: regressed,
    head: measurement(52, 1_000_000),
    base: { bytes: 800_000, sample: steady({ base: [40, 80], head: [52, 80] }) },
    report: {
      ...frame(regressed),
      signals: [
        judgedMs("sync --quiet", "fail", 40, 52, 0.3, "fail"),
        judgedMs("add --list", "warn", 80, 80, 0, "ok"),
        judgedBytes(800_000, 1_000_000, 0.25, "warn"),
      ],
    },
    status: "fail",
  },
  {
    name: "a warning on the interactive path passes",
    history: [warned],
    baseline: warned,
    head: measurement(40, 800_000),
    base: { bytes: 800_000, sample: steady({ base: [40, 60], head: [40, 80] }) },
    report: {
      ...frame(warned),
      signals: [
        judgedMs("sync --quiet", "fail", 40, 40, 0, "ok"),
        judgedMs("add --list", "warn", 60, 80, 0.333333, "warn"),
        judgedBytes(800_000, 800_000, 0, "ok"),
      ],
    },
    status: "pass",
  },
  {
    name: "both bundles slower tonight than the baseline's stored figures pass on tonight's ratio",
    history: [slowRunner],
    baseline: slowRunner,
    head: measurement(126, 800_000),
    base: { bytes: 800_000, sample: steady({ base: [120, 76], head: [126, 80] }) },
    report: {
      ...frame(slowRunner),
      signals: [
        judgedMs("sync --quiet", "fail", 120, 126, 0.05, "ok"),
        judgedMs("add --list", "warn", 76, 80, 0.052632, "ok"),
        judgedBytes(800_000, 800_000, 0, "ok"),
      ],
    },
    status: "pass",
  },
  {
    name: "a baseline that cannot be built records the night and compares nothing",
    history: [unbuildable],
    baseline: unbuildable,
    head: measurement(40, 800_000),
    base: {
      bytes: {
        notComparable:
          "building its bundle failed: base `8888888` has no scripts/build.ts to build",
      },
      sample: headOnly([40, 80]),
    },
    report: {
      ...frame(unbuildable),
      notComparable: "building its bundle failed: base `8888888` has no scripts/build.ts to build",
      signals: [
        headMs("sync --quiet", 40),
        headMs("add --list", 80),
        { name: "bundle size", unit: "bytes", head: 800_000 },
      ],
    },
    status: "pass",
  },
];

describe("runLatencyTrend", () => {
  test.each(nights)("$name", async (night) => {
    await withTempDir(async (dir) => {
      const trend = join(dir, "trend.json");
      writeFileSync(trend, JSON.stringify({ version: 1, entries: night.history }));
      const built: Entry[] = [];
      const outcome = await runLatencyTrend(trend, {
        now: NOW,
        measure: async () => night.head,
        measureBase: async (_scratch, baseline) => {
          built.push(baseline);
          return night.base;
        },
      });
      const body = `${renderComparison(against(night.baseline), night.report)}\n`;
      expect(outcome).toEqual(
        night.status === "pass"
          ? { status: "pass", summary: `## Latency trend\n\n${body}` }
          : {
              status: "fail",
              summary: `## Latency trend\n\n${body}`,
              report: { title: TITLE, body },
            },
      );
      expect(built).toEqual([night.baseline]);
      expect(readTrend(trend)).toEqual({
        ok: true,
        trend: {
          version: 1,
          entries: [
            ...[...night.history].sort((a, b) => Date.parse(a.at) - Date.parse(b.at)),
            { at: NOW.toISOString(), runs: 10, ...night.head },
          ],
        },
      });
    });
  });

  test("a first run records the entry and passes with a notice", async () => {
    await withTempDir(async (dir) => {
      const trend = join(dir, "trend.json");
      const outcome = await runLatencyTrend(trend, {
        now: NOW,
        measure: async () => measurement(40, 800_000),
        measureBase: async () => noBase,
      });
      expect(outcome).toEqual({
        status: "pass",
        summary:
          "## Latency trend\n\nRecorded `0000000` at 2026-09-21T06:41:00.000Z; no entry is 7 days old yet, " +
          "so there is nothing to compare against.\n",
      });
      expect(readTrend(trend)).toEqual({
        ok: true,
        trend: { version: 1, entries: [{ ...entry(0, "0000000"), at: NOW.toISOString() }] },
      });
    });
  });

  test("the file written keeps the newest 400 entries in time order, oldest dropped", async () => {
    await withTempDir(async (dir) => {
      const trend = join(dir, "trend.json");
      const days = Array.from({ length: 400 }, (_, i) => 400 - i);
      const shuffled = [...days.filter((d) => d % 2 === 1), ...days.filter((d) => d % 2 === 0)];
      const entries = shuffled.map((d) => entry(d, "abcdef0"));
      writeFileSync(trend, JSON.stringify({ version: 1, entries }));
      await runLatencyTrend(trend, {
        now: NOW,
        measure: async () => measurement(40, 800_000),
        measureBase: async () => ({
          bytes: 800_000,
          sample: steady({ base: [40, 80], head: [40, 80] }),
        }),
      });
      const written = readTrend(trend);
      const ats = written.ok ? written.trend.entries.map((e) => e.at) : [];
      const expected = [...days.slice(1).map(daysAgo), NOW.toISOString()];
      expect(ats).toEqual(expected);
    });
  });

  // Windows reports a path under a regular file as ENOENT, the same as an absent file, so the
  // first-run branch is taken there.
  test.skipIf(WINDOWS)("a trend path under a regular file fails before measuring", async () => {
    await withTempDir(async (dir) => {
      const file = join(dir, "not-a-dir");
      writeFileSync(file, "");
      let measured = false;
      const outcome = await runLatencyTrend(join(file, "trend.json"), {
        now: NOW,
        measure: async () => {
          measured = true;
          return measurement(40, 800_000);
        },
        measureBase: async () => noBase,
      });
      expect(measured).toBe(false);
      expect(outcome.status).toBe("fail");
      expect(outcome.status === "fail" ? outcome.report.body : "").toContain("ENOTDIR");
    });
  });

  const malformed: [string, string, string][] = [
    ["a file that is not JSON", "{", "JSON Parse error: Expected '}'"],
    [
      "a file of another version",
      '{"version":2,"entries":[]}',
      "version: Invalid input: expected 1",
    ],
    [
      "an entry missing its size",
      '{"version":1,"entries":[{"at":"2026-09-01T00:00:00Z","sha":"abcdef0","node":"v22","runs":10,"medianMs":{}}]}',
      "entries.0.bundleBytes: Invalid input: expected number, received undefined",
    ],
  ];

  test.each(malformed)(
    "%s fails with the parse issue and measures nothing",
    async (_name, text, issue) => {
      await withTempDir(async (dir) => {
        const trend = join(dir, "trend.json");
        writeFileSync(trend, text);
        let measured = false;
        const outcome = await runLatencyTrend(trend, {
          now: NOW,
          measure: async () => {
            measured = true;
            return measurement(40, 800_000);
          },
          measureBase: async () => noBase,
        });
        expect(measured).toBe(false);
        expect(outcome.status).toBe("fail");
        expect(outcome.status === "fail" ? outcome.report.body : "").toContain(issue);
        expect(readFileSync(trend, "utf8")).toBe(text);
      });
    },
  );
});
