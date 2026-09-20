// Runs one nightly category, writes its step summary, and on a failure writes the report the
// tracking-issue job turns into the issue body. Every category answers with an Outcome; the exit
// code and the files written are decided here alone.
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { isInside, whereBytesLand } from "./lib/paths.ts";
import { runHarnessDrift } from "./nightly/harness_drift.ts";
import { runLatencyTrend } from "./nightly/latency_trend.ts";
import { runLiveNetwork } from "./nightly/live_network.ts";
import { runParityDrift } from "./nightly/parity_drift.ts";
import { DEFAULT_ITERATIONS, runPropertyDeep } from "./nightly/property_deep.ts";
import { type Outcome, writeFailureReport, writeStepSummary } from "./nightly/report.ts";

export const CATEGORIES = [
  "property-deep",
  "parity-drift",
  "harness-drift",
  "live-network",
  "latency-trend",
] as const;
export type Category = (typeof CATEGORIES)[number];

const USAGE =
  "usage: bun scripts/nightly.ts <category> [--report-dir <dir>] [--trend <file>] [--iterations <n>]\n" +
  `categories: ${CATEGORIES.join(" | ")}\n`;
const repoRoot = resolve(import.meta.dir, "..");
const BUNDLE = join(repoRoot, "dist", "cli.js");

// What each category needs beyond its name, parsed once here so a module never sees a flag it
// has no use for.
type Run =
  | { category: "property-deep"; iterations: number }
  | { category: "parity-drift" }
  | { category: "harness-drift" }
  | { category: "live-network" }
  | { category: "latency-trend"; trend: string };

interface Options {
  run: Run;
  reportDir: string | undefined;
}

function usage(message: string): never {
  process.stderr.write(`nightly: ${message}\n`);
  process.stderr.write(USAGE);
  process.exit(2);
}

function isCategory(value: string): value is Category {
  return CATEGORIES.some((category) => category === value);
}

// Every checkout of the repository shares its history, so a commit from any of them publishes
// what lands there; git's own worktree list is the set of them. A bare entry has no working tree.
function repositoryRoots(): Set<string> {
  const roots = new Set([whereBytesLand(repoRoot, usage)]);
  for (const entry of git(["worktree", "list", "--porcelain"]).split("\n\n")) {
    const lines = entry.split("\n");
    const path = lines[0]?.startsWith("worktree ") ? lines[0].slice("worktree ".length) : undefined;
    if (path === undefined || lines.includes("bare")) continue;
    roots.add(existsSync(path) ? whereBytesLand(path, usage) : resolve(path));
  }
  return roots;
}

// A failure report and a trend file are evidence from one run; refusing to write either inside
// any checkout keeps them out of a commit.
function outsideRepository(value: string, what: string): string {
  const path = whereBytesLand(value, usage);
  for (const root of repositoryRoots()) {
    if (isInside(root, path)) usage(`refusing to write ${what} inside the repository: ${path}`);
  }
  return path;
}

function git(args: string[]): string {
  const proc = Bun.spawnSync(["git", "-C", repoRoot, ...args], {
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  if (proc.exitCode !== 0)
    throw new Error(`git ${args.join(" ")} failed: ${proc.stderr.toString().trim()}`);
  return proc.stdout.toString().trim();
}

type Flag = "--report-dir" | "--trend" | "--iterations";
const FLAGS: readonly Flag[] = ["--report-dir", "--trend", "--iterations"];

function isFlag(value: string): value is Flag {
  return FLAGS.some((flag) => flag === value);
}

// The flags a category has no use for are refused, so a run cannot look configured when its
// setting was silently ignored.
function plan(category: Category, flags: Map<Flag, string>): Run {
  const only = (accepted: readonly Flag[]): void => {
    for (const flag of flags.keys()) {
      if (!accepted.includes(flag)) usage(`${category} does not take ${flag}`);
    }
  };
  switch (category) {
    case "property-deep": {
      only(["--report-dir", "--iterations"]);
      const raw = flags.get("--iterations");
      if (raw === undefined) return { category, iterations: DEFAULT_ITERATIONS };
      const iterations = Number(raw);
      if (!Number.isInteger(iterations) || iterations < 1)
        usage(`--iterations must be a positive integer, got ${raw}`);
      return { category, iterations };
    }
    case "parity-drift":
    case "harness-drift":
    case "live-network":
      only(["--report-dir"]);
      return { category };
    case "latency-trend": {
      only(["--report-dir", "--trend"]);
      const trend = flags.get("--trend");
      if (trend === undefined) usage("latency-trend needs --trend <file>");
      return { category, trend: outsideRepository(trend, "the trend file") };
    }
  }
}

export function parseArgs(argv: string[]): Options {
  const [category, ...rest] = argv;
  if (category === undefined) usage("a category is required");
  if (!isCategory(category)) usage(`unknown category ${category}`);
  const flags = new Map<Flag, string>();
  for (let i = 0; i < rest.length; i++) {
    const flag = rest[i];
    if (!isFlag(flag)) usage(`unknown argument ${flag}`);
    const value = rest[i + 1];
    if (value === undefined || value.startsWith("--")) usage(`${flag} needs a value`);
    if (flags.has(flag)) usage(`${flag} given twice`);
    flags.set(flag, value);
    i++;
  }
  const reportDir = flags.get("--report-dir");
  return {
    run: plan(category, flags),
    reportDir:
      reportDir === undefined ? undefined : outsideRepository(reportDir, "the failure report"),
  };
}

async function runCategory(run: Run): Promise<Outcome> {
  switch (run.category) {
    case "property-deep":
      return runPropertyDeep(run.iterations);
    case "parity-drift":
      return runParityDrift();
    case "harness-drift":
      return runHarnessDrift();
    case "live-network":
      return runLiveNetwork(BUNDLE);
    case "latency-trend":
      return runLatencyTrend(run.trend);
  }
}

// The command a reader runs to see the failure again; a category with a required flag names it.
function replayCommand(run: Run): string {
  switch (run.category) {
    case "latency-trend":
      return "bun run nightly latency-trend --trend <a checkout of the benchmarks branch>/trend.json";
    case "property-deep":
      return `bun run nightly property-deep --iterations ${run.iterations}`;
    default:
      return `bun run nightly ${run.category}`;
  }
}

// A category that throws is a red night like any other, and the issue needs the error rather
// than a pointer at the run log.
function didNotComplete(category: Category, error: unknown): Outcome {
  const message = error instanceof Error ? (error.stack ?? error.message) : String(error);
  const body = `\`bun run nightly ${category}\` threw before it could judge anything:\n\n\`\`\`text\n${message}\n\`\`\`\n`;
  return {
    status: "fail",
    summary: `## ${category} did not complete\n\n${body}`,
    report: { title: `Nightly ${category} did not complete`, body },
  };
}

async function main(): Promise<number> {
  const options = parseArgs(process.argv.slice(2));
  const { category } = options.run;
  const outcome = await runCategory(options.run).catch((error: unknown) =>
    didNotComplete(category, error),
  );
  writeStepSummary(outcome.summary, process.env);
  process.stdout.write(`nightly ${category}: ${outcome.status}\n`);
  if (outcome.status === "pass") return 0;
  process.stdout.write(`${outcome.report.body}\n`);
  if (options.reportDir !== undefined)
    writeFailureReport(options.reportDir, category, replayCommand(options.run), outcome.report);
  return 1;
}

if (import.meta.main) {
  try {
    process.exit(await main());
  } catch (error) {
    process.stderr.write(`nightly: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(1);
  }
}
