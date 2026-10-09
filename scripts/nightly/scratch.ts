// A scratch directory that is removed on every path out of the process: the normal return, a
// thrown error, and a signal that would otherwise skip the finally block.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { onExit } from "signal-exit";

export async function withScratchDir<T>(
  prefix: string,
  fn: (dir: string) => Promise<T> | T,
  root: string = process.env.RUNNER_TEMP ?? tmpdir(),
): Promise<T> {
  const dir = mkdtempSync(join(root, prefix));
  const remove = (): void => rmSync(dir, { recursive: true, force: true });
  // Last so a hook `fn` registers of its own runs first: a removal that throws must not skip it.
  const release = onExit(remove, { alwaysLast: true });
  try {
    return await fn(dir);
  } finally {
    release();
    remove();
  }
}
