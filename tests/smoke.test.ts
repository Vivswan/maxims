// Fails if the launcher stops isolating HOME or stops cleaning up after itself: every other test
// relies on that isolation to keep the developer's real harness configs untouched, and a temp HOME
// left behind on a failed launch would pile up under the OS tmpdir unnoticed.
import { expect, test } from "bun:test";
import { mkdirSync, readdirSync, realpathSync, writeFileSync } from "node:fs";
import { join, resolve, sep } from "node:path";
import { WINDOWS } from "./shared/platform.ts";
import { tmpdirEnv, withTempDir } from "./shared/temp_dir.ts";

const LAUNCHER = resolve(import.meta.dir, "..", "scripts", "run_tests.ts");

// The suite's own environment minus the launcher marker, so a nested launcher starts clean.
function launcherEnv(scratch: string): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined && key !== "MAXIMS_TEST_LAUNCHER") env[key] = value;
  }
  return Object.assign(env, tmpdirEnv(scratch));
}

test("tests run inside the hermetic launcher with a temp HOME", () => {
  expect(process.env.MAXIMS_TEST_LAUNCHER).toBe("1");
  expect(process.env.HOME).toContain("maxims-test-home-");
});

// The launcher's signal handlers remove only its HOME, so a fixture anywhere else would outlive
// an interrupted run.
test("fixture dirs sit under the launcher HOME so its cleanup covers them", async () => {
  await withTempDir((dir) => {
    expect(dir.startsWith(`${realpathSync.native(process.env.HOME ?? "")}${sep}`)).toBe(true);
  });
});

test("a launcher that cannot spawn the test process leaves no temp HOME behind", async () => {
  await withTempDir(async (scratch) => {
    const env = launcherEnv(scratch);
    env.PATH = join(scratch, "empty-path");
    const proc = Bun.spawn([process.execPath, LAUNCHER], { env, stdout: "pipe", stderr: "pipe" });
    const exitCode = await proc.exited;
    expect(exitCode).not.toBe(0);
    expect(readdirSync(scratch)).toEqual([]);
  });
});

// An interrupted launcher removes the temp HOME and dies by the signal, so a shell or a CI step
// that interrupted it sees the signal, not an exit code it would read as a test failure. The
// sleeping test file sits outside the repository, where no other run picks it up.
test.skipIf(WINDOWS)(
  "an interrupted launcher removes its temp HOME and dies by the signal",
  async () => {
    await withTempDir(async (scratch) => {
      const sleeping = join(scratch, "sleeping.test.ts");
      writeFileSync(
        sleeping,
        'import { test } from "bun:test";\ntest("sleeps", () => new Promise((r) => setTimeout(r, 20_000)), 30_000);\n',
      );
      const homes = join(scratch, "homes");
      mkdirSync(homes);
      const proc = Bun.spawn([process.execPath, LAUNCHER, sleeping], {
        env: launcherEnv(homes),
        stdout: "pipe",
        stderr: "pipe",
      });
      while (readdirSync(homes).length === 0) await new Promise((r) => setTimeout(r, 50));
      proc.kill("SIGTERM");
      await proc.exited;
      expect([proc.exitCode, proc.signalCode, readdirSync(homes)]).toEqual([null, "SIGTERM", []]);
    });
  },
);
