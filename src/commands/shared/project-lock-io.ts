import { readFile } from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import {
  type LockSource,
  lockSourceKey,
  PROJECT_LOCK_RELATIVE_PATH,
  PROJECT_LOCK_VERSION,
  type ProjectLock,
  parseProjectLock,
  serializeProjectLock,
} from "../../state/project-lock.ts";
import {
  canonicalSourceKey,
  DEFAULT_GIT_REF,
  type SourceFrom,
  type SourceIntent,
  type State,
} from "../../state/schema.ts";
import type { Change } from "../../util/change.ts";
import { ExitCode, MaximsError } from "../../util/exit-codes.ts";
import { assertInsideRoot } from "../../util/fs.ts";
import { realpathOfExistingPrefix } from "./fs-probe.ts";
import { INTENT_DEFAULTS } from "./options.ts";

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
// the entries that happened to parse.
export async function readProjectLock(projectRoot: string): Promise<LoadedProjectLock> {
  const path = projectLockPath(projectRoot);
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT")
      return { kind: "absent" };
    throw new MaximsError(ExitCode.DestinationWriteFailed, `cannot read ${path}`, { cause: error });
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
// yet is judged by the real path of its deepest existing prefix.
function insideProject(projectRoot: string, path: string): boolean {
  const rel = realRelative(projectRoot, path);
  return rel === "" || (rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}

function realRelative(projectRoot: string, path: string): string {
  return relative(realpathOfExistingPrefix(projectRoot), realpathOfExistingPrefix(path));
}

// The path the manifest records: relative to the REAL project root from the REAL source path (an
// alias symlink outside the checkout that points inside it names the inside directory), with
// `/` as the separator on every platform so a lock written on Windows replays elsewhere.
function projectRelative(projectRoot: string, path: string): string {
  const rel = realRelative(projectRoot, path);
  return rel === "" ? "." : rel.split(sep).join("/");
}

// The projection of this project's intent: every project-scope source in state whose path, for a
// local source, lies inside it (a path elsewhere names one machine), plus the project's disabled
// names; or a deletion when there is nothing to project, so "no manifest" keeps its one meaning.
// The bytes are read back through the lock parser before they are planned: a directory name the
// manifest grammar refuses (a drive-relative `a:rules`, a leading space, a bare `__proto__`)
// would otherwise leave a committed file the next `install` rejects.
export function projectLockChange(projectRoot: string, state: State): Change {
  const path = assertInsideRoot(projectRoot, projectLockPath(projectRoot));
  const lock = projectLockFrom(state, projectRoot);
  const empty = Object.keys(lock.sources).length === 0 && (lock.disabled ?? []).length === 0;
  if (empty) return { kind: "delete", path };
  const content = serializeProjectLock(lock);
  const back = parseProjectLock(content);
  const expected = Object.keys(lock.sources).sort();
  const got = back.ok === "parsed" ? Object.keys(back.lock.sources).sort() : [];
  if (back.ok === "corrupt" || got.join("\n") !== expected.join("\n")) {
    const issues =
      back.ok === "corrupt" ? back.issues.join("; ") : "an entry does not survive the round trip";
    throw new MaximsError(
      ExitCode.Usage,
      `a project source cannot be written into ${path}: ${issues}`,
      { hint: "rename the directory, or install it with -g" },
    );
  }
  return { kind: "write", path, content };
}

// The serializer sorts, so two machines write the same bytes.
export function projectLockFrom(state: State, projectRoot: string): ProjectLock {
  const sources: Record<string, LockSource> = Object.create(null);
  for (const [stateKey, entry] of Object.entries(state.sources)) {
    if (entry.intent.destination.scope !== "project") continue;
    const source = lockSource(entry.intent, projectRoot);
    if (source === null) continue;
    const key = lockSourceKey(source);
    if (Object.hasOwn(sources, key)) {
      throw new MaximsError(
        ExitCode.Usage,
        `${stateKey} and another project source both project to the manifest key ${key}`,
        { hint: "move one of them to the user scope with add -g" },
      );
    }
    sources[key] = source;
  }
  const disabled = state.disabled?.project?.[projectRoot];
  return {
    version: PROJECT_LOCK_VERSION,
    sources,
    ...(disabled === undefined ? {} : { disabled }),
  };
}

function lockSource(intent: SourceIntent, projectRoot: string): LockSource | null {
  const shared = {
    select: intent.select,
    ...(Object.keys(intent.rename).length === 0 ? {} : { rename: intent.rename }),
    rule: intent.rule,
    harnesses: intent.harnesses,
    ...(intent.memoryPath === INTENT_DEFAULTS.memoryPath ? {} : { memoryPath: intent.memoryPath }),
    ...(intent.fullDepth === INTENT_DEFAULTS.fullDepth ? {} : { fullDepth: intent.fullDepth }),
    ...(intent.copy === INTENT_DEFAULTS.copy ? {} : { copy: intent.copy }),
    ...(intent.paths === undefined ? {} : { paths: intent.paths }),
    ...(intent.auth ? { auth: true } : {}),
    ...(intent.allowHidden === undefined ? {} : { allowHidden: intent.allowHidden }),
  };
  const from = intent.from;
  if (from.type === "local") {
    if (!insideProject(projectRoot, from.path)) return null;
    const live = from.live === true ? { live: true as const } : {};
    return {
      from: { type: "local", path: projectRelative(projectRoot, from.path), ...live },
      ...shared,
    };
  }
  const pin = from.ref === DEFAULT_GIT_REF ? {} : { pin: from.ref };
  const lockFrom =
    from.type === "github"
      ? {
          type: "github" as const,
          repo: from.repo,
          ...(from.host === undefined ? {} : { host: from.host }),
        }
      : { type: "git" as const, url: from.url };
  return { from: lockFrom, ...pin, ...shared };
}
