import { readFileSync } from "node:fs";
import { assertInsideRoot, writeFileAtomic } from "../../util/fs.ts";
import type { HomePaths } from "../../util/home.ts";

export const QUIET_DEBOUNCE_MS = 60_000;

// Every hook on the machine runs the same `sync --quiet`, so one stamp debounces them all: a
// second session starting inside the window does no work and reads no state. The stamp's text is
// the clock that wrote it, so the window is judged by the same clock on both sides.
export function isDebounced(paths: HomePaths, now: Date): boolean {
  let text: string;
  try {
    text = readFileSync(paths.lastSync, "utf8");
  } catch {
    return false;
  }
  const written = Date.parse(text.trim());
  if (Number.isNaN(written)) return false;
  const age = now.getTime() - written;
  return age >= 0 && age < QUIET_DEBOUNCE_MS;
}

// Best effort and outside the lock: a stamp that fails to write only costs one redundant sync.
export function stampLastSync(home: string, paths: HomePaths, now: Date): void {
  try {
    writeFileAtomic(assertInsideRoot(home, paths.lastSync), `${now.toISOString()}\n`);
  } catch {
    // The next hook run repeats the work the stamp would have skipped; nothing else depends on it.
  }
}
