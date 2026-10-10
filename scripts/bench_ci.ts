// Builds and times HEAD and the base ref on the same machine in one run, so the figures compare
// two bundles under the same noise instead of one bundle against a budget written for other
// hardware. The base is built from its own scripts/build.ts; the timing harness is HEAD's.
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { parseArgv, positiveInteger } from "./lib/argv.ts";
import { exitDescription, timeColdStart } from "./lib/cold_start.ts";
import { percent, quantity, readPositiveNumber, type Unit } from "./lib/figures.ts";
import { markdownTable } from "./lib/markdown.ts";
import { outsideCheckouts } from "./lib/paths.ts";
import { withScratchDir } from "./lib/scratch.ts";
import { captureOrThrow, runOrThrow } from "./lib/spawn.ts";

const USAGE = "usage: bun scripts/bench_ci.ts --base <ref> [--runs N] [--out dir]\n";
const repoRoot = resolve(import.meta.dir, "..");

export const WARN_RATIO = 0.1;
export const FAIL_RATIO = 0.25;

// The share of a series dropped from each end before the mean. A 20% trimmed mean over the median:
// of ten samples the median reads two and the trimmed mean six, so jitter moves it less, while two
// spikes on one side still fall off the end.
export const TRIM_RATIO = 0.2;

// A bundle under this size is a placeholder, not a CLI: the argument parser alone bundles past
// it, and the version-only stub that once stood where the CLI now is was 160 bytes. A delta
// against such a base fails by construction, so the base is reported as not comparable instead.
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

interface Frame {
  base: { ref: string; sha: string };
  head: { sha: string };
  runs: number;
  commands: string[][];
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

// The argv the hook registers and the argv a user types to browse a source; the bundle is timed
// on whatever it does with them.
export const TIMED_PATHS: TimedPath[] = [
  { name: "sync --quiet", argv: ["sync", "--quiet"], gate: "fail" },
  { name: "add --list", argv: ["add", "@example/repo", "--list", "--no-fetch"], gate: "warn" },
];

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

// The ratio is rounded to a millionth before the compare: 24.4 ms to 30.5 ms is exactly 25% in
// decimal but lands a hair above it in binary, and a gate must not fail on that hair.
export function judge(signal: Signal): Judged {
  const ratio = Math.round(((signal.head - signal.base) / signal.base) * 1e6) / 1e6;
  const status: Status = ratio > FAIL_RATIO ? signal.gate : ratio > WARN_RATIO ? "warn" : "ok";
  return { ...signal, ratio, status };
}

export function verdict(report: Report): Verdict {
  if ("notComparable" in report) return "skip";
  return report.signals.some((signal) => signal.status === "fail") ? "fail" : "pass";
}

const round = (ms: number): number => Math.round(ms * 1000) / 1000;

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

// Every timed path paired, or the heads alone with the reason the base yields no delta.
type Timed = { paths: Record<SideName, Series>[] } | { heads: Series[]; notComparable: string };

// The two sides are timed turn about, one start each per run, so a slow stretch of the runner
// slows both alike: timed whole before the base, right after two builds and an install, the head
// read up to 75% over the same bytes. A head that cannot be timed is this run's own failure; a
// base that cannot be timed only yields no delta, and the head is still measured in full.
async function timeSides(
  runs: number,
  bytes: Record<SideName, number>,
  sample: Sampler,
): Promise<Timed> {
  let notComparable: string | undefined;
  if (bytes.base < MIN_COMPARABLE_BUNDLE_BYTES) {
    const floor = MIN_COMPARABLE_BUNDLE_BYTES.toLocaleString("en-US");
    notComparable = `its bundle is ${quantity(bytes.base, "bytes")}, under the ${floor}-byte floor`;
  }
  const heads: Series[] = [];
  const bases: Series[] = [];
  for (const path of TIMED_PATHS) {
    const starts: Record<SideName, number[]> = { base: [], head: [] };
    for (let run = 0; run <= runs; run++) {
      if (notComparable === undefined) {
        try {
          starts.base.push(await sample("base", path.argv));
        } catch (error) {
          const reason = error instanceof Error ? error.message : String(error);
          notComparable = `timing its bundle failed: ${reason}`;
        }
      }
      starts.head.push(await sample("head", path.argv));
    }
    heads.push(series(starts.head));
    if (notComparable === undefined) bases.push(series(starts.base));
  }
  if (notComparable !== undefined) return { heads, notComparable };
  return { paths: heads.map((head, index) => ({ head, base: bases[index] })) };
}

export async function compare(
  frame: Frame,
  bytes: Record<SideName, number>,
  sample: Sampler,
): Promise<Report> {
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
        base: bytes.base,
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
  const statistic = `${TRIM_RATIO * 100}% trimmed mean of ${report.runs} cold starts`;
  const header = ["signal", "base", "head", "delta", "status"];
  const lines = ["## Latency and bundle size", ""];
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
  return `${lines.join("\n")}\n`;
}

export function renderJson(report: Report): string {
  return `${JSON.stringify({ ...report, verdict: verdict(report) })}\n`;
}

const git = (args: string[]): string => captureOrThrow("git", ["-C", repoRoot, ...args]).trim();

interface Built {
  bytes: number;
  bundle: string;
}

function build(root: string, label: SideName, scratch: string): Built {
  const outDir = join(scratch, `${label}-dist`);
  const bundle = join(outDir, "cli.js");
  const sizeJson = join(outDir, "size.json");
  runOrThrow(
    "bun",
    [join(root, "scripts", "build.ts"), "--outfile", bundle, "--size-json", sizeJson],
    root,
  );
  return { bytes: readPositiveNumber(sizeJson, "bytes"), bundle };
}

function buildBase(options: Options, scratch: string, baseSha: string): Built {
  const baseRoot = join(scratch, "base");
  git(["worktree", "add", "--detach", baseRoot, baseSha]);
  if (!existsSync(join(baseRoot, "scripts", "build.ts")))
    throw new Error(`base ${options.base} (${short(baseSha)}) has no scripts/build.ts to build`);
  runOrThrow("bun", ["install", "--frozen-lockfile"], baseRoot);
  return build(baseRoot, "base", scratch);
}

function coldStarts(bundles: Record<SideName, string>): Sampler {
  return async (side, argv) => {
    const command = ["node", bundles[side], ...argv];
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
  try {
    return await withScratchDir("maxims-bench-ci-", async (scratch) => {
      const base = buildBase(options, scratch, baseSha);
      const head = build(repoRoot, "head", scratch);
      const report = await compare(
        {
          base: { ref: options.base, sha: baseSha },
          head: { sha: headSha },
          runs: options.runs,
          commands: TIMED_PATHS.map((timed) => ["node", "dist/cli.js", ...timed.argv]),
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
  } finally {
    // Pruning once the scratch tree is gone covers a worktree add that registered the checkout
    // and then failed (a post-checkout hook, for one), which a remove keyed on success would miss.
    git(["worktree", "prune"]);
  }
}

if (import.meta.main) {
  try {
    process.exit(await main());
  } catch (error) {
    process.stderr.write(`bench_ci: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(1);
  }
}
