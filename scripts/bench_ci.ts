// Builds and times HEAD and the base ref on the same machine in one run, so the figures compare
// two bundles under the same noise instead of one bundle against a budget written for other
// hardware. The base is built from its own scripts/build.ts; the timing harness is HEAD's.
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join, relative, resolve, sep } from "node:path";

const USAGE = "usage: bun scripts/bench_ci.ts --base <ref> [--runs N] [--out dir]\n";
const repoRoot = resolve(import.meta.dir, "..");

export const WARN_RATIO = 0.1;
export const FAIL_RATIO = 0.25;

// What a gross regression does to the job. The hook path and the artifact gate the merge; the
// interactive path only reports, since it is allowed to cost more.
export type Gate = "fail" | "warn";
export type Status = "ok" | "warn" | "fail";

export interface Signal {
  name: string;
  unit: "ms" | "bytes";
  gate: Gate;
  base: number;
  head: number;
}

export interface Judged extends Signal {
  ratio: number;
  status: Status;
}

export interface Report {
  base: { ref: string; sha: string };
  head: { sha: string };
  runs: number;
  commands: string[][];
  signals: Judged[];
}

interface TimedPath {
  name: string;
  argv: string[];
  gate: Gate;
}

// The argv the hook registers and the argv a user types to browse a source; the bundle is timed
// on whatever it does with them.
const TIMED_PATHS: TimedPath[] = [
  { name: "sync --quiet", argv: ["sync", "--quiet"], gate: "fail" },
  { name: "add --list", argv: ["add", "@example/repo", "--list", "--no-fetch"], gate: "warn" },
];

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

// The report carries this machine's timings; refusing to write it inside the repository keeps
// it out of a commit, since .gitignore is not consulted by `git add -f`. A linked worktree's
// primary checkout is the same repository, so it is refused too.
function measuredDataDir(value: string): string {
  const out = resolve(value);
  const common = resolve(repoRoot, git(["rev-parse", "--git-common-dir"]));
  for (const root of new Set([repoRoot, resolve(common, "..")])) {
    const rel = relative(root, out);
    const outside = rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel);
    if (!outside) fail(`refusing to write measured data inside the repository: ${out}`);
  }
  return out;
}

function parseArgs(argv: string[]): Options {
  let base: string | undefined;
  let runs = 10;
  let out: string | undefined;
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    if (flag !== "--base" && flag !== "--runs" && flag !== "--out")
      fail(`unknown argument ${flag}`);
    const value = argv[i + 1];
    if (value === undefined || value.startsWith("--")) fail(`${flag} needs a value`);
    if (flag === "--base") base = value;
    else if (flag === "--out") out = measuredDataDir(value);
    else {
      runs = Number(value);
      if (!Number.isInteger(runs) || runs < 1)
        fail(`--runs must be a positive integer, got ${value}`);
    }
    i++;
  }
  if (base === undefined) fail("--base <ref> is required");
  return { base, runs, out };
}

// The ratio is rounded to a millionth before the compare: 24.4 ms to 30.5 ms is exactly 25% in
// decimal but lands a hair above it in binary, and a gate must not fail on that hair.
export function judge(signal: Signal): Judged {
  const ratio = Math.round(((signal.head - signal.base) / signal.base) * 1e6) / 1e6;
  const status: Status = ratio > FAIL_RATIO ? signal.gate : ratio > WARN_RATIO ? "warn" : "ok";
  return { ...signal, ratio, status };
}

export function failed(signals: Judged[]): boolean {
  return signals.some((signal) => signal.status === "fail");
}

const percent = (ratio: number): string =>
  `${ratio * 100 >= 0 ? "+" : ""}${(ratio * 100).toFixed(1)}%`;
const short = (sha: string): string => sha.slice(0, 7);

function quantity(value: number, unit: Signal["unit"]): string {
  return unit === "ms" ? `${value.toFixed(1)} ms` : `${value.toLocaleString("en-US")} bytes`;
}

export function renderMarkdown(report: Report): string {
  const lines = [
    "## Latency and bundle size",
    "",
    `Head \`${short(report.head.sha)}\` against base \`${short(report.base.sha)}\` (\`${report.base.ref}\`): ` +
      `median of ${report.runs} cold starts each, both bundles built and timed on this runner.`,
    "",
    "| signal | base | head | delta | status |",
    "|---|---|---|---|---|",
  ];
  for (const s of report.signals) {
    const status = s.status === "fail" ? "FAIL" : s.status;
    lines.push(
      `| ${s.name} | ${quantity(s.base, s.unit)} | ${quantity(s.head, s.unit)} | ${percent(s.ratio)} | ${status} |`,
    );
  }
  const failures = report.signals.filter((s) => s.status === "fail");
  const limit = `${FAIL_RATIO * 100}%`;
  const verdict =
    failures.length === 0
      ? `Verdict: pass. A regression past ${limit} fails the job on a signal marked fail; past ${WARN_RATIO * 100}% it warns.`
      : `Verdict: FAIL. ${failures.map((s) => `${s.name} regressed ${percent(s.ratio)} (limit ${limit})`).join("; ")}.`;
  lines.push("", verdict, "");
  lines.push(
    `Commands timed: ${report.commands.map((argv) => `\`${argv.join(" ")}\``).join(", ")}.`,
  );
  return `${lines.join("\n")}\n`;
}

export function renderJson(report: Report): string {
  return `${JSON.stringify({ ...report, verdict: failed(report.signals) ? "fail" : "pass" })}\n`;
}

function run(command: string[], cwd: string): void {
  const proc = Bun.spawnSync(command, {
    cwd,
    stdin: "ignore",
    stdout: "inherit",
    stderr: "inherit",
  });
  if (proc.exitCode !== 0) {
    const how =
      proc.exitCode === null
        ? `was killed by ${proc.signalCode}`
        : `exited with code ${proc.exitCode}`;
    throw new Error(`${command.join(" ")} ${how}`);
  }
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

// Both producers write one flat JSON object; a missing or non-positive figure means the producer
// changed shape or measured nothing, and either would otherwise flow into a delta as NaN.
function readPositiveNumber(path: string, key: string): number {
  const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
  if (typeof parsed === "object" && parsed !== null && key in parsed) {
    const value: unknown = Reflect.get(parsed, key);
    if (typeof value === "number" && Number.isFinite(value) && value > 0) return value;
  }
  throw new Error(`${path} has no positive number at ${key}`);
}

interface Bundle {
  path: string;
  bytes: number;
}

function build(root: string, outDir: string): Bundle {
  const path = join(outDir, "cli.js");
  const sizeJson = join(outDir, "size.json");
  run(["bun", join(root, "scripts", "build.ts"), "--outfile", path, "--size-json", sizeJson], root);
  return { path, bytes: readPositiveNumber(sizeJson, "bytes") };
}

function medianMs(bundle: string, argv: string[], runs: number, json: string): number {
  const bench = join(repoRoot, "scripts", "bench.ts");
  run(
    ["bun", bench, "--runs", String(runs), "--json", json, "--", "node", bundle, ...argv],
    repoRoot,
  );
  return readPositiveNumber(json, "medianMs");
}

function compare(options: Options, scratch: string, baseSha: string, headSha: string): Report {
  const baseRoot = join(scratch, "base");
  git(["worktree", "add", "--detach", baseRoot, baseSha]);
  if (!existsSync(join(baseRoot, "scripts", "build.ts")))
    throw new Error(`base ${options.base} (${short(baseSha)}) has no scripts/build.ts to build`);
  run(["bun", "install", "--frozen-lockfile"], baseRoot);
  const base = build(baseRoot, join(scratch, "base-dist"));
  const head = build(repoRoot, join(scratch, "head-dist"));

  const signals: Judged[] = TIMED_PATHS.map((timed, index) =>
    judge({
      name: timed.name,
      unit: "ms",
      gate: timed.gate,
      base: medianMs(base.path, timed.argv, options.runs, join(scratch, `base-${index}.json`)),
      head: medianMs(head.path, timed.argv, options.runs, join(scratch, `head-${index}.json`)),
    }),
  );
  signals.push(
    judge({
      name: "bundle size",
      unit: "bytes",
      gate: "fail",
      base: base.bytes,
      head: head.bytes,
    }),
  );
  return {
    base: { ref: options.base, sha: baseSha },
    head: { sha: headSha },
    runs: options.runs,
    commands: TIMED_PATHS.map((timed) => ["node", "dist/cli.js", ...timed.argv]),
    signals,
  };
}

function main(): number {
  const options = parseArgs(process.argv.slice(2));
  const headSha = git(["rev-parse", "HEAD"]);
  const baseSha = git(["rev-parse", "--verify", `${options.base}^{commit}`]);
  const scratch = mkdtempSync(join(process.env.RUNNER_TEMP ?? tmpdir(), "maxims-bench-ci-"));
  try {
    const report = compare(options, scratch, baseSha, headSha);
    const markdown = renderMarkdown(report);
    if (options.out !== undefined) {
      mkdirSync(options.out, { recursive: true });
      writeFileSync(join(options.out, "report.md"), markdown);
      writeFileSync(join(options.out, "report.json"), renderJson(report));
    }
    process.stdout.write(markdown);
    return failed(report.signals) ? 1 : 0;
  } finally {
    // Deleting the scratch tree and pruning covers a worktree add that registered the checkout
    // and then failed (a post-checkout hook, for one), which a remove keyed on success would miss.
    rmSync(scratch, { recursive: true, force: true });
    git(["worktree", "prune"]);
  }
}

if (import.meta.main) {
  try {
    process.exit(main());
  } catch (error) {
    process.stderr.write(`bench_ci: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(1);
  }
}
