import { readFile, rename } from "node:fs/promises";
import { applyChanges, type Plan } from "../util/change.ts";
import { ExitCode, MaximsError } from "../util/exit-codes.ts";
import { assertInsideRoot, ensureDir0700, type RootedPath } from "../util/fs.ts";
import { homePaths } from "../util/home.ts";
import { type StolenLock, withLock } from "../util/lock.ts";
import { VERSION } from "../version.ts";
import { type MigrationStep, migrateState, versionOf } from "./migrations/index.ts";
import { CURRENT_STATE_VERSION, parseState, type State } from "./schema.ts";

export const WRITTEN_BY = `maxims@${VERSION}`;

// `corrupt` is the lock-free reader's report of a file it could not move aside: another process
// holds the store, and that holder's own read quarantines the file. `quarantined` names the file
// that was moved, so it is never returned for a file still in place.
export type LoadedState =
  | { kind: "absent" }
  | { kind: "loaded"; state: State; migrated: boolean }
  | { kind: "newer"; version: number; path: string }
  | { kind: "corrupt"; path: string; issues: string[]; lockedBy: string }
  | { kind: "quarantined"; movedTo: string; issues: string[] };

export type WriteResult = { written: boolean };

export type ReadStateOptions = {
  migrations?: readonly MigrationStep[];
};

// `read` and `write` run while the lock is held, so a read-modify-write goes through one handle.
// `writeState` locks for its single write; `readState` is lock-free and persists a migration only
// when the lock is free at that moment.
export type StateLock = {
  readonly stolen: StolenLock | null;
  read(options?: ReadStateOptions): Promise<LoadedState>;
  write(state: State, writtenBy: string): Promise<WriteResult>;
};

export type LockMode = "manual" | "hook";

export type HookLockOutcome<T> = { kind: "ran"; value: T } | { kind: "skipped"; reason: string };

export type StateLockOptions = {
  waitMs?: number;
};

type StatePaths = { home: string; state: RootedPath; lock: string };

// What the bytes on disk call for. Only a `Mutation` touches the file (moved aside or overwritten),
// and `settle` is called from one place, `readUnderLock`, so the bytes it acts on were read while
// this process held the lock.
type Report =
  | { kind: "absent" }
  | { kind: "current"; state: State }
  | { kind: "newer"; version: number };
type Mutation = { kind: "corrupt"; issues: string[] } | { kind: "migrated"; state: State };
type Inspection = Report | Mutation;

const STATE_FILE_MODE = 0o600;

// A read outside the lock never waits for it: the holder is writing the file (a writer takes the
// lock for its single write and reads nothing), so the bytes read here may already be replaced
// and the quarantine or the write-back is left for a later read. When the lock is free the file
// is inspected again under it and only that second reading is acted on.
export async function readState(
  home: string,
  options: ReadStateOptions = {},
): Promise<LoadedState> {
  const paths = statePaths(home);
  const outside = await inspectStateFile(paths, options);
  if (!isMutation(outside)) return report(paths, outside);
  try {
    return await withLock(paths.lock, { waitMs: 0 }, () => readUnderLock(paths, options));
  } catch (error) {
    if (!isStoreLocked(error)) throw error;
    if (outside.kind === "migrated")
      return { kind: "loaded", state: outside.state, migrated: true };
    return { kind: "corrupt", path: paths.state, issues: outside.issues, lockedBy: error.message };
  }
}

export async function writeState(
  home: string,
  state: State,
  writtenBy: string,
): Promise<WriteResult> {
  return withStateLock(home, "manual", (lock) => lock.write(state, writtenBy));
}

// Manual mode waits the spec's five seconds and then fails with exit 5 naming the holder; hook mode
// never waits, because a hook that blocks would block the session start it runs inside.
export function withStateLock<T>(
  home: string,
  mode: "manual",
  fn: (lock: StateLock) => Promise<T>,
  options?: StateLockOptions,
): Promise<T>;
export function withStateLock<T>(
  home: string,
  mode: "hook",
  fn: (lock: StateLock) => Promise<T>,
  options?: StateLockOptions,
): Promise<HookLockOutcome<T>>;
export async function withStateLock<T>(
  home: string,
  mode: LockMode,
  fn: (lock: StateLock) => Promise<T>,
  options: StateLockOptions = {},
): Promise<T | HookLockOutcome<T>> {
  const paths = statePaths(home);
  await ensureDir0700(paths.home);
  const waitMs = options.waitMs ?? (mode === "hook" ? 0 : undefined);
  const run = (): Promise<T> =>
    withLock(paths.lock, { waitMs }, (context) =>
      fn({
        stolen: context.stolen,
        read: (readOptions = {}) => readUnderLock(paths, readOptions),
        write: (state, writtenBy) => writeStateFile(paths, { ...state, writtenBy }),
      }),
    );
  if (mode === "manual") return run();
  try {
    return { kind: "ran", value: await run() };
  } catch (error) {
    if (isStoreLocked(error)) return { kind: "skipped", reason: error.message };
    throw error;
  }
}

// The migration dispatch runs before `parseState`, which reports an older integer version as
// corrupt rather than due.
async function inspectStateFile(paths: StatePaths, options: ReadStateOptions): Promise<Inspection> {
  let text: string;
  try {
    text = await readFile(paths.state, "utf8");
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT")
      return { kind: "absent" };
    throw error;
  }
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    return { kind: "corrupt", issues: [`not valid JSON: ${detail}`] };
  }
  const version = versionOf(json);
  if (version !== null && version < CURRENT_STATE_VERSION) {
    return migrateDocument(json, version, options.migrations);
  }
  const parsed = parseState(json);
  if (parsed.ok === "parsed") return { kind: "current", state: parsed.state };
  if (parsed.ok === "newer") return { kind: "newer", version: parsed.version };
  return { kind: "corrupt", issues: parsed.issues };
}

// The migrated document passes the same strict parse a fresh file gets before it is written back,
// so a step that produces a bad shape quarantines the ORIGINAL bytes rather than persisting its output.
function migrateDocument(
  json: unknown,
  version: number,
  migrations: readonly MigrationStep[] | undefined,
): Inspection {
  const migration = migrateState(json, version, migrations);
  if (migration.kind === "unreachable") {
    return {
      kind: "corrupt",
      issues: [
        `version ${version} is older than any migration this maxims carries (oldest ${migration.oldest}); re-add your sources`,
      ],
    };
  }
  const parsed = parseState(migration.json);
  if (parsed.ok !== "parsed") {
    const issues =
      parsed.ok === "corrupt" ? parsed.issues : [`arrived at version ${parsed.version}`];
    return { kind: "corrupt", issues: [`after migrating from version ${version}:`, ...issues] };
  }
  return { kind: "migrated", state: { ...parsed.state, writtenBy: WRITTEN_BY } };
}

// The one caller of `settle`: it runs while the caller holds the lock, so the file a mutation moves
// aside or overwrites is the one `inspectStateFile` just read, since every writer takes the same
// lock first.
async function readUnderLock(paths: StatePaths, options: ReadStateOptions): Promise<LoadedState> {
  const inspection = await inspectStateFile(paths, options);
  return isMutation(inspection) ? settle(paths, inspection) : report(paths, inspection);
}

function isMutation(inspection: Inspection): inspection is Mutation {
  return inspection.kind === "corrupt" || inspection.kind === "migrated";
}

function report(paths: StatePaths, inspection: Report): LoadedState {
  switch (inspection.kind) {
    case "absent":
      return { kind: "absent" };
    case "current":
      return { kind: "loaded", state: inspection.state, migrated: false };
    case "newer":
      return { kind: "newer", version: inspection.version, path: paths.state };
  }
}

async function settle(paths: StatePaths, mutation: Mutation): Promise<LoadedState> {
  switch (mutation.kind) {
    case "corrupt":
      return quarantine(paths, mutation.issues);
    case "migrated":
      await writeStateFile(paths, mutation.state);
      return { kind: "loaded", state: mutation.state, migrated: true };
  }
}

async function quarantine(paths: StatePaths, issues: string[]): Promise<LoadedState> {
  const stamp = new Date().toISOString().replace(/:/g, "-");
  const movedTo = assertInsideRoot(paths.home, `${paths.state}.corrupt-${stamp}`);
  try {
    await rename(paths.state, movedTo);
  } catch (cause) {
    throw new MaximsError(
      ExitCode.DestinationWriteFailed,
      `cannot move the corrupt ${paths.state} aside to ${movedTo}`,
      { cause },
    );
  }
  return { kind: "quarantined", movedTo, issues };
}

// The exact bytes the store writes, so a caller that folds the state write into its own
// `applyChanges` plan produces a file byte-identical to one the store wrote itself.
export function serializeState(state: State): string {
  return `${JSON.stringify(state, null, 2)}\n`;
}

async function writeStateFile(paths: StatePaths, state: State): Promise<WriteResult> {
  const plan: Plan = {
    changes: [
      { kind: "write", path: paths.state, content: serializeState(state), mode: STATE_FILE_MODE },
    ],
    notices: [],
  };
  const { applied } = await applyChanges(plan, { dryRun: false });
  return { written: applied === 1 };
}

function statePaths(home: string): StatePaths {
  const paths = homePaths(home);
  return {
    home,
    state: assertInsideRoot(home, paths.state),
    lock: assertInsideRoot(home, paths.lock),
  };
}

function isStoreLocked(error: unknown): error is MaximsError {
  return error instanceof MaximsError && error.code === ExitCode.StoreLocked;
}
