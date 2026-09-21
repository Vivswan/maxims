// Fails if the baseline pick compares today against yesterday instead of a week ago, so a slow
// creep never shows, or if a first run with no history fails for want of a baseline; also if a
// malformed or unreadable trend file crashes the run or measures anyway instead of failing with
// the issue, if the file written stops holding the newest 400 entries, if a timed path the
// baseline never saw is silently dropped, or if a regression past the gate stops failing.
import { describe, expect, test } from "bun:test";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
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

describe("runLatencyTrend", () => {
  test("a first run records the entry and passes with a notice", async () => {
    await withTempDir(async (dir) => {
      const trend = join(dir, "trend.json");
      const outcome = await runLatencyTrend(trend, {
        now: NOW,
        measure: async () => measurement(40, 800_000),
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

  test("a hook-path regression past the gate fails with both entries compared", async () => {
    await withTempDir(async (dir) => {
      const trend = join(dir, "trend.json");
      const history = { version: 1, entries: [entry(8, "8888888"), entry(1, "1111111", 52)] };
      writeFileSync(trend, JSON.stringify(history));
      const outcome = await runLatencyTrend(trend, {
        now: NOW,
        measure: async () => measurement(52, 800_000),
      });
      const body = [
        "Current `0000000` at 2026-09-21T06:41:00.000Z against the baseline `8888888` at " +
          `${daysAgo(8)}, the newest entry at least 7 days old; median of 10 cold starts.`,
        "",
        "| signal | baseline | current | delta | status |",
        "|---|---|---|---|---|",
        "| sync --quiet | 40.0 ms | 52.0 ms | +30.0% | FAIL |",
        "| add --list | 80.0 ms | 80.0 ms | +0.0% | ok |",
        "| bundle size | 800,000 bytes | 800,000 bytes | +0.0% | ok |",
        "",
        "A regression past 25% fails on a signal marked fail; past 10% it warns.",
        "",
      ].join("\n");
      expect(outcome).toEqual({
        status: "fail",
        summary: `## Latency trend\n\n${body}`,
        report: { title: "Hook-path latency or bundle size regressed against 7 days ago", body },
      });
      expect(readTrend(trend)).toEqual({
        ok: true,
        trend: {
          version: 1,
          entries: [...history.entries, { ...entry(0, "0000000", 52), at: NOW.toISOString() }],
        },
      });
    });
  });

  test("a warning on the interactive path passes", async () => {
    await withTempDir(async (dir) => {
      const trend = join(dir, "trend.json");
      writeFileSync(trend, JSON.stringify({ version: 1, entries: [entry(9, "9999999", 40, 60)] }));
      const outcome = await runLatencyTrend(trend, {
        now: NOW,
        measure: async () => measurement(40, 800_000),
      });
      expect(outcome.status).toBe("pass");
      expect(outcome.summary).toContain("| add --list | 60.0 ms | 80.0 ms | +33.3% | warn |");
    });
  });

  test("the file written keeps the newest 400 entries in time order, oldest dropped", async () => {
    await withTempDir(async (dir) => {
      const trend = join(dir, "trend.json");
      const days = Array.from({ length: 400 }, (_, i) => 400 - i);
      const shuffled = [...days.filter((d) => d % 2 === 1), ...days.filter((d) => d % 2 === 0)];
      const entries = shuffled.map((d) => entry(d, "abcdef0"));
      writeFileSync(trend, JSON.stringify({ version: 1, entries }));
      await runLatencyTrend(trend, { now: NOW, measure: async () => measurement(40, 800_000) });
      const written = readTrend(trend);
      const ats = written.ok ? written.trend.entries.map((e) => e.at) : [];
      const expected = [...days.slice(1).map(daysAgo), NOW.toISOString()];
      expect(ats).toEqual(expected);
    });
  });

  test("a timed path the baseline never recorded is named, not judged", async () => {
    await withTempDir(async (dir) => {
      const trend = join(dir, "trend.json");
      const old: Entry = { ...entry(7, "7777777"), medianMs: { "sync --quiet": 40 } };
      writeFileSync(trend, JSON.stringify({ version: 1, entries: [old] }));
      const outcome = await runLatencyTrend(trend, {
        now: NOW,
        measure: async () => measurement(40, 800_000),
      });
      expect(outcome.status).toBe("pass");
      expect(outcome.summary).toContain("| sync --quiet | 40.0 ms | 40.0 ms | +0.0% | ok |");
      expect(outcome.summary).not.toContain("| add --list |");
      expect(outcome.summary).toContain("Not in the baseline, so not judged: add --list.");
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
        });
        expect(measured).toBe(false);
        expect(outcome.status).toBe("fail");
        expect(outcome.status === "fail" ? outcome.report.body : "").toContain(issue);
        expect(readFileSync(trend, "utf8")).toBe(text);
      });
    },
  );
});
