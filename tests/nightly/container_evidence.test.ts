// Fails if the nightly container log stops carrying the evidence a reader needs to tell what ran
// inside the container: the whole captured suite output through bun's own summary line (a queued
// pipe write is cut at the first buffer when the tier exits right after it).
import { expect, test } from "bun:test";
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { REPO_ROOT } from "../container/runner.ts";
import { withTempDir } from "../shared/temp_dir.ts";

// The suite run is the only `run` whose command ends in `bun run test`; the fake answers it with
// the captured file on stderr, where bun prints its results, and the probe runs with the probe's
// expected lines.
const FAKE_DOCKER = [
  "#!/bin/sh",
  'case "$1" in',
  "  info) exit 0 ;;",
  "  build) exit 0 ;;",
  "  image) echo 812345 ;;",
  "  run)",
  '    case "$*" in',
  '      *"bun run test") cat "$MAXIMS_FAKE_SUITE_STDERR" >&2 ;;',
  "      *) printf 'home-is-expected\\nhome-empty\\nwork-copied\\nhome-writable\\nnetwork-none\\n' ;;",
  "    esac ;;",
  '  *) echo "unexpected: $*" >&2; exit 9 ;;',
  "esac",
  "",
].join("\n");

const PROBE_OUTPUT = "home-is-expected\nhome-empty\nwork-copied\nhome-writable\nnetwork-none\n";

// The job log is read by a process slower than the tier's writes. A reader that starts only
// after the tier has exited is the same condition at its limit: everything the tier queued
// instead of writing is gone. Both streams go to the one log, so both are read as one here.
const SLOW_READER = [
  '{ "$@" 2>&1; echo "$?" > "$MAXIMS_TIER_EXIT_FILE"; } | { sleep 2; cat; }',
].join("\n");

type TierRun = { exitCode: number; log: string };

function runTier(dir: string, suiteStderr: string): TierRun {
  const bin = join(dir, "bin");
  mkdirSync(bin);
  writeFileSync(join(bin, "docker"), FAKE_DOCKER);
  chmodSync(join(bin, "docker"), 0o755);
  const captured = join(dir, "suite-stderr.txt");
  writeFileSync(captured, suiteStderr);
  const exitFile = join(dir, "tier-exit");
  const proc = Bun.spawnSync(
    ["sh", "-c", SLOW_READER, "sh", process.execPath, "scripts/container_tests.ts"],
    {
      cwd: REPO_ROOT,
      env: {
        ...process.env,
        PATH: `${bin}:${process.env.PATH}`,
        MAXIMS_FAKE_SUITE_STDERR: captured,
        MAXIMS_TIER_EXIT_FILE: exitFile,
        GITHUB_STEP_SUMMARY: "",
      },
      stdout: "pipe",
      stderr: "pipe",
    },
  );
  return {
    exitCode: Number(readFileSync(exitFile, "utf8").trim()),
    log: `${proc.stdout.toString()}${proc.stderr.toString()}`,
  };
}

// The tier's timing figures are the one thing that differs between runs.
function withoutSeconds(log: string): string {
  return log.replaceAll(/ in \d+\.\ds\n/g, " in <s>s\n");
}

function expectedLog(suiteStderr: string): string {
  return [
    "container tier: image build (maxims-container-tier:local) exit 0 in <s>s\n",
    "container tier: image size 793 KiB (812345 bytes)\n",
    suiteStderr,
    "container tier: suite inside the container exit 0 in <s>s\n",
    PROBE_OUTPUT,
    "container tier: hermetic probe run 1 exit 0 in <s>s\n",
    PROBE_OUTPUT,
    "container tier: hermetic probe run 2 exit 0 in <s>s\n",
  ].join("");
}

// Well past one pipe buffer (64 KiB), so a write that stops at the first buffer loses the tail.
const FILLER_LINES = 4000;

function filler(): string {
  const lines: string[] = [];
  for (let index = 0; index < FILLER_LINES; index += 1) {
    lines.push(`(pass) filler cases > case ${index}: ${"x".repeat(48)} [0.01ms]`);
  }
  return lines.join("\n");
}

test("the whole captured suite output, through bun's summary line, reaches the tier's log", async () => {
  await withTempDir((dir) => {
    const suite = `\ntests/filler.test.ts:\n${filler()}\n\nRan ${FILLER_LINES} tests across 1 file. [1.00ms]\n`;
    expect(suite.length).toBeGreaterThan(200_000);
    const run = runTier(dir, suite);
    expect({ exitCode: run.exitCode, log: withoutSeconds(run.log) }).toEqual({
      exitCode: 0,
      log: expectedLog(suite),
    });
  });
});
