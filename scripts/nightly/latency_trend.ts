// Times the hook path and the interactive path of the bundle built from HEAD and compares them,
// with the bundle size, against the entry recorded a week ago; day-to-day noise on a shared runner
// hides a slow creep that a week-old baseline shows.
import { readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { z } from "zod";
import { flattenIssues } from "../../src/util/zod-issues.ts";
import { FAIL_RATIO, type Judged, judge, TIMED_PATHS, WARN_RATIO } from "../bench_ci.ts";
import { markdownTable, type Outcome } from "./report.ts";
import { withScratchDir } from "./scratch.ts";

const repoRoot = resolve(import.meta.dir, "..", "..");
export const MAX_ENTRIES = 400;
export const BASELINE_AGE_DAYS = 7;
export const RUNS = 10;
const DAY_MS = 24 * 60 * 60 * 1000;

const Entry = z.strictObject({
  at: z.iso.datetime(),
  sha: z.string().regex(/^[0-9a-f]{7,40}$/),
  node: z.string().min(1),
  runs: z.number().int().positive(),
  medianMs: z.record(z.string(), z.number().positive()),
  bundleBytes: z.number().int().positive(),
});
const Trend = z.strictObject({ version: z.literal(1), entries: z.array(Entry) });

export type Entry = z.infer<typeof Entry>;
export type Trend = z.infer<typeof Trend>;

export type ReadTrend = { ok: true; trend: Trend } | { ok: false; issues: string[] };

// Only a file that does not exist is the first run; any other read failure, and anything that
// does not parse whole, is reported, since a half-read trend would compare against figures that
// never were.
export function readTrend(path: string): ReadTrend {
  let json: unknown;
  try {
    json = JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT")
      return { ok: true, trend: { version: 1, entries: [] } };
    return { ok: false, issues: [error instanceof Error ? error.message : String(error)] };
  }
  const parsed = Trend.safeParse(json);
  if (parsed.success) return { ok: true, trend: parsed.data };
  return { ok: false, issues: flattenIssues(parsed.error.issues) };
}

export function pickBaseline(entries: readonly Entry[], now: Date): Entry | null {
  const cutoff = now.getTime() - BASELINE_AGE_DAYS * DAY_MS;
  let baseline: Entry | null = null;
  for (const entry of entries) {
    const at = Date.parse(entry.at);
    if (at > cutoff) continue;
    if (baseline === null || at > Date.parse(baseline.at)) baseline = entry;
  }
  return baseline;
}

export function appendEntry(trend: Trend, entry: Entry): Trend {
  const entries = [...trend.entries, entry].sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
  return { version: 1, entries: entries.slice(Math.max(0, entries.length - MAX_ENTRIES)) };
}

export type TrendJudgement = { signals: Judged[]; unmatched: string[] };

// A timed path the baseline never recorded has nothing to compare against; it is named rather
// than judged so a renamed path cannot pass by vanishing.
export function judgeTrend(baseline: Entry, current: Entry): TrendJudgement {
  const signals: Judged[] = [];
  const unmatched: string[] = [];
  for (const timed of TIMED_PATHS) {
    const base = baseline.medianMs[timed.name];
    const head = current.medianMs[timed.name];
    if (base === undefined || head === undefined) {
      unmatched.push(timed.name);
      continue;
    }
    signals.push(judge({ name: timed.name, unit: "ms", gate: timed.gate, base, head }));
  }
  signals.push(
    judge({
      name: "bundle size",
      unit: "bytes",
      gate: "fail",
      base: baseline.bundleBytes,
      head: current.bundleBytes,
    }),
  );
  return { signals, unmatched };
}

const percent = (ratio: number): string =>
  `${ratio * 100 >= 0 ? "+" : ""}${(ratio * 100).toFixed(1)}%`;
const quantity = (value: number, unit: Judged["unit"]): string =>
  unit === "ms" ? `${value.toFixed(1)} ms` : `${value.toLocaleString("en-US")} bytes`;
const describe = (entry: Entry): string => `\`${entry.sha.slice(0, 7)}\` at ${entry.at}`;

export function renderComparison(baseline: Entry, current: Entry, judged: TrendJudgement): string {
  const table = markdownTable(
    ["signal", "baseline", "current", "delta", "status"],
    judged.signals.map((s) => [
      s.name,
      quantity(s.base, s.unit),
      quantity(s.head, s.unit),
      percent(s.ratio),
      s.status === "fail" ? "FAIL" : s.status,
    ]),
  );
  const lines = [
    `Current ${describe(current)} against the baseline ${describe(baseline)}, ` +
      `the newest entry at least ${BASELINE_AGE_DAYS} days old; median of ${current.runs} cold starts.`,
    "",
    table,
  ];
  if (judged.unmatched.length > 0) {
    lines.push("", `Not in the baseline, so not judged: ${judged.unmatched.join(", ")}.`);
  }
  lines.push(
    "",
    `A regression past ${FAIL_RATIO * 100}% fails on a signal marked fail; past ${WARN_RATIO * 100}% it warns.`,
  );
  return lines.join("\n");
}

export type Measurement = Pick<Entry, "sha" | "node" | "medianMs" | "bundleBytes">;
export type Measure = (scratch: string) => Promise<Measurement>;

function run(command: string[], cwd: string): void {
  const proc = Bun.spawnSync(command, {
    cwd,
    stdin: "ignore",
    stdout: "inherit",
    stderr: "inherit",
  });
  if (proc.exitCode !== 0) throw new Error(`${command.join(" ")} exited with ${proc.exitCode}`);
}

function capture(command: string[]): string {
  const proc = Bun.spawnSync(command, {
    cwd: repoRoot,
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  if (proc.exitCode !== 0)
    throw new Error(`${command.join(" ")} failed: ${proc.stderr.toString().trim()}`);
  return proc.stdout.toString().trim();
}

// Both producers write one flat JSON object; a missing or non-positive figure means the producer
// changed shape or measured nothing, and would otherwise flow into a delta as NaN.
function readPositiveNumber(path: string, key: string): number {
  const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
  if (typeof parsed === "object" && parsed !== null && key in parsed) {
    const value: unknown = Reflect.get(parsed, key);
    if (typeof value === "number" && Number.isFinite(value) && value > 0) return value;
  }
  throw new Error(`${path} has no positive number at ${key}`);
}

async function measureHead(scratch: string): Promise<Measurement> {
  const bundle = join(scratch, "cli.js");
  const sizeJson = join(scratch, "size.json");
  run(
    ["bun", join(repoRoot, "scripts", "build.ts"), "--outfile", bundle, "--size-json", sizeJson],
    repoRoot,
  );
  const medianMs: Record<string, number> = {};
  for (const [index, timed] of TIMED_PATHS.entries()) {
    const json = join(scratch, `timing-${index}.json`);
    const bench = join(repoRoot, "scripts", "bench.ts");
    run(
      ["bun", bench, "--runs", String(RUNS), "--json", json, "--", "node", bundle, ...timed.argv],
      repoRoot,
    );
    medianMs[timed.name] = readPositiveNumber(json, "medianMs");
  }
  return {
    sha: capture(["git", "-C", repoRoot, "rev-parse", "HEAD"]),
    node: capture(["node", "--version"]),
    medianMs,
    bundleBytes: readPositiveNumber(sizeJson, "bytes"),
  };
}

export type LatencyTrendOptions = {
  now?: Date;
  measure?: Measure;
};

const TITLE = "Hook-path latency or bundle size regressed against 7 days ago";

export async function runLatencyTrend(
  trendPath: string,
  options: LatencyTrendOptions = {},
): Promise<Outcome> {
  const now = options.now ?? new Date();
  const measure = options.measure ?? measureHead;
  const read = readTrend(trendPath);
  if (!read.ok) {
    const body = `${trendPath} did not parse as a trend file:\n\n\`\`\`text\n${read.issues.join("\n")}\n\`\`\`\n`;
    return {
      status: "fail",
      summary: `## Latency trend\n\n${body}`,
      report: { title: TITLE, body },
    };
  }
  const measured = await withScratchDir("maxims-latency-trend-", measure);
  const current: Entry = { at: now.toISOString(), runs: RUNS, ...measured };
  const baseline = pickBaseline(read.trend.entries, now);
  writeFileSync(trendPath, `${JSON.stringify(appendEntry(read.trend, current), null, 2)}\n`);
  if (baseline === null) {
    const notice =
      `Recorded ${describe(current)}; no entry is ${BASELINE_AGE_DAYS} days old yet, ` +
      `so there is nothing to compare against.`;
    return { status: "pass", summary: `## Latency trend\n\n${notice}\n` };
  }
  const judged = judgeTrend(baseline, current);
  const body = `${renderComparison(baseline, current, judged)}\n`;
  const summary = `## Latency trend\n\n${body}`;
  if (judged.signals.every((s) => s.status !== "fail")) return { status: "pass", summary };
  return { status: "fail", summary, report: { title: TITLE, body } };
}
