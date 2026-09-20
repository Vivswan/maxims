import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export async function withTempDir<T>(fn: (dir: string) => Promise<T> | T): Promise<T> {
  const dir = mkdtempSync(join(tmpdir(), "maxims-fixture-"));
  try {
    return await fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// The fresh home sits under the launcher's temp HOME rather than directly under tmpdir so a test
// that derives paths from HOME and one that reads MAXIMS_HOME agree on the same sandbox.
export async function withTempHome<T>(fn: (home: string) => Promise<T> | T): Promise<T> {
  const launcherHome = process.env.HOME;
  if (launcherHome === undefined) throw new Error("the test launcher must set HOME");
  const previous = process.env.MAXIMS_HOME;
  const home = mkdtempSync(join(launcherHome, "maxims-home-"));
  process.env.MAXIMS_HOME = home;
  try {
    return await fn(home);
  } finally {
    if (previous === undefined) delete process.env.MAXIMS_HOME;
    else process.env.MAXIMS_HOME = previous;
    rmSync(home, { recursive: true, force: true });
  }
}
