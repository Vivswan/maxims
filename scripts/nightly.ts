// Runs one nightly category, writes its step summary, and on a failure writes the report the
// tracking-issue job turns into the issue body. Every category answers with an Outcome; the exit
// code and the files written are decided here alone.
import { resolve } from "node:path";
import { isInside, whereBytesLand } from "./lib/paths.ts";
import { runHarnessDrift } from "./nightly/harness_drift.ts";
import { type Outcome, writeFailureReport, writeStepSummary } from "./nightly/report.ts";

export const CATEGORIES = ["harness-drift"] as const;
export type Category = (typeof CATEGORIES)[number];

const USAGE =
  "usage: bun scripts/nightly.ts <category> [--report-dir <dir>] [--trend <file>] [--iterations <n>]\n" +
  `categories: ${CATEGORIES.join(" | ")}\n`;
const repoRoot = resolve(import.meta.dir, "..");

// What each category needs beyond its name, parsed once here so a module never sees a flag it
// has no use for.
type Run = { category: "harness-drift" };

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

// A failure report is evidence from one run; refusing to write it inside the repository keeps it
// out of a commit. A linked worktree's primary checkout is the same repository, so it is refused
// too.
function reportDirOutsideRepository(value: string): string {
  const dir = whereBytesLand(value, usage);
  const common = resolve(repoRoot, git(["rev-parse", "--git-common-dir"]));
  const roots = [repoRoot, resolve(common, "..")].map((root) => whereBytesLand(root, usage));
  for (const root of new Set(roots)) {
    if (isInside(root, dir))
      usage(`refusing to write the failure report inside the repository: ${dir}`);
  }
  return dir;
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
    case "harness-drift":
      only(["--report-dir"]);
      return { category };
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
    reportDir: reportDir === undefined ? undefined : reportDirOutsideRepository(reportDir),
  };
}

async function runCategory(run: Run): Promise<Outcome> {
  switch (run.category) {
    case "harness-drift":
      return runHarnessDrift();
  }
}

async function main(): Promise<number> {
  const options = parseArgs(process.argv.slice(2));
  const { category } = options.run;
  const outcome = await runCategory(options.run);
  writeStepSummary(outcome.summary, process.env);
  process.stdout.write(`nightly ${category}: ${outcome.status}\n`);
  if (outcome.status === "pass") return 0;
  process.stdout.write(`${outcome.report.body}\n`);
  if (options.reportDir !== undefined)
    writeFailureReport(options.reportDir, category, outcome.report);
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
