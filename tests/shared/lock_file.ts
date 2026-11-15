import { utimesSync, writeFileSync } from "node:fs";

/** Writes `holder` as the lock record at `lockPath`, with the file's mtime `ageMs` in the past: staleness is the file's age, so a record alone, however old, is a live holder's lock. */
export function writeLockFile(lockPath: string, holder: Record<string, unknown>, ageMs = 0): void {
  writeFileSync(lockPath, `${JSON.stringify(holder)}\n`);
  const then = new Date(Date.now() - ageMs);
  utimesSync(lockPath, then, then);
}
