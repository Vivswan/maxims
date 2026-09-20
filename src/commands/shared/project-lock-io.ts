import { readFile } from "node:fs/promises";
import { join, relative, resolve, sep } from "node:path";
import {
  type LockSource,
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
import { assertInsideRoot } from "../../util/fs.ts";

export type LoadedProjectLock =
  | { kind: "absent" }
  | { kind: "parsed"; lock: ProjectLock; keys: string[] }
  | { kind: "corrupt"; path: string; issues: string[] };

export function projectLockPath(projectRoot: string): string {
  return join(projectRoot, PROJECT_LOCK_RELATIVE_PATH);
}

// `keys` are the state keys the entries stand for, so a lock entry and its state entry are found
// by one string: a local path, relative in the lock, is made absolute against the project root.
export async function readProjectLock(projectRoot: string): Promise<LoadedProjectLock> {
  const path = projectLockPath(projectRoot);
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT")
      return { kind: "absent" };
    throw error;
  }
  const parsed = parseProjectLock(text);
  if (parsed.ok === "corrupt") return { kind: "corrupt", path, issues: parsed.issues };
  const keys = Object.values(parsed.lock.sources).map((source) =>
    canonicalSourceKey(stateFrom(source, projectRoot)),
  );
  return { kind: "parsed", lock: parsed.lock, keys };
}

function stateFrom(source: LockSource, projectRoot: string): SourceFrom {
  if (source.from.type === "local") {
    const path = resolve(projectRoot, source.from.path);
    return source.from.live === true
      ? { type: "local", path, live: true }
      : { type: "local", path };
  }
  return { ...source.from, ref: source.pin ?? DEFAULT_GIT_REF };
}

// The projection of this project's intent: every project-scope source in state and the project's
// disabled names, or a deletion when there is nothing to project. A local source is keyed by its
// project-relative path, like its `from`, so two checkouts of the project write the same bytes.
export function projectLockChange(projectRoot: string, state: State): Change {
  const path = assertInsideRoot(projectRoot, projectLockPath(projectRoot));
  const sources: Record<string, LockSource> = {};
  for (const key of Object.keys(state.sources).sort()) {
    const entry = state.sources[key];
    if (entry === undefined || entry.intent.destination.scope !== "project") continue;
    const source = lockSource(entry.intent, projectRoot);
    const lockKey = source.from.type === "local" ? source.from.path : key;
    sources[lockKey] = source;
  }
  const disabled = state.disabled?.project?.[projectRoot] ?? [];
  if (Object.keys(sources).length === 0 && disabled.length === 0) return { kind: "delete", path };
  const lock: ProjectLock = { version: PROJECT_LOCK_VERSION, sources };
  if (disabled.length > 0) lock.disabled = disabled;
  return { kind: "write", path, content: serializeProjectLock(lock) };
}

function lockSource(intent: SourceIntent, projectRoot: string): LockSource {
  const fields = {
    select: intent.select,
    ...(Object.keys(intent.rename).length === 0 ? {} : { rename: intent.rename }),
    rule: intent.rule,
    harnesses: intent.harnesses,
    ...(intent.paths === undefined ? {} : { paths: intent.paths }),
    ...(intent.auth ? { auth: true } : {}),
    ...(intent.allowHidden === undefined ? {} : { allowHidden: intent.allowHidden }),
  };
  const from = intent.from;
  if (from.type === "local") {
    const path = relativeToProject(projectRoot, from.path);
    return {
      from: from.live === true ? { type: "local", path, live: true } : { type: "local", path },
      ...fields,
    };
  }
  const pin = from.ref === DEFAULT_GIT_REF ? {} : { pin: from.ref };
  if (from.type === "github") {
    return {
      from:
        from.host === undefined
          ? { type: "github", repo: from.repo }
          : { type: "github", repo: from.repo, host: from.host },
      ...pin,
      ...fields,
    };
  }
  return { from: { type: "git", url: from.url }, ...pin, ...fields };
}

// A local source is spelled relative to the project, always starting with `./` or `../`, so its
// key cannot read like a GitHub key (`@owner/repo`) or a URL whatever the directory is called. A
// source outside the project has no spelling a clone could follow; the closest honest record is
// the relative path git would compute, which `install` resolves back.
function relativeToProject(projectRoot: string, path: string): string {
  const rel = relative(projectRoot, resolve(path)).split(sep).join("/");
  if (rel === "") return ".";
  return rel.startsWith("../") || rel === ".." ? rel : `./${rel}`;
}
