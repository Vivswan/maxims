// Entry for `bun run test:container`. The hermetic check of the built image runs here, not in
// the test suite: the suite's launcher swaps HOME, which is where rootless podman keeps its
// image store and docker keeps its contexts, so a run from inside the suite would not see the
// image this process just built.
import { writeSync } from "node:fs";
import {
  buildImage,
  CONTAINER_HOME,
  CONTAINER_WORK,
  detectRuntime,
  HERMETIC_PROBE_OK,
  hermeticProbe,
  iec,
  imageSize,
  REQUIRE_RUNTIME_ENV,
  type RunResult,
  renderBuildSummary,
  runInContainer,
  skipNotice,
} from "../tests/container/runner.ts";
import {
  HARNESS_SMOKE_CLIS,
  type HarnessSmokeCli,
  readSuiteEvidence,
  type SmokeRowResult,
} from "../tests/container/tier.ts";
import { writeStepSummary } from "./nightly/report.ts";

const IMAGE = "maxims-container-tier:local";
const PROBE = hermeticProbe({
  home: CONTAINER_HOME,
  work: CONTAINER_WORK,
  networkDir: "/sys/class/net",
});

// A stream write on a pipe queues what the pipe cannot take at once, and the blocking runtime
// calls and process.exit that follow never flush the queue: the job log kept the first 64 KiB of
// the suite output and lost bun's summary. A pipe left non-blocking answers EAGAIN while full, so
// the loop waits for the reader instead of failing.
function writeAllSync(fd: 1 | 2, text: string): void {
  const bytes = Buffer.from(text, "utf8");
  let offset = 0;
  while (offset < bytes.length) {
    try {
      offset += writeSync(fd, bytes, offset, bytes.length - offset);
    } catch (error) {
      if (!(error instanceof Error && "code" in error && error.code === "EAGAIN")) throw error;
      Bun.sleepSync(1);
    }
  }
}

function report(step: string, started: number, result: RunResult): string {
  writeAllSync(1, result.stdout);
  writeAllSync(2, result.stderr);
  const seconds = ((performance.now() - started) / 1000).toFixed(1);
  writeAllSync(1, `container tier: ${step} exit ${result.exitCode} in ${seconds}s\n`);
  return seconds;
}

function rowLine(cli: HarnessSmokeCli, row: SmokeRowResult): string {
  const time = "ms" in row && row.ms !== null ? ` in ${(row.ms / 1000).toFixed(1)}s` : "";
  return `container tier: harness smoke ${cli} ${row.status}${time}\n`;
}

const NOT_PASSING_MEANS: Record<Exclude<SmokeRowResult["status"], "pass">, string> = {
  skip: "skip means the tier marker did not reach the suite",
  fail: "fail means the row ran and failed",
  absent: "absent means bun did not collect the smoke file",
};

// The suite passing is not enough: the real-CLI rows skip by name outside the tier, and a suite
// that never printed its summary stopped early, so both are read back out of the captured output.
function smokeReasons(output: string): string[] {
  const evidence = readSuiteEvidence(output);
  for (const cli of HARNESS_SMOKE_CLIS) writeAllSync(1, rowLine(cli, evidence.rows[cli]));
  const reasons: string[] = [];
  const notPassing = HARNESS_SMOKE_CLIS.flatMap((cli) => {
    const { status } = evidence.rows[cli];
    return status === "pass" ? [] : [{ cli, status }];
  });
  if (notPassing.length > 0) {
    const rows = notPassing.map(({ cli, status }) => `${cli} ${status}`).join(", ");
    const meanings = new Set(notPassing.map(({ status }) => NOT_PASSING_MEANS[status]));
    reasons.push(`harness smoke rows not passing: ${rows} (${[...meanings].join("; ")})`);
  }
  if (evidence.summary === null) {
    reasons.push("the suite printed no summary line, so it did not run to the end");
  } else {
    const { tests, files } = evidence.summary;
    writeAllSync(1, `container tier: suite ran ${tests} tests across ${files} files\n`);
  }
  return reasons;
}

const runtime = detectRuntime();
if (runtime === null) {
  if (process.env[REQUIRE_RUNTIME_ENV]) {
    writeAllSync(2, `container tier: no container runtime, and ${REQUIRE_RUNTIME_ENV} is set\n`);
    process.exit(1);
  }
  writeAllSync(1, `${skipNotice()}\n`);
  process.exit(0);
}

let started = performance.now();
const build = buildImage(runtime, IMAGE);
const buildSeconds = report(`image build (${IMAGE})`, started, build);
if (build.exitCode !== 0) process.exit(build.exitCode);
const bytes = imageSize(runtime, IMAGE);
writeAllSync(1, `container tier: image size ${iec(bytes)} (${bytes} bytes)\n`);
writeStepSummary(renderBuildSummary(buildSeconds, bytes), process.env);

started = performance.now();
const suite = runInContainer(runtime, {
  image: IMAGE,
  cmd: ["bun", "run", "test"],
  env: { NO_COLOR: "1" },
});
report("suite inside the container", started, suite);
const reasons = smokeReasons(`${suite.stdout}${suite.stderr}`);

// Two probe runs: the first writes a marker into HOME, the second must not find it.
let hermetic = 0;
for (const run of [1, 2]) {
  started = performance.now();
  const probe = runInContainer(runtime, { image: IMAGE, cmd: PROBE });
  if (probe.exitCode !== 0 || probe.stdout !== HERMETIC_PROBE_OK) hermetic = 1;
  report(`hermetic probe run ${run}`, started, probe);
}

for (const reason of reasons) writeAllSync(2, `container tier: ${reason}\n`);
process.exit(suite.exitCode !== 0 ? suite.exitCode : reasons.length > 0 ? 1 : hermetic);
