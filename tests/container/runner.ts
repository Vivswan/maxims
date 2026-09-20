// Container runtime access for the container test tier. This is the only file that names the
// runtimes: tests and scripts go through detectRuntime, buildImage, and runInContainer.
import { copyFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

export const RUNTIMES = ["docker", "podman"] as const;
export type Runtime = (typeof RUNTIMES)[number];

// The image's non-root user and its home; every run starts a new container from the image, so
// this directory is empty at the start of each run and discarded with the container.
export const CONTAINER_HOME = "/home/tester";
export const CONTAINER_WORK = "/work";

const CONTEXT_DIR = import.meta.dir;
export const REPO_ROOT = resolve(CONTEXT_DIR, "..", "..");
const CONTEXT_FILES = ["Dockerfile", "entrypoint.sh"] as const;
const DEPENDENCY_FILES = ["package.json", "bun.lock"] as const;

export type RunOptions = {
  image: string;
  cmd: readonly string[];
  env?: Readonly<Record<string, string>>;
  // "none" is the default so a run cannot reach the network by forgetting to say so.
  network?: "none" | "live";
};

export type RunResult = {
  exitCode: number;
  stdout: string;
  stderr: string;
};

// `<runtime> info` rather than `--version`: a docker CLI installed without a reachable daemon
// answers `--version` and then fails every build, which the tier must report as a missing
// runtime instead.
function canRunContainers(runtime: Runtime): boolean {
  if (Bun.which(runtime) === null) return false;
  const probe = Bun.spawnSync([runtime, "info"], {
    stdout: "ignore",
    stderr: "ignore",
    timeout: 15_000,
  });
  return probe.exitCode === 0;
}

export function detectRuntime(
  probe: (runtime: Runtime) => boolean = canRunContainers,
): Runtime | null {
  return RUNTIMES.find(probe) ?? null;
}

export function skipNotice(): string {
  return [
    "container tests skipped: no container runtime found.",
    "Install docker (with a running daemon) or podman to run the container tier;",
    "the fixture-based suite is unaffected.",
  ].join(" ");
}

export function buildArgv(runtime: Runtime, tag: string, contextDir: string): string[] {
  return [runtime, "build", "--tag", tag, "--file", join(contextDir, "Dockerfile"), contextDir];
}

// HOME is appended after the caller's env because the runtime applies `-e` flags in order, so the
// hermetic home cannot be overridden by a caller. `label=disable` lets the container read the
// checkout on an SELinux-enforcing host without relabeling the developer's files, which the `z`
// volume option would do; both runtimes accept it and ignore it where SELinux is absent.
export function runArgv(runtime: Runtime, options: RunOptions, repoRoot: string): string[] {
  const argv = [runtime, "run", "--rm", "--security-opt", "label=disable"];
  if ((options.network ?? "none") === "none") argv.push("--network", "none");
  for (const [key, value] of Object.entries(options.env ?? {})) {
    argv.push("-e", `${key}=${value}`);
  }
  argv.push("-e", `HOME=${CONTAINER_HOME}`);
  argv.push("--volume", `${repoRoot}:/repo:ro`);
  argv.push(options.image, ...options.cmd);
  return argv;
}

// Each step assigns before testing so a failed `ls` stops the script under `set -e` instead of
// reading as an empty listing. A container with only `lo` is what `--network none` produces;
// a DNS lookup would report the same for a network that merely lacks a resolver.
const HERMETIC_PROBE = [
  '[ "$HOME" = "$1" ]; echo home-is-expected',
  'entries=$(ls -A "$HOME"); [ -z "$entries" ]; echo home-empty',
  '[ -f "$2/package.json" ]; echo work-copied',
  ': > "$HOME/marker"; echo home-writable',
  'interfaces=$(ls "$3"); [ "$interfaces" = lo ]; echo network-none',
].join("\n");

export const HERMETIC_PROBE_OK =
  "home-is-expected\nhome-empty\nwork-copied\nhome-writable\nnetwork-none\n";

export type ProbePaths = { home: string; work: string; networkDir: string };

export function hermeticProbe({ home, work, networkDir }: ProbePaths): string[] {
  return ["sh", "-euc", HERMETIC_PROBE, "sh", home, work, networkDir];
}

// The build context is a temp dir holding only the Dockerfile, the entrypoint, and the dependency
// manifest and lockfile, so a build never uploads the working tree and needs no ignore file for
// either runtime.
export function buildImage(runtime: Runtime, tag: string): RunResult {
  const context = mkdtempSync(join(tmpdir(), "maxims-container-context-"));
  try {
    for (const name of CONTEXT_FILES) copyFileSync(join(CONTEXT_DIR, name), join(context, name));
    for (const name of DEPENDENCY_FILES) {
      copyFileSync(join(REPO_ROOT, name), join(context, name));
    }
    return run(buildArgv(runtime, tag, context));
  } finally {
    rmSync(context, { recursive: true, force: true });
  }
}

export function runInContainer(runtime: Runtime, options: RunOptions): RunResult {
  return run(runArgv(runtime, options, REPO_ROOT));
}

function run(argv: string[]): RunResult {
  const proc = Bun.spawnSync(argv, {
    cwd: REPO_ROOT,
    stdout: "pipe",
    stderr: "pipe",
  });
  return {
    exitCode: proc.exitCode ?? 1,
    stdout: proc.stdout.toString(),
    stderr: proc.stderr.toString(),
  };
}
