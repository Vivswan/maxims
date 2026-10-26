import { relative, sep } from "node:path";
import { DEFAULT_GIT_REF, isLiveLocal, type SourceFrom } from "../../contracts/source.ts";
import {
  insideProject,
  manifestOrUsage,
  projectLockPath,
  readProjectLock,
  sourceFromLock,
} from "../../engine/project-lock-read.ts";
import { sourceIdentity } from "../../engine/source-key.ts";
import type { CliIo } from "../../engine/types.ts";
import type { MemoryName } from "../../memory/contract.ts";
import { CURRENT_PROJECT_LOCK_VERSION } from "../../state/migrations/project-lock-ladder.ts";
import {
  type LockSource,
  lockSourceKey,
  type ProjectLock,
  parseProjectLock,
  serializeProjectLock,
} from "../../state/project-lock.ts";
import type { SourceEntry, SourceIntent, State } from "../../state/schema.ts";
import type { Change } from "../../util/change.ts";
import { ExitCode, MaximsError } from "../../util/exit-codes.ts";
import { assertInsideRoot, realpathOfExistingPrefix } from "../../util/fs.ts";
import { effectiveNames } from "./lookup.ts";
import { INTENT_DEFAULTS } from "./options.ts";

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

// What this machine owns in the lock: the identities of the project-scope entries recorded for
// this root before or after the edit, and the names its shared ones provide. A teammate's
// `@Acme/rules` is this machine's `@acme/rules`: the lock entry is ours to edit.
type Owned = { identities: Set<string>; names: Set<MemoryName> };

// The names this machine's shared sources provide, before or after the edit: their disabled state
// in the lock is this machine's to say. Every other name stays as the file has it: a private
// source providing a name a teammate switched off says nothing about the teammate's choice.
async function ownedHere(
  previous: State,
  next: State,
  projectRoot: string,
  io: Pick<CliIo, "home" | "installInternal">,
): Promise<Owned> {
  const owned = [...ownedEntries(previous, projectRoot), ...ownedEntries(next, projectRoot)];
  const identities = new Set(owned.map(([, entry]) => sourceIdentity(entry.intent.from)));
  const names = new Set<MemoryName>();
  for (const [, entry] of owned) {
    if (entry.intent.shared !== true) continue;
    for (const name of await effectiveNames(entry, io)) names.add(name);
  }
  return { identities, names };
}

// A teammate's entries and disabled names stay as the file holds them; this machine's own are
// dropped here and re-projected from state.
function teammateEntries(
  current: ProjectLock | null,
  projectRoot: string,
  ours: Owned,
): { sources: Record<string, LockSource>; disabled: Set<MemoryName> } {
  const sources: Record<string, LockSource> = Object.create(null);
  const disabled = new Set<MemoryName>();
  if (current === null) return { sources, disabled };
  for (const [lockKey, source] of Object.entries(current.sources)) {
    if (!ours.identities.has(sourceIdentity(sourceFromLock(source, projectRoot)))) {
      sources[lockKey] = source;
    }
  }
  for (const name of current.disabled ?? []) {
    if (!ours.names.has(name)) disabled.add(name);
  }
  return { sources, disabled };
}

// The bytes are read back through the lock parser before they are planned: a directory name the
// manifest grammar refuses (a marker-unsafe segment) would otherwise leave a committed file the
// next `install` rejects.
function assertRoundTrips(lock: ProjectLock, content: string, path: string): void {
  const back = parseProjectLock(content);
  const expected = Object.keys(lock.sources).sort();
  const got = back.ok === "parsed" ? Object.keys(back.lock.sources).sort() : [];
  if (back.ok !== "corrupt" && got.join("\n") === expected.join("\n")) return;
  const issues =
    back.ok === "corrupt" ? back.issues.join("; ") : "an entry does not survive the round trip";
  throw new MaximsError(
    ExitCode.Usage,
    `a project source cannot be written into ${path}: ${issues}`,
    { hint: "rename the directory, or install it with -g" },
  );
}

// The lock rewrite an edit of this project's intent calls for, null when the file would not change.
// This machine's own entries are re-projected from state and a teammate's stay as the file holds
// them, since a clone that has not run `install` knows nothing of them.
//   private add beside a committed lock -> nothing changes
//   shared add                          -> joins the team's entries
//   unshare or removal                  -> takes its own entry out
//   no sources left                     -> the lock file is deleted
//   disabled names                      -> this machine's shared sources' follow state, others stay
export async function projectLockChange(
  projectRoot: string,
  previous: State,
  next: State,
  io: Pick<CliIo, "home" | "installInternal">,
): Promise<Change | null> {
  const path = assertInsideRoot(projectRoot, projectLockPath(projectRoot));
  const current = manifestOrUsage(await readProjectLock(projectRoot));
  const ours = await ownedHere(previous, next, projectRoot, io);
  const share = await sharedProjection(next, projectRoot, io);
  const { sources, disabled } = teammateEntries(current, projectRoot, ours);
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
    version: CURRENT_PROJECT_LOCK_VERSION,
    sources,
    ...(disabled.size === 0 ? {} : { disabled: [...disabled].sort() }),
  };
  const content = serializeProjectLock(lock);
  if (current !== null && serializeProjectLock(current) === content) return null;
  assertRoundTrips(lock, content, path);
  return { kind: "write", path, content };
}

// The lock rewrite an edit of one entry calls for: the entry's own project's, when it is a project
// entry, else none.
export async function lockChanges(
  entry: SourceEntry,
  previous: State,
  next: State,
  io: Pick<CliIo, "home" | "installInternal">,
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
  io: Pick<CliIo, "home" | "installInternal">,
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

// The intent fields the lock carries; an optional field at its default is left out, so an entry
// says what its author typed.
function sharedFields(intent: SourceIntent): Omit<LockSource, "from" | "pin"> {
  return {
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
}

type RemoteLockFrom = Extract<LockSource["from"], { type: "github" | "git" }>;

// The repository or URL without its ref, which `pin` on the entry carries.
function remoteLockFrom(from: Exclude<SourceFrom, { type: "local" }>): RemoteLockFrom {
  if (from.type === "git") return { type: "git", url: from.url };
  const host = from.host === undefined ? {} : { host: from.host };
  return { type: "github", repo: from.repo, ...host };
}

// Null for a directory outside the checkout: no teammate's checkout can follow its path.
function lockSource(intent: SourceIntent, projectRoot: string): LockSource | null {
  const { from } = intent;
  if (from.type === "local") {
    if (!insideProject(projectRoot, from.path)) return null;
    const live = isLiveLocal(from) ? { live: true as const } : {};
    return {
      from: { type: "local", path: projectRelative(projectRoot, from.path), ...live },
      ...sharedFields(intent),
    };
  }
  const pin = from.ref === DEFAULT_GIT_REF ? {} : { pin: from.ref };
  return { from: remoteLockFrom(from), ...pin, ...sharedFields(intent) };
}
