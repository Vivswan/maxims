// Builds and times HEAD and the base ref on the same machine in one run, so the figures compare
// two bundles under the same noise instead of one bundle against a budget written for other
// hardware. The base is built from its own scripts/build.ts; the timing harness is HEAD's.
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { readPositiveNumber } from "./lib/figures.ts";
import { outsideCheckouts } from "./lib/paths.ts";

const USAGE = "usage: bun scripts/bench_ci.ts --base <ref> [--runs N] [--out dir]\n";
const repoRoot = resolve(import.meta.dir, "..");

export const WARN_RATIO = 0.1;
export const FAIL_RATIO = 0.25;

// A bundle under this size is a placeholder, not a CLI: the argument parser alone bundles past
// it, and the version-only stub that once stood where the CLI now is was 160 bytes. A delta
// against such a base fails by construction, so the base is reported as not comparable instead.
export const MIN_COMPARABLE_BUNDLE_BYTES = 16 * 1024;

// What a gross regression does to the job. The hook path and the artifact gate the merge; the
// interactive path only reports, since it is allowed to cost more.
export type Gate = "fail" | "warn";
export type Status = "ok" | "warn" | "fail";
type Unit = "ms" | "bytes";

export interface Measured {
  name: string;
  unit: Unit;
  head: number;
}

export interface Signal extends Measured {
  gate: Gate;
  base: number;
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

// One built bundle and the timing of one argv on it; the index is the timed path's, so one side's
// measurement files stay apart from each other.
export interface Side {
  bytes: number;
  medianMs: (argv: string[], index: number) => number;
}

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

export function verdict(report: Report): Verdict {
  if ("notComparable" in report) return "skip";
  return report.signals.some((signal) => signal.status === "fail") ? "fail" : "pass";
}

interface Probe {
  name: string;
  unit: Unit;
  gate: Gate;
  measure: (side: Side) => number;
}

const probes = (): Probe[] => [
  ...TIMED_PATHS.map(
    (timed, index): Probe => ({
      name: timed.name,
      unit: "ms",
      gate: timed.gate,
      measure: (side) => side.medianMs(timed.argv, index),
    }),
  ),
  { name: "bundle size", unit: "bytes", gate: "fail", measure: (side) => side.bytes },
];

const bytes = (value: number): string => `${value.toLocaleString("en-US")} bytes`;

// The head is measured first and in full; a head that cannot be timed is this run's own failure
// and propagates. A base that cannot be timed is only a base that yields no delta.
export function compare(frame: Frame, base: Side, head: Side): Report {
  const measured = probes().map((probe) => ({ probe, head: probe.measure(head) }));
  const headOnly = (notComparable: string): Uncompared => ({
    ...frame,
    notComparable,
    signals: measured.map(({ probe, head }) => ({ name: probe.name, unit: probe.unit, head })),
  });
  if (base.bytes < MIN_COMPARABLE_BUNDLE_BYTES) {
    const floor = MIN_COMPARABLE_BUNDLE_BYTES.toLocaleString("en-US");
    return headOnly(`its bundle is ${bytes(base.bytes)}, under the ${floor}-byte floor`);
  }
  try {
    return {
      ...frame,
      signals: measured.map(({ probe, head }) =>
        judge({
          name: probe.name,
          unit: probe.unit,
          gate: probe.gate,
          base: probe.measure(base),
          head,
        }),
      ),
    };
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    return headOnly(`timing its bundle failed: ${reason}`);
  }
}

const percent = (ratio: number): string =>
  `${ratio * 100 >= 0 ? "+" : ""}${(ratio * 100).toFixed(1)}%`;
const short = (sha: string): string => sha.slice(0, 7);

function quantity(value: number, unit: Unit): string {
  return unit === "ms" ? `${value.toFixed(1)} ms` : bytes(value);
}

export function renderMarkdown(report: Report): string {
  const against = `Head \`${short(report.head.sha)}\` against base \`${short(report.base.sha)}\` (\`${report.base.ref}\`)`;
  const lines = ["## Latency and bundle size", ""];
  if ("notComparable" in report) {
    lines.push(
      `${against}: median of ${report.runs} cold starts of the head, built and timed on this runner.`,
    );
  } else {
    lines.push(
      `${against}: median of ${report.runs} cold starts each, both bundles built and timed on this runner.`,
    );
  }
  lines.push("", "| signal | base | head | delta | status |", "|---|---|---|---|---|");
  if ("notComparable" in report) {
    for (const s of report.signals) {
      lines.push(`| ${s.name} | n/a | ${quantity(s.head, s.unit)} | n/a | skip |`);
    }
    lines.push(
      "",
      `Verdict: skip. Base \`${short(report.base.sha)}\` is not comparable (${report.notComparable}); deltas not judged.`,
      "",
    );
  } else {
    for (const s of report.signals) {
      const status = s.status === "fail" ? "FAIL" : s.status;
      lines.push(
        `| ${s.name} | ${quantity(s.base, s.unit)} | ${quantity(s.head, s.unit)} | ${percent(s.ratio)} | ${status} |`,
      );
    }
    const failures = report.signals.filter((s) => s.status === "fail");
    const limit = `${FAIL_RATIO * 100}%`;
    const line =
      failures.length === 0
        ? `Verdict: pass. A regression past ${limit} fails the job on a signal marked fail; past ${WARN_RATIO * 100}% it warns.`
        : `Verdict: FAIL. ${failures.map((s) => `${s.name} regressed ${percent(s.ratio)} (limit ${limit})`).join("; ")}.`;
    lines.push("", line, "");
  }
  lines.push(
    `Commands timed: ${report.commands.map((argv) => `\`${argv.join(" ")}\``).join(", ")}.`,
  );
  return `${lines.join("\n")}\n`;
}

export function renderJson(report: Report): string {
  return `${JSON.stringify({ ...report, verdict: verdict(report) })}\n`;
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

function medianMs(bundle: string, argv: string[], runs: number, json: string): number {
  const bench = join(repoRoot, "scripts", "bench.ts");
  run(
    ["bun", bench, "--runs", String(runs), "--json", json, "--", "node", bundle, ...argv],
    repoRoot,
  );
  return readPositiveNumber(json, "medianMs");
}

function build(root: string, label: "base" | "head", runs: number, scratch: string): Side {
  const outDir = join(scratch, `${label}-dist`);
  const bundle = join(outDir, "cli.js");
  const sizeJson = join(outDir, "size.json");
  run(
    ["bun", join(root, "scripts", "build.ts"), "--outfile", bundle, "--size-json", sizeJson],
    root,
  );
  return {
    bytes: readPositiveNumber(sizeJson, "bytes"),
    medianMs: (argv, index) =>
      medianMs(bundle, argv, runs, join(scratch, `${label}-${index}.json`)),
  };
}

function buildBase(options: Options, scratch: string, baseSha: string): Side {
  const baseRoot = join(scratch, "base");
  git(["worktree", "add", "--detach", baseRoot, baseSha]);
  if (!existsSync(join(baseRoot, "scripts", "build.ts")))
    throw new Error(`base ${options.base} (${short(baseSha)}) has no scripts/build.ts to build`);
  run(["bun", "install", "--frozen-lockfile"], baseRoot);
  return build(baseRoot, "base", options.runs, scratch);
}

function main(): number {
  const options = parseArgs(process.argv.slice(2));
  const headSha = git(["rev-parse", "HEAD"]);
  const baseSha = git(["rev-parse", "--verify", `${options.base}^{commit}`]);
  const scratch = mkdtempSync(join(process.env.RUNNER_TEMP ?? tmpdir(), "maxims-bench-ci-"));
  try {
    const base = buildBase(options, scratch, baseSha);
    const head = build(repoRoot, "head", options.runs, scratch);
    const report = compare(
      {
        base: { ref: options.base, sha: baseSha },
        head: { sha: headSha },
        runs: options.runs,
        commands: TIMED_PATHS.map((timed) => ["node", "dist/cli.js", ...timed.argv]),
      },
      base,
      head,
    );
    const markdown = renderMarkdown(report);
    if (options.out !== undefined) {
      mkdirSync(options.out, { recursive: true });
      writeFileSync(join(options.out, "report.md"), markdown);
      writeFileSync(join(options.out, "report.json"), renderJson(report));
    }
    process.stdout.write(markdown);
    return verdict(report) === "fail" ? 1 : 0;
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
