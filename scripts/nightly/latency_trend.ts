// Records the cold starts of the bundle built from HEAD, then judges HEAD against the entry
// recorded a week ago by rebuilding that entry's sha and timing both bundles on tonight's runner.
// The history shows one unchanged sha spanning more than 60% across nights, so a figure another
// night's runner stored is history, never the other side of a ratio.
import { readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { z } from "zod";
import { jsonDocument } from "../../src/util/json.ts";
import { flattenIssues } from "../../src/util/zod-issues.ts";
import {
  type Bytes,
  build,
  buildBase,
  bundlePath,
  coldStarts,
  compare,
  renderComparison,
  type Sampler,
  TIMED_COMMANDS,
  TIMED_PATHS,
  verdict,
} from "../bench_ci.ts";
import { readPositiveNumber } from "../lib/figures.ts";
import { withScratchDir } from "../lib/scratch.ts";
import { captureOrThrow, runOrThrow } from "../lib/spawn.ts";
import type { Outcome } from "./report.ts";

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
// does not parse whole, is reported, since a half-read trend would record beside figures that
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

// Only the entry's sha enters the verdict, so the newest entry at least a week old is the code
// of a week ago whatever its runner measured.
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

const describe = (entry: Entry): string => `\`${entry.sha.slice(0, 7)}\` at ${entry.at}`;

export type Measurement = Pick<Entry, "sha" | "node" | "medianMs" | "bundleBytes">;
export type Measure = (scratch: string) => Promise<Measurement>;

// The base side of tonight's comparison: the baseline's bundle size, or why it has no bundle,
// and one cold start of either side's bundle.
export interface BaseSide {
  bytes: Bytes["base"];
  sample: Sampler;
}
export type MeasureBase = (scratch: string, baseline: Entry) => Promise<BaseSide>;

async function measureHead(scratch: string): Promise<Measurement> {
  const head = build(repoRoot, "head", scratch);
  const medianMs: Record<string, number> = {};
  for (const [index, timed] of TIMED_PATHS.entries()) {
    const json = join(scratch, `timing-${index}.json`);
    const bench = join(repoRoot, "scripts", "bench.ts");
    runOrThrow(
      "bun",
      [bench, "--runs", String(RUNS), "--json", json, "--", "node", head.bundle, ...timed.argv],
      repoRoot,
    );
    medianMs[timed.name] = readPositiveNumber(json, "medianMs");
  }
  return {
    sha: captureOrThrow("git", ["rev-parse", "HEAD"], { cwd: repoRoot }).trim(),
    node: captureOrThrow("node", ["--version"], { cwd: repoRoot }).trim(),
    medianMs,
    bundleBytes: head.bytes,
  };
}

function holdsCommit(sha: string): boolean {
  try {
    captureOrThrow("git", ["-C", repoRoot, "cat-file", "-e", `${sha}^{commit}`]);
    return true;
  } catch {
    return false;
  }
}

// actions/checkout leaves a one-commit clone, so a week-old sha is fetched when the clone lacks
// it. A baseline that cannot be built (a sha the remote no longer serves, a lockfile its
// toolchain no longer installs, a build script it predates) is reported as not comparable and
// HEAD is timed alone; the figures its night stored are never the fallback.
async function buildBaseSide(scratch: string, baseline: Entry): Promise<BaseSide> {
  const head = bundlePath(scratch, "head");
  try {
    if (!holdsCommit(baseline.sha))
      runOrThrow("git", ["-C", repoRoot, "fetch", "-q", "origin", baseline.sha], repoRoot);
    const base = buildBase(baseline.sha, scratch);
    return { bytes: base.bytes, sample: coldStarts({ head, base: base.bundle }) };
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    return {
      bytes: { notComparable: `building its bundle failed: ${reason}` },
      sample: coldStarts({ head }),
    };
  }
}

export type LatencyTrendOptions = {
  now?: Date;
  measure?: Measure;
  measureBase?: MeasureBase;
};

const TITLE = "Hook-path latency or bundle size regressed against 7 days ago";

export async function runLatencyTrend(
  trendPath: string,
  options: LatencyTrendOptions = {},
): Promise<Outcome> {
  const now = options.now ?? new Date();
  const measure = options.measure ?? measureHead;
  const measureBase = options.measureBase ?? buildBaseSide;
  const read = readTrend(trendPath);
  if (!read.ok) {
    const body = `${trendPath} did not parse as a trend file:\n\n\`\`\`text\n${read.issues.join("\n")}\n\`\`\`\n`;
    return {
      status: "fail",
      summary: `## Latency trend\n\n${body}`,
      report: { title: TITLE, body },
    };
  }
  const baseline = pickBaseline(read.trend.entries, now);
  const night = await withScratchDir("maxims-latency-trend-", async (scratch) => {
    const measurement = await measure(scratch);
    if (baseline === null) return { measurement, judged: null };
    const base = await measureBase(scratch, baseline);
    const report = await compare(
      {
        base: { ref: baseline.sha, sha: baseline.sha },
        head: { sha: measurement.sha },
        runs: RUNS,
        commands: TIMED_COMMANDS,
      },
      { head: measurement.bundleBytes, base: base.bytes },
      base.sample,
    );
    return { measurement, judged: { baseline, report } };
  });
  const current: Entry = { at: now.toISOString(), runs: RUNS, ...night.measurement };
  writeFileSync(trendPath, jsonDocument(appendEntry(read.trend, current)));
  if (night.judged === null) {
    const notice =
      `Recorded ${describe(current)}; no entry is ${BASELINE_AGE_DAYS} days old yet, ` +
      `so there is nothing to compare against.`;
    return { status: "pass", summary: `## Latency trend\n\n${notice}\n` };
  }
  const { report } = night.judged;
  const against =
    `Head \`${current.sha.slice(0, 7)}\` against the baseline ${describe(night.judged.baseline)}, ` +
    `the newest entry at least ${BASELINE_AGE_DAYS} days old`;
  const body = `${renderComparison(against, report)}\n`;
  const summary = `## Latency trend\n\n${body}`;
  if (verdict(report) !== "fail") return { status: "pass", summary };
  return { status: "fail", summary, report: { title: TITLE, body } };
}
