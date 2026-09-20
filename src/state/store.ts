import { readFile, rename } from "node:fs/promises";
import { applyChanges, type Plan } from "../util/change.ts";
import { ExitCode, MaximsError } from "../util/exit-codes.ts";
import { assertInsideRoot, ensureDir0700 } from "../util/fs.ts";
import { homePaths } from "../util/home.ts";
import { type StolenLock, withLock } from "../util/lock.ts";
import { VERSION } from "../version.ts";
import { type MigrationStep, migrateState, versionOf } from "./migrations/index.ts";
import { CURRENT_STATE_VERSION, parseState, type State } from "./schema.ts";

export const WRITTEN_BY = `maxims@${VERSION}`;

export type LoadedState =
  | { kind: "absent" }
  | { kind: "loaded"; state: State; migrated: boolean }
  | { kind: "newer"; version: number; path: string }
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

type StatePaths = { home: string; state: string; lock: string };

const STATE_FILE_MODE = 0o600;

// A read outside the lock still persists a migration when it can, but never waits for the lock:
// whoever holds it is about to write the current shape, so the write-back would be redundant.
export async function readState(
  home: string,
  options: ReadStateOptions = {},
): Promise<LoadedState> {
  const paths = statePaths(home);
  const loaded = await loadStateFile(paths, options);
  if (loaded.kind === "loaded" && loaded.migrated) {
    try {
      await withLock(paths.lock, { waitMs: 0 }, async () => {
        await writeStateFile(paths, loaded.state);
      });
    } catch (error) {
      if (!isStoreLocked(error)) throw error;
    }
  }
  return loaded;
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
        read: async (readOptions = {}) => {
          const loaded = await loadStateFile(paths, readOptions);
          if (loaded.kind === "loaded" && loaded.migrated)
            await writeStateFile(paths, loaded.state);
          return loaded;
        },
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

// Whether the file is newer or due for migration is decided on an integer `version` only: a
// fractional or non-numeric version is a shape error the strict parse reports, never a newer file
// to step around.
async function loadStateFile(paths: StatePaths, options: ReadStateOptions): Promise<LoadedState> {
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
    return quarantine(paths, [`not valid JSON: ${detail}`]);
  }
  const version = versionOf(json);
  if (version !== null && version > CURRENT_STATE_VERSION) {
    return { kind: "newer", version, path: paths.state };
  }
  if (version !== null && version < CURRENT_STATE_VERSION) {
    return migrateFile(paths, json, version, options.migrations);
  }
  const parsed = parseState(json);
  if (parsed.ok === "parsed") return { kind: "loaded", state: parsed.state, migrated: false };
  return quarantine(
    paths,
    parsed.ok === "corrupt" ? parsed.issues : ["version: expected an integer"],
  );
}

// The migrated document passes the same strict parse a fresh file gets before it is written back,
// so a step that produces a bad shape quarantines the ORIGINAL bytes rather than persisting its output.
function migrateFile(
  paths: StatePaths,
  json: unknown,
  version: number,
  migrations: readonly MigrationStep[] | undefined,
): Promise<LoadedState> | LoadedState {
  const migration = migrateState(json, version, migrations);
  if (migration.kind === "unreachable") {
    return quarantine(paths, [
      `version ${version} is older than any migration this maxims carries (oldest ${migration.oldest}); re-add your sources`,
    ]);
  }
  const parsed = parseState(migration.json);
  if (parsed.ok !== "parsed") {
    const issues =
      parsed.ok === "corrupt" ? parsed.issues : [`arrived at version ${parsed.version}`];
    return quarantine(paths, [`after migrating from version ${version}:`, ...issues]);
  }
  return { kind: "loaded", state: { ...parsed.state, writtenBy: WRITTEN_BY }, migrated: true };
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

async function writeStateFile(paths: StatePaths, state: State): Promise<WriteResult> {
  const plan: Plan = {
    changes: [
      {
        kind: "write",
        path: paths.state,
        content: `${JSON.stringify(state, null, 2)}\n`,
        mode: STATE_FILE_MODE,
      },
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
