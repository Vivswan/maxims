import { readFileSync, realpathSync } from "node:fs";
import { mkdtemp, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { ExitCode, MaximsError } from "../../util/exit-codes.ts";
import type { SymlinkSupport } from "../types.ts";

// Only "nothing is there" reads as absent; a probe that could not look (EACCES, EIO) is exit 4,
// so an unreadable store or rule file is never reported as an empty one.
export function readTextIfPresent(path: string): string | null {
  try {
    return readFileSync(path, "utf8");
  } catch (cause) {
    if (isAbsent(cause)) return null;
    throw cannotInspect(path, cause);
  }
}

function isAbsent(cause: unknown): boolean {
  const code = (cause as NodeJS.ErrnoException).code;
  return code === "ENOENT" || code === "ENOTDIR";
}

function cannotInspect(path: string, cause: unknown): MaximsError {
  const detail = cause instanceof Error ? cause.message : String(cause);
  return new MaximsError(ExitCode.DestinationWriteFailed, `cannot inspect ${path}: ${detail}`, {
    cause,
  });
}

// The real path of a location that may not exist yet: its deepest existing prefix resolved, the
// rest appended as typed. Only "nothing is there" walks up; a prefix that exists but cannot be
// inspected is exit 4, never a path verdict.
export function realpathOfExistingPrefix(path: string): string {
  let prefix = path;
  const tail: string[] = [];
  for (;;) {
    try {
      return join(realpathSync(prefix), ...tail.reverse());
    } catch (cause) {
      const code = (cause as NodeJS.ErrnoException).code;
      if (code !== "ENOENT" && code !== "ENOTDIR") throw cannotInspect(prefix, cause);
      const parent = dirname(prefix);
      if (parent === prefix) return path;
      tail.push(basename(prefix));
      prefix = parent;
    }
  }
}

// Whether this process may create symlinks, learned by creating one in a scratch directory that
// is removed on every path. The scratch lives under the OS temp dir, not the maxims home, so a
// dry run that asks creates nothing under the home.
export async function probeSymlinkSupport(): Promise<SymlinkSupport> {
  const dir = await mkdtemp(join(tmpdir(), "maxims-symlink-"));
  try {
    await symlink("target", join(dir, "link"));
    return { ok: true };
  } catch (cause) {
    const code = cause instanceof Error && "code" in cause ? String(cause.code) : "";
    const detail = cause instanceof Error ? cause.message : String(cause);
    return { ok: false, reason: code === "" ? detail : `${code}: ${detail}` };
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
