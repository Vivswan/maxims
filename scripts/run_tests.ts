// Hermetic test launcher: every `bun test` run goes through here so a test can never touch the
// developer's real home, harness configs, or git identity. W1 extends it; this is the floor.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

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

const proc = Bun.spawnSync(["bun", "test", ...process.argv.slice(2)], {
  cwd: process.cwd(),
  env,
  stdio: ["inherit", "inherit", "inherit"],
});
rmSync(home, { recursive: true, force: true });
process.exit(proc.exitCode ?? 1);
