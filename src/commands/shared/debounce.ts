import { readFileSync } from "node:fs";
import { assertInsideRoot, isAbsent, writeFileAtomic } from "../../util/fs.ts";
import type { HomePaths } from "../../util/home.ts";

export const QUIET_DEBOUNCE_MS = 60_000;

// The stamp's text is the clock that wrote it, so the debounce window and the age `doctor`
// reports are judged by the one clock; the file's mtime is the filesystem's clock, and another
// machine's on a synced home. A stamp that is there but cannot be read is told from one that was
// never written, so `doctor` reports the read failure and the debounce fails open on both.
export type LastSync =
  | { kind: "at"; at: Date }
  | { kind: "absent" }
  | { kind: "unreadable"; reason: string };

// Maxims writes the stamp, so text that is not a time is a stamp nobody can read, not a machine
// that never synced; the next sync rewrites it.
export function readLastSync(paths: HomePaths): LastSync {
  let text: string;
  try {
    text = readFileSync(paths.lastSync, "utf8");
  } catch (error) {
    if (isAbsent(error)) return { kind: "absent" };
    return { kind: "unreadable", reason: error instanceof Error ? error.message : String(error) };
  }
  const written = Date.parse(text.trim());
  if (Number.isNaN(written)) {
    return { kind: "unreadable", reason: `${paths.lastSync} does not hold a timestamp` };
  }
  return { kind: "at", at: new Date(written) };
}

// Every hook on the machine runs the same `sync --quiet`, so one stamp debounces them all: a
// second session starting inside the window does no work and reads no state.
export function isDebounced(paths: HomePaths, now: Date): boolean {
  const stamp = readLastSync(paths);
  if (stamp.kind !== "at") return false;
  const age = now.getTime() - stamp.at.getTime();
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
