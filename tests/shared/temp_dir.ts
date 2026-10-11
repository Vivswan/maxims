import { realpathSync } from "node:fs";
import { withScratchDir } from "../../scripts/lib/scratch.ts";

// Fixtures nest under the launcher's temp HOME, never directly under tmpdir: the launcher removes
// that whole HOME when the test process dies by SIGKILL, and a test that derives paths from HOME
// agrees with one that reads MAXIMS_HOME on the same sandbox.
//
// The HOME is resolved to its real path: tmpdir is a symlink on macOS (/var -> /private/var) and
// a short name on Windows (RUNNER~1), so a fixture path the CLI resolves would otherwise never
// equal the one the test spelled.
export function launcherHome(): string {
  const home = process.env.HOME;
  if (home === undefined) throw new Error("the test launcher must set HOME");
  return realpathSync.native(home);
}

export function withTempDir<T>(fn: (dir: string) => Promise<T> | T): Promise<T> {
  return withScratchDir("maxims-fixture-", fn, launcherHome());
}

export function withTempHome<T>(fn: (home: string) => Promise<T> | T): Promise<T> {
  return withScratchDir(
    "maxims-home-",
    async (home) => {
      const previous = process.env.MAXIMS_HOME;
      process.env.MAXIMS_HOME = home;
      try {
        return await fn(home);
      } finally {
        if (previous === undefined) delete process.env.MAXIMS_HOME;
        else process.env.MAXIMS_HOME = previous;
      }
    },
    launcherHome(),
  );
}

// A child's os.tmpdir() reads TMPDIR on POSIX but TEMP, then TMP, on Windows; a test that watches
// where a child puts its throwaway homes has to move all three.
export function tmpdirEnv(dir: string): Record<string, string> {
  return { TMPDIR: dir, TEMP: dir, TMP: dir };
}
