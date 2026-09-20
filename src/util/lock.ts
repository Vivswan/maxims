import { closeSync, openSync, unlinkSync, writeSync } from "node:fs";
import { link, readFile, rename, stat, unlink } from "node:fs/promises";
import { hostname } from "node:os";
import { ExitCode, MaximsError } from "./exit-codes.ts";

export type LockHolder = {
  pid: number;
  host: string;
  startedAt: string;
  argv: string[];
};

export type LockOptions = {
  waitMs?: number;
  staleMs?: number;
};

export type StolenLock = {
  holder: LockHolder | null;
  ageMs: number;
  holderAlive: boolean;
};

export type LockContext = {
  stolen: StolenLock | null;
};

export const DEFAULT_LOCK_WAIT_MS = 5000;
export const DEFAULT_LOCK_STALE_MS = 60_000;

// Age alone breaks a lock, without consulting the pid: on NFS or inside a container the pid check
// lies, and every write behind the lock is temp + rename, so a wrongly stolen lock costs at worst a
// redundant rewrite. The pid's liveness is still reported so the theft log can say which case it was.
export async function withLock<T>(
  lockPath: string,
  options: LockOptions,
  fn: (lock: LockContext) => Promise<T>,
): Promise<T> {
  const waitMs = options.waitMs ?? DEFAULT_LOCK_WAIT_MS;
  const staleMs = options.staleMs ?? DEFAULT_LOCK_STALE_MS;
  const deadline = Date.now() + waitMs;
  let stolen: StolenLock | null = null;
  let delayMs = 25;
  let ours: LockHolder | null = null;
  for (;;) {
    ours = tryCreate(lockPath);
    if (ours !== null) break;
    const holder = await readHolder(lockPath);
    const theft = await stealIfStale(lockPath, holder, staleMs);
    if (theft !== null) {
      stolen = theft;
      continue;
    }
    if (Date.now() >= deadline) throw lockedError(lockPath, holder);
    await new Promise((done) => setTimeout(done, Math.min(delayMs, deadline - Date.now())));
    delayMs = Math.min(delayMs * 2, 250);
  }
  try {
    return await fn({ stolen });
  } finally {
    await releaseOwn(lockPath, ours);
  }
}

// A holder that outlived staleMs may have been displaced by a stealer; releasing then must not
// remove the stealer's lock, so the file is unlinked only while it provably records this holder.
// An unreadable file is a replacement whose record is not written yet, and is left alone.
async function releaseOwn(lockPath: string, ours: LockHolder): Promise<void> {
  if (!sameHolder(await readHolder(lockPath), ours)) return;
  await unlink(lockPath).catch(() => undefined);
}

function sameHolder(a: LockHolder | null, b: LockHolder | null): boolean {
  return a !== null && b !== null && a.pid === b.pid && a.startedAt === b.startedAt;
}

function tryCreate(lockPath: string): LockHolder | null {
  let fd: number;
  try {
    fd = openSync(lockPath, "wx", 0o600);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") return null;
    throw new MaximsError(ExitCode.DestinationWriteFailed, `cannot create lock ${lockPath}`, {
      cause: error,
    });
  }
  const holder: LockHolder = {
    pid: process.pid,
    host: hostname(),
    startedAt: new Date().toISOString(),
    argv: process.argv,
  };
  try {
    writeSync(fd, `${JSON.stringify(holder)}\n`);
  } catch (error) {
    closeSync(fd);
    unlinkSync(lockPath);
    throw new MaximsError(ExitCode.DestinationWriteFailed, `cannot write lock ${lockPath}`, {
      cause: error,
    });
  }
  closeSync(fd);
  return holder;
}

async function readHolder(lockPath: string): Promise<LockHolder | null> {
  try {
    const parsed: unknown = JSON.parse(await readFile(lockPath, "utf8"));
    if (typeof parsed !== "object" || parsed === null) return null;
    const record = parsed as Record<string, unknown>;
    if (typeof record.pid !== "number" || typeof record.startedAt !== "string") return null;
    return {
      pid: record.pid,
      host: typeof record.host === "string" ? record.host : "",
      startedAt: record.startedAt,
      argv: Array.isArray(record.argv) ? record.argv.map(String) : [],
    };
  } catch {
    return null;
  }
}

async function lockAgeMs(lockPath: string, holder: LockHolder | null): Promise<number | null> {
  const started = holder === null ? Number.NaN : Date.parse(holder.startedAt);
  if (!Number.isNaN(started)) return Date.now() - started;
  try {
    return Date.now() - (await stat(lockPath)).mtimeMs;
  } catch {
    return null;
  }
}

// The stale file is renamed aside before the new lock is created so two stealers racing on one
// stale lock cannot both believe they removed it: only the rename's winner proceeds. The moved
// file is then aged again on its own: a faster stealer's fresh lock may have no record written
// yet, and its young mtime is what gives it away. A young file is put back (a hard link fails
// rather than clobbers a newer one) and nothing was stolen.
async function stealIfStale(
  lockPath: string,
  holder: LockHolder | null,
  staleMs: number,
): Promise<StolenLock | null> {
  const ageMs = await lockAgeMs(lockPath, holder);
  if (ageMs === null || ageMs <= staleMs) return null;
  const aside = `${lockPath}.stale-${process.pid}-${Date.now()}`;
  try {
    await rename(lockPath, aside);
  } catch {
    return null;
  }
  const movedAgeMs = await lockAgeMs(aside, await readHolder(aside));
  const grabbedFreshLock = movedAgeMs === null || movedAgeMs <= staleMs;
  if (grabbedFreshLock) await link(aside, lockPath).catch(() => undefined);
  await unlink(aside).catch(() => undefined);
  if (grabbedFreshLock) return null;
  return { holder, ageMs, holderAlive: holder !== null && pidAlive(holder.pid) };
}

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

function lockedError(lockPath: string, holder: LockHolder | null): MaximsError {
  const who =
    holder === null
      ? "an unidentified process"
      : `"${holder.argv.join(" ")}" (pid ${holder.pid} on ${holder.host}, since ${holder.startedAt})`;
  return new MaximsError(ExitCode.StoreLocked, `store is locked by ${who}`, {
    hint: `wait for it to finish, or remove ${lockPath} if that process is gone`,
  });
}
