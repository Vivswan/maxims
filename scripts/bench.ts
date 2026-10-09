// Every run is a fresh process with its own throwaway HOME, so the number is the every-session
// cost and nothing the developer's real home holds can shorten or lengthen it.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { parseArgv, positiveInteger } from "./lib/argv.ts";
import { outsideCheckouts } from "./lib/paths.ts";

const DEFAULT_COMMAND = ["node", "dist/cli.js", "--version"];
const USAGE = "usage: bun scripts/bench.ts [--runs N] [--json path] -- <command...>\n";
const repoRoot = resolve(import.meta.dir, "..");

interface Options {
  runs: number;
  json: string | undefined;
  command: string[];
}

interface Summary {
  medianMs: number;
  minMs: number;
  maxMs: number;
}

interface BenchRecord extends Summary {
  command: string[];
  runs: number;
}

function fail(message: string): never {
  process.stderr.write(`bench: ${message}\n`);
  process.stderr.write(USAGE);
  process.exit(2);
}

function measuredDataPath(value: string): string {
  return outsideCheckouts(value, repoRoot, "measured data", fail);
}

function parseArgs(argv: string[]): Options {
  const { values, positionals, tokens } = parseArgv(
    {
      args: argv,
      options: { runs: { type: "string", default: "10" }, json: { type: "string" } },
      allowPositionals: true,
    },
    fail,
  );
  for (const token of tokens) {
    if (token.kind === "option-terminator") break;
    if (token.kind === "positional") fail(`unknown argument ${token.value}`);
  }
  const terminated = tokens.some((token) => token.kind === "option-terminator");
  if (terminated && positionals.length === 0) fail("no command after --");
  return {
    runs: positiveInteger("--runs", values.runs, fail),
    json: values.json === undefined ? undefined : measuredDataPath(values.json),
    command: terminated ? positionals : DEFAULT_COMMAND,
  };
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

const round = (ms: number): number => Math.round(ms * 1000) / 1000;

// Median, never the mean: one page-cache miss or scheduler hiccup must not move the reported
// number, since CI compares this figure against the base branch on the same shared runner.
export function summarize(durationsMs: number[]): Summary {
  const sorted = [...durationsMs].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  const median =
    sorted.length % 2 === 1 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
  return {
    medianMs: round(median),
    minMs: round(sorted[0]),
    maxMs: round(sorted[sorted.length - 1]),
  };
}

function main(): void {
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

  const record: BenchRecord = {
    command: options.command,
    runs: options.runs,
    ...summarize(timings),
  };
  const line = `${JSON.stringify(record)}\n`;
  if (options.json !== undefined) {
    mkdirSync(dirname(options.json), { recursive: true });
    writeFileSync(options.json, line);
  }
  process.stdout.write(line);
}

if (import.meta.main) main();
