import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { join } from "node:path";

// Both helpers nest under the launcher's temp HOME rather than directly under tmpdir: the
// launcher's signal handlers remove only that HOME, so a fixture placed beside it would outlive an
// interrupted run, and a test that derives paths from HOME and one that reads MAXIMS_HOME agree on
// the same sandbox. The HOME is resolved to its real path because the OS tmpdir it sits under is
// a symlink on macOS (/var -> /private/var) and a short name on Windows (RUNNER~1), and a fixture
// path the CLI resolves would otherwise never equal the one the test spelled.
export function launcherHome(): string {
  const home = process.env.HOME;
  if (home === undefined) throw new Error("the test launcher must set HOME");
  return realpathSync.native(home);
}

export async function withTempDir<T>(fn: (dir: string) => Promise<T> | T): Promise<T> {
  const dir = mkdtempSync(join(launcherHome(), "maxims-fixture-"));
  try {
    return await fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

export async function withTempHome<T>(fn: (home: string) => Promise<T> | T): Promise<T> {
  const previous = process.env.MAXIMS_HOME;
  const home = mkdtempSync(join(launcherHome(), "maxims-home-"));
  process.env.MAXIMS_HOME = home;
  try {
    return await fn(home);
  } finally {
    if (previous === undefined) delete process.env.MAXIMS_HOME;
    else process.env.MAXIMS_HOME = previous;
    rmSync(home, { recursive: true, force: true });
  }
}

// A child's os.tmpdir() reads TMPDIR on POSIX but TEMP, then TMP, on Windows; a test that watches
// where a child puts its throwaway homes has to move all three.
export function tmpdirEnv(dir: string): Record<string, string> {
  return { TMPDIR: dir, TEMP: dir, TMP: dir };
}
