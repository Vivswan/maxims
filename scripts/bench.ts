// Cold-start benchmark: `bun scripts/bench.ts [--runs N] [--json path] -- <command...>`.
// Every run is a fresh process with its own throwaway HOME, so the number is the every-session
// cost and nothing the developer's real home holds can shorten or lengthen it.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

const DEFAULT_COMMAND = ["node", "dist/cli.js", "--version"];
const USAGE = "usage: bun scripts/bench.ts [--runs N] [--json path] -- <command...>\n";

interface Options {
  runs: number;
  json: string | undefined;
  command: string[];
}

interface BenchRecord {
  command: string[];
  runs: number;
  medianMs: number;
  minMs: number;
  maxMs: number;
}

function fail(message: string): never {
  process.stderr.write(`bench: ${message}\n`);
  process.stderr.write(USAGE);
  process.exit(2);
}

function parseArgs(argv: string[]): Options {
  const options: Options = { runs: 10, json: undefined, command: DEFAULT_COMMAND };
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    if (flag === "--") {
      options.command = argv.slice(i + 1);
      if (options.command.length === 0) fail("no command after --");
      break;
    }
    if (flag !== "--runs" && flag !== "--json") fail(`unknown argument ${flag}`);
    const value = argv[i + 1];
    if (value === undefined || value.startsWith("--")) fail(`${flag} needs a value`);
    if (flag === "--runs") {
      const runs = Number(value);
      if (!Number.isInteger(runs) || runs < 1)
        fail(`--runs must be a positive integer, got ${value}`);
      options.runs = runs;
    } else {
      options.json = value;
    }
    i++;
  }
  return options;
}

interface RunResult {
  elapsedMs: number;
  exitCode: number | null;
  signalCode: string | undefined;
  stderr: string;
}

// The exit-code check lives in the caller: exiting from inside this try would skip the finally and
// leave the run's HOME behind.
function timeOneRun(command: string[]): RunResult {
  const home = mkdtempSync(join(tmpdir(), "maxims-bench-home-"));
  try {
    const env = {
      ...process.env,
      HOME: home,
      USERPROFILE: home,
      MAXIMS_HOME: join(home, ".agents", "maxims"),
      NO_COLOR: "1",
    };
    const started = performance.now();
    const proc = Bun.spawnSync(command, { env, stdin: "ignore", stdout: "ignore", stderr: "pipe" });
    const elapsedMs = performance.now() - started;
    return {
      elapsedMs,
      exitCode: proc.exitCode,
      signalCode: proc.signalCode,
      stderr: proc.stderr.toString(),
    };
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
}

// Median, never the mean: one page-cache miss or scheduler hiccup must not move the reported
// number, since CI compares this figure against the base branch on the same shared runner.
function median(sorted: number[]): number {
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

const round = (ms: number): number => Math.round(ms * 1000) / 1000;

const options = parseArgs(process.argv.slice(2));
const timings: number[] = [];
for (let run = 0; run < options.runs; run++) {
  const result = timeOneRun(options.command);
  if (result.exitCode !== 0) {
    const how =
      result.exitCode === null
        ? `was killed by ${result.signalCode}`
        : `exited with code ${result.exitCode}`;
    process.stderr.write(result.stderr);
    process.stderr.write(`bench: ${options.command.join(" ")} ${how}\n`);
    process.exit(1);
  }
  timings.push(result.elapsedMs);
}
timings.sort((a, b) => a - b);

const record: BenchRecord = {
  command: options.command,
  runs: options.runs,
  medianMs: round(median(timings)),
  minMs: round(timings[0]),
  maxMs: round(timings[timings.length - 1]),
};
const line = `${JSON.stringify(record)}\n`;
if (options.json !== undefined) {
  const out = resolve(options.json);
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, line);
}
process.stdout.write(line);
