// Entry for `bun run test:container`. The hermetic check of the built image runs here, not in
// the test suite: the suite's launcher swaps HOME, which is where rootless podman keeps its
// image store and docker keeps its contexts, so a run from inside the suite would not see the
// image this process just built.
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
import { writeStepSummary } from "./nightly/report.ts";

const IMAGE = "maxims-container-tier:local";
const PROBE = hermeticProbe({
  home: CONTAINER_HOME,
  work: CONTAINER_WORK,
  networkDir: "/sys/class/net",
});

function report(step: string, started: number, result: RunResult): string {
  process.stdout.write(result.stdout);
  process.stderr.write(result.stderr);
  const seconds = ((performance.now() - started) / 1000).toFixed(1);
  process.stdout.write(`container tier: ${step} exit ${result.exitCode} in ${seconds}s\n`);
  return seconds;
}

const runtime = detectRuntime();
if (runtime === null) {
  if (process.env[REQUIRE_RUNTIME_ENV]) {
    process.stderr.write(
      `container tier: no container runtime, and ${REQUIRE_RUNTIME_ENV} is set\n`,
    );
    process.exit(1);
  }
  process.stdout.write(`${skipNotice()}\n`);
  process.exit(0);
}

let started = performance.now();
const build = buildImage(runtime, IMAGE);
const buildSeconds = report(`image build (${IMAGE})`, started, build);
if (build.exitCode !== 0) process.exit(build.exitCode);
const bytes = imageSize(runtime, IMAGE);
process.stdout.write(`container tier: image size ${iec(bytes)} (${bytes} bytes)\n`);
writeStepSummary(renderBuildSummary(buildSeconds, bytes), process.env);

started = performance.now();
const suite = runInContainer(runtime, {
  image: IMAGE,
  cmd: ["bun", "run", "test"],
  env: { NO_COLOR: "1" },
});
report("suite inside the container", started, suite);

// Two probe runs: the first writes a marker into HOME, the second must not find it.
let hermetic = 0;
for (const run of [1, 2]) {
  started = performance.now();
  const probe = runInContainer(runtime, { image: IMAGE, cmd: PROBE });
  if (probe.exitCode !== 0 || probe.stdout !== HERMETIC_PROBE_OK) hermetic = 1;
  report(`hermetic probe run ${run}`, started, probe);
}

process.exit(suite.exitCode !== 0 ? suite.exitCode : hermetic);
