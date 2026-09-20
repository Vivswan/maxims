// Fails if the nightly container job could pass while its build metric was never written: the
// tier's entry must append the build time and image size to GITHUB_STEP_SUMMARY after a
// successful build, a runtime that cannot report the size must stop the tier rather than write a
// zero, and a runner with no runtime must fail when the job says the runtime is required.
import { describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  iec,
  imageSize,
  REPO_ROOT,
  REQUIRE_RUNTIME_ENV,
  type RunResult,
  renderBuildSummary,
} from "../container/runner.ts";
import { withTempDir } from "../shared/temp_dir.ts";

const answer = (stdout: string, exitCode = 0, stderr = ""): RunResult => ({
  exitCode,
  stdout,
  stderr,
});

test("imageSize asks the runtime for the size and refuses anything but a positive integer", () => {
  const seen: string[][] = [];
  const exec = (argv: string[]): RunResult => {
    seen.push(argv);
    return answer("812345\n");
  };
  expect(imageSize("podman", "example:tag", exec)).toBe(812345);
  expect(seen).toEqual([["podman", "image", "inspect", "example:tag", "--format", "{{.Size}}"]]);
  const refused: [RunResult, string][] = [
    [answer("", 1, "Error: No such image: example:tag"), 'exit 1 with "": Error: No such image'],
    [answer("<no value>\n"), 'exit 0 with "<no value>"'],
    [answer("0\n"), 'exit 0 with "0"'],
  ];
  for (const [result, message] of refused) {
    expect(() => imageSize("docker", "example:tag", () => result)).toThrow(message);
  }
});

const sizes: [number, string][] = [
  [512, "512 B"],
  [812345, "793 KiB"],
  [10_485_760, "10 MiB"],
  [1_234_567_890, "1.1 GiB"],
];

test.each(sizes)("iec(%p) is %p", (bytes, text) => {
  expect(iec(bytes)).toBe(text);
});

const FAKE_DOCKER = [
  "#!/bin/sh",
  'case "$1" in',
  "  info) exit 0 ;;",
  "  build) exit 0 ;;",
  "  image) echo 812345 ;;",
  "  run) printf 'home-is-expected\\nhome-empty\\nwork-copied\\nhome-writable\\nnetwork-none\\n' ;;",
  '  *) echo "unexpected: $*" >&2; exit 9 ;;',
  "esac",
  "",
].join("\n");

describe("the tier's entry with a fake runtime", () => {
  test("appends the build time and image size to the step summary after the build", async () => {
    await withTempDir((dir) => {
      const bin = join(dir, "bin");
      mkdirSync(bin);
      writeFileSync(join(bin, "docker"), FAKE_DOCKER);
      chmodSync(join(bin, "docker"), 0o755);
      const summary = join(dir, "summary.md");
      writeFileSync(summary, "");
      const proc = Bun.spawnSync([process.execPath, "scripts/container_tests.ts"], {
        cwd: REPO_ROOT,
        env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, GITHUB_STEP_SUMMARY: summary },
        stdout: "pipe",
        stderr: "pipe",
      });
      expect({ exitCode: proc.exitCode, stderr: proc.stderr.toString() }).toEqual({
        exitCode: 0,
        stderr: "",
      });
      const written = readFileSync(summary, "utf8");
      const seconds = /\| Image build \| (\d+\.\d) s \|/.exec(written)?.[1] ?? "(missing)";
      expect(written).toBe(renderBuildSummary(seconds, 812345));
      expect(written).toContain("| Image size | 793 KiB (812345 bytes) |");
    });
  });
});

test("the tier's entry fails without a runtime when the runtime is required", async () => {
  await withTempDir((dir) => {
    const emptyPath = join(dir, "empty-path");
    mkdirSync(emptyPath);
    const proc = Bun.spawnSync([process.execPath, "scripts/container_tests.ts"], {
      cwd: REPO_ROOT,
      env: { ...process.env, PATH: emptyPath, [REQUIRE_RUNTIME_ENV]: "1" },
      stdout: "pipe",
      stderr: "pipe",
    });
    expect({
      exitCode: proc.exitCode,
      stdout: proc.stdout.toString(),
      stderr: proc.stderr.toString(),
    }).toEqual({
      exitCode: 1,
      stdout: "",
      stderr: "container tier: no container runtime, and MAXIMS_REQUIRE_CONTAINER_RUNTIME is set\n",
    });
  });
});
