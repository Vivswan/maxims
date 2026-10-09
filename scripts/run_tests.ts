// Hermetic test launcher: every `bun test` run goes through here so a test can never touch the
// developer's real home, harness configs, or git identity. tests/shared/preload.ts is the other
// half: it refuses to run without the MAXIMS_TEST_LAUNCHER marker set below.
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { onExit } from "signal-exit";
import { bunTestArgs } from "./lib/test_timeout.ts";
import { withScratchDir } from "./nightly/scratch.ts";

const repoRoot = resolve(import.meta.dir, "..");

function testEnv(home: string): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value === undefined || key.startsWith("GIT_")) continue;
    env[key] = value;
  }
  return Object.assign(env, {
    HOME: home,
    USERPROFILE: home,
    XDG_CONFIG_HOME: join(home, ".config"),
    MAXIMS_HOME: join(home, ".agents", "maxims"),
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_CONFIG_SYSTEM: "/dev/null",
    GIT_AUTHOR_NAME: "fixture",
    GIT_AUTHOR_EMAIL: "fixture@example.com",
    GIT_COMMITTER_NAME: "fixture",
    GIT_COMMITTER_EMAIL: "fixture@example.com",
    MAXIMS_TEST_LAUNCHER: "1",
    NO_COLOR: "1",
  });
}

// The HOME is rooted at tmpdir(), never RUNNER_TEMP: tests/smoke.test.ts finds it through TMPDIR.
// signal-exit re-raises the signal once the hooks ran, so the launcher dies by it.
const exitCode = await withScratchDir(
  "maxims-test-home-",
  async (home) => {
    const proc = Bun.spawn(
      ["bun", "test", ...bunTestArgs(process.platform, process.argv.slice(2))],
      {
        cwd: repoRoot,
        env: testEnv(home),
        stdio: ["inherit", "inherit", "inherit"],
      },
    );
    const release = onExit((_code, signal) => {
      if (signal !== null) proc.kill(signal);
    });
    try {
      return await proc.exited;
    } finally {
      release();
    }
  },
  tmpdir(),
);
process.exit(exitCode);
