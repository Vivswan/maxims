import { readFile } from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { DEFAULT_GIT_REF, type SourceFrom } from "../../contracts/source.ts";
import type { MemoryName } from "../../memory/contract.ts";
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
  type SourceEntry,
  type SourceIntent,
  type State,
} from "../../state/schema.ts";
import type { Change } from "../../util/change.ts";
import { ExitCode, MaximsError } from "../../util/exit-codes.ts";
import { assertInsideRoot } from "../../util/fs.ts";
import type { CliIo } from "../types.ts";
import { realpathOfExistingPrefix } from "./fs-probe.ts";
import { INTENT_DEFAULTS } from "./options.ts";
import { effectiveNames, sourceIdentity } from "./sources.ts";

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
  const rel = realRelative(projectRoot, path);
  return rel === "" || (rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}

function realRelative(projectRoot: string, path: string): string {
  return relative(realpathOfExistingPrefix(projectRoot), realpathOfExistingPrefix(path));
}

// The path the manifest records: relative to the REAL project root from the REAL source path (an
// alias symlink outside the checkout that points inside it names the inside directory), with
// `/` as the separator on every platform so a lock written on Windows replays elsewhere, and
// always starting with `./` so its key cannot read like a GitHub key (`@owner/repo`) or a URL
// whatever the directory is called.
function projectRelative(projectRoot: string, path: string): string {
  const rel = realRelative(projectRoot, path);
  return rel === "" ? "." : `./${rel.split(sep).join("/")}`;
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

// Whether the committed lock lists this source, under any spelling of its identity: an `add -p`
// of such a source records it shared, as `install` records every lock entry, so the team's entry
// stays where the team put it.
export async function listedInLock(projectRoot: string, from: SourceFrom): Promise<boolean> {
  const lock = manifestOrUsage(await readProjectLock(projectRoot));
  if (lock === null) return false;
  const identity = sourceIdentity(from);
  return Object.values(lock.sources).some(
    (source) => sourceIdentity(sourceFromLock(source, projectRoot)) === identity,
  );
}

// The lock rewrite an edit of this project's intent calls for. This machine edits only the
// entries it owns here (the project-scope sources state held for this root before or after the
// edit, shared or not) and leaves a teammate's entries as the file holds them, since a clone that
// has not run `install` knows nothing of them; so a private add beside a committed lock changes
// nothing, a shared add joins the team's entries, an unshare or a removal takes its own out, and a
// lock that ends up naming nothing is deleted. The `disabled` copy is merged the same way: the
// names this project's shared sources provide follow state, the rest stay. The bytes are read
// back through the lock parser before they are planned: a directory name the manifest grammar
// refuses (a marker-unsafe segment) would otherwise leave a committed file the next `install`
// rejects. Null when the file would not change.
export async function projectLockChange(
  projectRoot: string,
  previous: State,
  next: State,
  io: Pick<CliIo, "home" | "env">,
): Promise<Change | null> {
  const path = assertInsideRoot(projectRoot, projectLockPath(projectRoot));
  const current = manifestOrUsage(await readProjectLock(projectRoot));
  const owned = [...ownedEntries(previous, projectRoot), ...ownedEntries(next, projectRoot)];
  // A teammate's `@Acme/rules` is this machine's `@acme/rules`: the lock entry is ours to edit.
  const ours = new Set(owned.map(([, entry]) => sourceIdentity(entry.intent.from)));
  // The names this machine's shared sources provide, before or after the edit: their disabled state
  // in the lock is this machine's to say. Every other name stays as the file has it: a private
  // source providing a name a teammate switched off says nothing about the teammate's choice.
  const ownedNames = new Set<MemoryName>();
  for (const [, entry] of owned) {
    if (entry.intent.shared !== true) continue;
    for (const name of await effectiveNames(entry, io)) ownedNames.add(name);
  }
  const share = await sharedProjection(next, projectRoot, io);
  const sources: Record<string, LockSource> = Object.create(null);
  const disabled = new Set<MemoryName>();
  if (current !== null) {
    for (const [lockKey, source] of Object.entries(current.sources)) {
      if (!ours.has(sourceIdentity(sourceFromLock(source, projectRoot)))) {
        sources[lockKey] = source;
      }
    }
    for (const name of current.disabled ?? []) {
      if (!ownedNames.has(name)) disabled.add(name);
    }
  }
  for (const [lockKey, source] of Object.entries(share.sources)) {
    if (Object.hasOwn(sources, lockKey)) {
      throw new MaximsError(
        ExitCode.Usage,
        `${lockKey} in ${path} names a source this machine holds under another key`,
        { hint: "run maxims install to replay the lock first" },
      );
    }
    sources[lockKey] = source;
  }
  for (const name of share.disabled) disabled.add(name);
  if (Object.keys(sources).length === 0) {
    return current === null ? null : { kind: "delete", path };
  }
  const lock: ProjectLock = {
    version: PROJECT_LOCK_VERSION,
    sources,
    ...(disabled.size === 0 ? {} : { disabled: [...disabled].sort() }),
  };
  const content = serializeProjectLock(lock);
  if (current !== null && serializeProjectLock(current) === content) return null;
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

// The lock rewrite an edit of one entry calls for: the entry's own project's, when it is a project
// entry, else none.
export async function lockChanges(
  entry: SourceEntry,
  previous: State,
  next: State,
  io: Pick<CliIo, "home" | "env">,
): Promise<Change[]> {
  const { destination } = entry.intent;
  if (destination.scope !== "project") return [];
  const change = await projectLockChange(destination.root, previous, next, io);
  return change === null ? [] : [change];
}

// The project-scope entries recorded for this root: the lock entries this machine writes and
// takes away.
function ownedEntries(state: State, projectRoot: string): [string, SourceEntry][] {
  return Object.entries(state.sources).filter(([, entry]) => {
    const { destination } = entry.intent;
    return destination.scope === "project" && destination.root === projectRoot;
  });
}

type SharedProjection = {
  sources: Record<string, LockSource>;
  disabled: MemoryName[];
};

// What this project shares: the entries recorded for this root and marked shared, keyed as the
// lock keys them, and of the project's disabled names those such an entry provides.
async function sharedProjection(
  state: State,
  projectRoot: string,
  io: Pick<CliIo, "home" | "env">,
): Promise<SharedProjection> {
  const sources: Record<string, LockSource> = Object.create(null);
  const names = new Set<MemoryName>();
  for (const [stateKey, entry] of Object.entries(state.sources)) {
    const { destination } = entry.intent;
    if (destination.scope !== "project" || destination.root !== projectRoot) continue;
    if (entry.intent.shared !== true) continue;
    const source = lockSource(entry.intent, projectRoot);
    // `add --share` and `share` refuse a source outside the checkout, so only a hand-edited state
    // reaches this; it is left out rather than written as a path no teammate can follow.
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
    for (const name of await effectiveNames(entry, io)) names.add(name);
  }
  const disabled = (state.disabled?.project?.[projectRoot] ?? []).filter((name) => names.has(name));
  return { sources, disabled };
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
