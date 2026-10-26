// Builds and times HEAD and the base ref on the same machine in one run, so the figures compare
// two bundles under the same noise instead of one bundle against a budget written for other
// hardware. The base is built from its own scripts/build.ts; the timing harness is HEAD's. The
// nightly trend (scripts/nightly/latency_trend.ts) judges through the same compare, with the
// week-old entry's sha as its base.
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { parseArgv, positiveInteger } from "./lib/argv.ts";
import { exitDescription, timeColdStart } from "./lib/cold_start.ts";
import { percent, quantity, readPositiveNumber, type Unit } from "./lib/figures.ts";
import { markdownTable } from "./lib/markdown_table.ts";
import { outsideCheckouts } from "./lib/paths.ts";
import { withScratchDir } from "./lib/scratch.ts";
import { captureOrThrow, runOrThrow } from "./lib/spawn.ts";

const USAGE = "usage: bun scripts/bench_ci.ts --base <ref> [--runs N] [--out dir]\n";
const repoRoot = resolve(import.meta.dir, "..");

export const WARN_RATIO = 0.1;
export const FAIL_RATIO = 0.25;
export const TRIM_RATIO = 0.2;
export const MIN_COMPARABLE_BUNDLE_BYTES = 16 * 1024;

// What a gross regression does to the job. The hook path and the artifact gate the merge; the
// interactive path only reports, since it is allowed to cost more.
export type Gate = "fail" | "warn";
export type Status = "ok" | "warn" | "fail";

export type SideName = "base" | "head";

// One side's cold starts of one timed path, in milliseconds. The first start is the untimed
// warm-up; `kept` and `trimmed` are sorted, and the judged figure is the mean of `kept`.
export interface Series {
  warmup: number;
  kept: number[];
  trimmed: number[];
}

export interface Measured {
  name: string;
  unit: Unit;
  head: number;
  series?: { head: Series };
}

export interface Signal extends Measured {
  gate: Gate;
  base: number;
  series?: Record<SideName, Series>;
}

export interface Judged extends Signal {
  ratio: number;
  status: Status;
}

export interface Frame {
  base: { ref: string; sha: string };
  head: { sha: string };
  runs: number;
  commands: string[][];
}

// The base reaches the compare as its bundle's size, or as the reason it has none (a build that
// failed); the head is always built, since a head that cannot be built is the run's own failure.
export interface Bytes {
  head: number;
  base: number | { notComparable: string };
}

export interface Compared extends Frame {
  signals: Judged[];
}

export interface Uncompared extends Frame {
  notComparable: string;
  signals: Measured[];
}

export type Report = Compared | Uncompared;

export type Verdict = "pass" | "fail" | "skip";

interface TimedPath {
  name: string;
  argv: string[];
  gate: Gate;
}

// The argv the hook registers and the argv a user types to browse a source; the bundle is timed on whatever it does with them.
export const TIMED_PATHS: TimedPath[] = [
  { name: "sync --quiet", argv: ["sync", "--quiet"], gate: "fail" },
  { name: "add --list", argv: ["add", "@example/repo", "--list", "--no-fetch"], gate: "warn" },
];

// How the report names the timed commands: the shipped path, not the scratch bundle each side was actually started from.
export const TIMED_COMMANDS: string[][] = TIMED_PATHS.map((timed) => [
  "node",
  "dist/cli.js",
  ...timed.argv,
]);

/** One cold start of a side's bundle on an argv, in milliseconds; a start that fails throws. */
export type Sampler = (side: SideName, argv: string[]) => number | Promise<number>;

interface Options {
  base: string;
  runs: number;
  out: string | undefined;
}

function fail(message: string): never {
  process.stderr.write(`bench_ci: ${message}\n`);
  process.stderr.write(USAGE);
  process.exit(2);
}

function measuredDataDir(value: string): string {
  return outsideCheckouts(value, repoRoot, "measured data", fail);
}

function parseArgs(argv: string[]): Options {
  const { values } = parseArgv(
    {
      args: argv,
      options: {
        base: { type: "string" },
        runs: { type: "string", default: "10" },
        out: { type: "string" },
      },
    },
    fail,
  );
  const runs = positiveInteger("--runs", values.runs, fail);
  const out = values.out === undefined ? undefined : measuredDataDir(values.out);
  if (values.base === undefined) fail("--base <ref> is required");
  return { base: values.base, runs, out };
}

function statusOf(ratio: number, gate: Gate): Status {
  if (ratio > FAIL_RATIO) return gate;
  if (ratio > WARN_RATIO) return "warn";
  return "ok";
}

// The ratio is rounded to a millionth before the compare: 24.4 ms to 30.5 ms is exactly 25% in
// decimal but lands a hair above it in binary, and a gate must not fail on that hair.
export function judge(signal: Signal): Judged {
  const ratio = Math.round(((signal.head - signal.base) / signal.base) * 1e6) / 1e6;
  return { ...signal, ratio, status: statusOf(ratio, signal.gate) };
}

export function verdict(report: Report): Verdict {
  if ("notComparable" in report) return "skip";
  return report.signals.some((signal) => signal.status === "fail") ? "fail" : "pass";
}

const round = (ms: number): number => Math.round(ms * 1000) / 1000;

// A trimmed mean over the median: of ten samples the median reads two and a 20% trimmed mean six,
// so jitter moves it less, while two spikes on one side still fall off the end.
function series(samples: number[]): Series {
  const [warmup, ...timed] = samples.map(round);
  const sorted = timed.sort((a, b) => a - b);
  const trim = Math.floor(sorted.length * TRIM_RATIO);
  return {
    warmup,
    kept: sorted.slice(trim, sorted.length - trim),
    trimmed: [...sorted.slice(0, trim), ...sorted.slice(sorted.length - trim)],
  };
}

const figure = (s: Series): number =>
  round(s.kept.reduce((sum, ms) => sum + ms, 0) / s.kept.length);

type Timed =
  | { paths: Record<SideName, Series>[]; baseBytes: number }
  | { heads: Series[]; notComparable: string };

// The base side as the timing sees it: a bundle of so many bytes, or the reason it is not timed.
type BaseState = { bytes: number } | { notComparable: string };

// A bundle under the floor is a placeholder, not a CLI: the argument parser alone bundles past it,
// and the version-only stub that once stood where the CLI now is was 160 bytes. A delta against
// such a base fails by construction, so the base is reported as not comparable instead.
function comparableBase(base: Bytes["base"]): BaseState {
  if (typeof base !== "number") return base;
  if (base >= MIN_COMPARABLE_BUNDLE_BYTES) return { bytes: base };

  const floor = MIN_COMPARABLE_BUNDLE_BYTES.toLocaleString("en-US");
  return {
    notComparable: `its bundle is ${quantity(base, "bytes")}, under the ${floor}-byte floor`,
  };
}

// The pair swaps order every run: with the base always first, the head drew the cooler second
// slot of every pair and the same bytes read up to 7% faster on a settling runner.
function sideOrder(run: number): SideName[] {
  if (run % 2 === 0) return ["base", "head"];
  return ["head", "base"];
}

async function sampleBase(argv: string[], sample: Sampler): Promise<number | BaseState> {
  try {
    return await sample("base", argv);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    return { notComparable: `timing its bundle failed: ${reason}` };
  }
}

interface TimedStarts {
  starts: Record<SideName, number[]>;
  base: BaseState;
}

// The head is timed on every run even after the base stopped being comparable, so the head's own
// figures still print; the base is skipped from its first failed start on.
async function timePath(
  argv: string[],
  runs: number,
  base: BaseState,
  sample: Sampler,
): Promise<TimedStarts> {
  const starts: Record<SideName, number[]> = { base: [], head: [] };
  let state = base;
  for (let run = 0; run <= runs; run++) {
    for (const side of sideOrder(run)) {
      if (side === "head") {
        starts.head.push(await sample("head", argv));
        continue;
      }
      if ("notComparable" in state) continue;

      const start = await sampleBase(argv, sample);
      if (typeof start === "number") starts.base.push(start);
      else state = start;
    }
  }
  return { starts, base: state };
}

async function timeSides(runs: number, bytes: Bytes, sample: Sampler): Promise<Timed> {
  let base = comparableBase(bytes.base);
  const heads: Series[] = [];
  const bases: Series[] = [];
  for (const path of TIMED_PATHS) {
    const timed = await timePath(path.argv, runs, base, sample);
    base = timed.base;
    heads.push(series(timed.starts.head));
    if ("bytes" in base) bases.push(series(timed.starts.base));
  }

  if ("notComparable" in base) return { heads, notComparable: base.notComparable };

  return {
    paths: heads.map((head, index) => ({ head, base: bases[index] })),
    baseBytes: base.bytes,
  };
}

export async function compare(frame: Frame, bytes: Bytes, sample: Sampler): Promise<Report> {
  const timed = await timeSides(frame.runs, bytes, sample);
  if ("notComparable" in timed) {
    return {
      ...frame,
      notComparable: timed.notComparable,
      signals: [
        ...TIMED_PATHS.map((path, index) => {
          const head = timed.heads[index];
          return { name: path.name, unit: "ms" as const, head: figure(head), series: { head } };
        }),
        { name: "bundle size", unit: "bytes", head: bytes.head },
      ],
    };
  }
  return {
    ...frame,
    signals: [
      ...TIMED_PATHS.map((path, index) => {
        const { base, head } = timed.paths[index];
        return judge({
          name: path.name,
          unit: "ms",
          gate: path.gate,
          base: figure(base),
          head: figure(head),
          series: { base, head },
        });
      }),
      judge({
        name: "bundle size",
        unit: "bytes",
        gate: "fail",
        base: timed.baseBytes,
        head: bytes.head,
      }),
    ],
  };
}

const short = (sha: string): string => sha.slice(0, 7);

const starts = (ms: number[]): string => ms.map((value) => value.toFixed(1)).join(" ");

// The dropped samples are printed with the kept ones so a reader of a surprising verdict sees
// what the runner delivered, not only what survived the trim.
function sampleRows(report: Report): string[][] {
  const rows: string[][] = [];
  for (const signal of report.signals) {
    if (signal.series === undefined) continue;
    for (const [side, s] of Object.entries(signal.series)) {
      rows.push([signal.name, side, starts(s.kept), starts(s.trimmed), s.warmup.toFixed(1)]);
    }
  }
  return rows;
}

export function renderMarkdown(report: Report): string {
  const against = `Head \`${short(report.head.sha)}\` against base \`${short(report.base.sha)}\` (\`${report.base.ref}\`)`;
  return `## Latency and bundle size\n\n${renderComparison(against, report)}\n`;
}

// `against` names the two sides the way the caller found them (a ref for the PR gate, a trend
// entry for the nightly); the statistic, the tables, and the verdict read the same for both.
export function renderComparison(against: string, report: Report): string {
  const statistic = `${TRIM_RATIO * 100}% trimmed mean of ${report.runs} cold starts`;
  const header = ["signal", "base", "head", "delta", "status"];
  const lines: string[] = [];
  if ("notComparable" in report) {
    lines.push(
      `${against}: ${statistic} of the head, built and timed on this runner.`,
      "",
      markdownTable(
        header,
        report.signals.map((s) => [s.name, "n/a", quantity(s.head, s.unit), "n/a", "skip"]),
      ),
      "",
      `Verdict: skip. Base \`${short(report.base.sha)}\` is not comparable (${report.notComparable}); deltas not judged.`,
    );
  } else {
    const failures = report.signals.filter((s) => s.status === "fail");
    const limit = `${FAIL_RATIO * 100}%`;
    lines.push(
      `${against}: ${statistic} each, the two bundles built on this runner and timed turn about.`,
      "",
      markdownTable(
        header,
        report.signals.map((s) => [
          s.name,
          quantity(s.base, s.unit),
          quantity(s.head, s.unit),
          percent(s.ratio),
          s.status === "fail" ? "FAIL" : s.status,
        ]),
      ),
      "",
      failures.length === 0
        ? `Verdict: pass. A regression past ${limit} fails the job on a signal marked fail; past ${WARN_RATIO * 100}% it warns.`
        : `Verdict: FAIL. ${failures.map((s) => `${s.name} regressed ${percent(s.ratio)} (limit ${limit})`).join("; ")}.`,
    );
  }
  lines.push(
    "",
    "Cold starts in ms, sorted; the judged figure is the mean of the kept column, after one untimed warm-up.",
    "",
    markdownTable(["signal", "side", "kept", "trimmed", "warm-up"], sampleRows(report)),
    "",
    `Commands timed: ${report.commands.map((argv) => `\`${argv.join(" ")}\``).join(", ")}.`,
  );
  return lines.join("\n");
}

export function renderJson(report: Report): string {
  return `${JSON.stringify({ ...report, verdict: verdict(report) })}\n`;
}

const git = (args: string[]): string => captureOrThrow("git", ["-C", repoRoot, ...args]).trim();

export interface Built {
  bytes: number;
  bundle: string;
}

export const bundlePath = (scratch: string, label: SideName): string =>
  join(scratch, `${label}-dist`, "cli.js");

export function build(root: string, label: SideName, scratch: string): Built {
  const bundle = bundlePath(scratch, label);
  const sizeJson = join(dirname(bundle), "size.json");
  runOrThrow(
    "bun",
    [join(root, "scripts", "build.ts"), "--outfile", bundle, "--size-json", sizeJson],
    root,
  );
  return { bytes: readPositiveNumber(sizeJson, "bytes"), bundle };
}

// The base's checkout is registered in this repository's .git and released as soon as its bundle
// exists beside it; --force because `bun install` leaves the tree unclean.
export function buildBase(sha: string, scratch: string): Built {
  const baseRoot = join(scratch, "base");
  git(["worktree", "add", "--detach", baseRoot, sha]);
  try {
    if (!existsSync(join(baseRoot, "scripts", "build.ts")))
      throw new Error(`base \`${short(sha)}\` has no scripts/build.ts to build`);
    runOrThrow("bun", ["install", "--frozen-lockfile"], baseRoot);
    return build(baseRoot, "base", scratch);
  } finally {
    git(["worktree", "remove", "--force", baseRoot]);
  }
}

// A base ruled out before the timing has no bundle and is never asked for a start (timeSides
// skips it), so the throw here is a programming error, not a measurement.
export function coldStarts(bundles: { head: string; base?: string }): Sampler {
  return async (side, argv) => {
    const bundle = bundles[side];
    if (bundle === undefined) throw new Error("the base side has no bundle to time");
    const command = ["node", bundle, ...argv];
    const result = await timeColdStart(command);
    if (result.exitCode === 0) return result.elapsedMs;
    process.stderr.write(result.stderr);
    throw new Error(`${command.join(" ")} ${exitDescription(result)}`);
  };
}

async function main(): Promise<number> {
  const options = parseArgs(process.argv.slice(2));
  const headSha = git(["rev-parse", "HEAD"]);
  const baseSha = git(["rev-parse", "--verify", `${options.base}^{commit}`]);
  return withScratchDir("maxims-bench-ci-", async (scratch) => {
    const base = buildBase(baseSha, scratch);
    const head = build(repoRoot, "head", scratch);
    const report = await compare(
      {
        base: { ref: options.base, sha: baseSha },
        head: { sha: headSha },
        runs: options.runs,
        commands: TIMED_COMMANDS,
      },
      { base: base.bytes, head: head.bytes },
      coldStarts({ base: base.bundle, head: head.bundle }),
    );
    const markdown = renderMarkdown(report);
    if (options.out !== undefined) {
      mkdirSync(options.out, { recursive: true });
      writeFileSync(join(options.out, "report.md"), markdown);
      writeFileSync(join(options.out, "report.json"), renderJson(report));
    }
    process.stdout.write(markdown);
    return verdict(report) === "fail" ? 1 : 0;
  });
}

if (import.meta.main) {
  try {
    process.exit(await main());
  } catch (error) {
    process.stderr.write(`bench_ci: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(1);
  }
}
