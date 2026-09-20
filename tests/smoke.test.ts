// Fails if the launcher stops isolating HOME or stops cleaning up after itself: every other test
// relies on that isolation to keep the developer's real harness configs untouched, and a temp HOME
// left behind on a failed launch would pile up under the OS tmpdir unnoticed.
import { expect, test } from "bun:test";
import { readdirSync } from "node:fs";
import { join, resolve, sep } from "node:path";
import { tmpdirEnv, withTempDir } from "./shared/temp_dir.ts";

test("tests run inside the hermetic launcher with a temp HOME", () => {
  expect(process.env.MAXIMS_TEST_LAUNCHER).toBe("1");
  expect(process.env.HOME).toContain("maxims-test-home-");
});

// The launcher's signal handlers remove only its HOME, so a fixture anywhere else would outlive
// an interrupted run.
test("fixture dirs sit under the launcher HOME so its cleanup covers them", async () => {
  await withTempDir((dir) => {
    expect(dir.startsWith(`${process.env.HOME}${sep}`)).toBe(true);
  });
});

test("a launcher that cannot spawn the test process leaves no temp HOME behind", async () => {
  await withTempDir(async (scratch) => {
    const env: Record<string, string> = {};
    for (const [key, value] of Object.entries(process.env)) {
      if (value !== undefined && key !== "MAXIMS_TEST_LAUNCHER") env[key] = value;
    }
    env.PATH = join(scratch, "empty-path");
    Object.assign(env, tmpdirEnv(scratch));
    const proc = Bun.spawn(
      [process.execPath, resolve(import.meta.dir, "..", "scripts", "run_tests.ts")],
      {
        env,
        stdout: "pipe",
        stderr: "pipe",
      },
    );
    const exitCode = await proc.exited;
    expect(exitCode).not.toBe(0);
    expect(readdirSync(scratch)).toEqual([]);
  });
});
