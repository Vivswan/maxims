import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { DEFAULT_GIT_REF, type SourceFrom } from "../../contracts/source.ts";
import {
  type LockSource,
  PROJECT_LOCK_RELATIVE_PATH,
  type ProjectLock,
  parseProjectLock,
} from "../../state/project-lock.ts";
import { canonicalSourceKey } from "../../state/schema.ts";
import type { Change } from "../../util/change.ts";
import { ExitCode, MaximsError } from "../../util/exit-codes.ts";
import { isInside, realpathOfExistingPrefix } from "../../util/fs.ts";

export type LoadedProjectLock =
  | { kind: "absent" }
  | { kind: "parsed"; lock: ProjectLock; keys: string[] }
  | { kind: "corrupt"; path: string; issues: string[] };

export function projectLockPath(projectRoot: string): string {
  return join(projectRoot, PROJECT_LOCK_RELATIVE_PATH);
}

// `keys` are the state keys the entries stand for, so a lock entry and its state entry are found
// by one string. The manifest is committed and edited by teammates, so a shape error, or an entry
// this checkout cannot honor (a local path leaving it), is reported whole rather than installing
// the entries that happened to parse. `planned` holds the changes a run has planned and not yet
// applied: a rewrite or deletion of the lock among them is the lock this run judges, so a removal
// never reports the very entry it is taking out as one this machine lacks.
export async function readProjectLock(
  projectRoot: string,
  planned: readonly Change[] = [],
): Promise<LoadedProjectLock> {
  const path = projectLockPath(projectRoot);
  const pending = planned.find((change) => change.path === path);
  if (pending?.kind === "delete") return { kind: "absent" };
  let text: string;
  if (pending?.kind === "write") {
    text = pending.content;
  } else {
    try {
      text = await readFile(path, "utf8");
    } catch (error) {
      if (error instanceof Error && "code" in error && error.code === "ENOENT")
        return { kind: "absent" };
      const detail = error instanceof Error ? error.message : String(error);
      throw new MaximsError(ExitCode.DestinationWriteFailed, `cannot read ${path}: ${detail}`, {
        cause: error,
      });
    }
  }
  const parsed = parseProjectLock(text);
  if (parsed.ok === "corrupt") return { kind: "corrupt", path, issues: parsed.issues };
  const keys: string[] = [];
  for (const source of Object.values(parsed.lock.sources)) {
    try {
      keys.push(canonicalSourceKey(sourceFromLock(source, projectRoot)));
    } catch (error) {
      if (!(error instanceof MaximsError) || error.code !== ExitCode.Usage) throw error;
      return { kind: "corrupt", path, issues: [error.message] };
    }
  }
  return { kind: "parsed", lock: parsed.lock, keys };
}

// A lock entry's source as state records it: the pin becomes the ref, a relative local path is
// anchored at the project root, must stay inside it (the lock is shared with people who have only
// the checkout), and is recorded by its real path like every local source.
export function sourceFromLock(source: LockSource, projectRoot: string): SourceFrom {
  if (source.from.type === "local") {
    const typed = resolve(projectRoot, source.from.path);
    if (!insideProject(projectRoot, typed)) {
      throw new MaximsError(
        ExitCode.Usage,
        `manifest source ${source.from.path} leaves the project root`,
      );
    }
    const path = realpathOfExistingPrefix(typed);
    return source.from.live === true
      ? { type: "local", path, live: true }
      : { type: "local", path };
  }
  return { ...source.from, ref: source.pin ?? DEFAULT_GIT_REF };
}

// Containment is judged on real paths: a source directory that is itself a symlink to somewhere
// outside the checkout is outside, whatever its name inside it says. A path that does not exist
// yet is judged by the real path of its deepest existing prefix. A source outside the checkout
// cannot be shared: a teammate's checkout has no path that reaches it.
export function insideProject(projectRoot: string, path: string): boolean {
  return isInside(realpathOfExistingPrefix(projectRoot), realpathOfExistingPrefix(path));
}

// The manifest is committed and edited by teammates, so a shape error names the file and stops
// the verb rather than installing the entries that happened to parse. Null when there is no file.
export function manifestOrUsage(lock: LoadedProjectLock): ProjectLock | null {
  switch (lock.kind) {
    case "absent":
      return null;
    case "parsed":
      return lock.lock;
    case "corrupt":
      throw new MaximsError(
        ExitCode.Usage,
        `${lock.path} is not a valid manifest: ${lock.issues.join("; ")}`,
      );
  }
}
