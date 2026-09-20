// Hermetic test launcher: every `bun test` run goes through here so a test can never touch the
// developer's real home, harness configs, or git identity. tests/shared/preload.ts is the other
// half: it refuses to run without the MAXIMS_TEST_LAUNCHER marker set below.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const repoRoot = resolve(import.meta.dir, "..");
const home = mkdtempSync(join(tmpdir(), "maxims-test-home-"));
const env: Record<string, string> = {};
for (const [key, value] of Object.entries(process.env)) {
  if (value === undefined || key.startsWith("GIT_")) continue;
  env[key] = value;
}
Object.assign(env, {
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

const removeHome = (): void => rmSync(home, { recursive: true, force: true });

// The test process is spawned asynchronously so a SIGINT or SIGTERM aimed at the launcher still
// reaches the handlers below and removes the temp HOME; a synchronous spawn would block them.
const proc = Bun.spawn(["bun", "test", ...process.argv.slice(2)], {
  cwd: repoRoot,
  env,
  stdio: ["inherit", "inherit", "inherit"],
});
for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"] as const) {
  process.on(signal, () => {
    proc.kill(signal);
    removeHome();
    process.exit(130);
  });
}

let exitCode = 1;
try {
  exitCode = await proc.exited;
} finally {
  removeHome();
}
process.exit(exitCode);
