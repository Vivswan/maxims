import { existsSync, readFileSync, realpathSync } from "node:fs";
import { dirname, join } from "node:path";
import type { MemoryName } from "../../memory/contract.ts";
import { parseUserConfig, type UserConfig, UserConfigSchema } from "../../state/config.ts";
import { emptyState, parseState, type State } from "../../state/schema.ts";
import {
  inspectState,
  type LoadedState,
  readState,
  serializeState,
  WRITTEN_BY,
  withStateLock,
} from "../../state/store.ts";
import { applyChanges, type Change, type Plan } from "../../util/change.ts";
import { ExitCode, MaximsError } from "../../util/exit-codes.ts";
import { assertInsideRoot } from "../../util/fs.ts";
import { homePaths } from "../../util/home.ts";
import { type Args, type CommandContext, FLAGS, INTEGER, parseInteger } from "./options.ts";

// The project root is the nearest ancestor of the cwd that a git checkout marks, so a project
// install from a subdirectory lands at the repository root the harness reads from; its real path,
// since state records a project by it and a cwd reached through an alias must find the same entries.
export function findProjectRoot(cwd: string): string | null {
  let dir = cwd;
  for (;;) {
    if (existsSync(join(dir, ".git"))) return realpathSync(dir);
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

// An unreadable config is exit 4, never a silent fallback to defaults: a typo in `ruleCap` would
// otherwise let a run apply a cap the user believes they raised.
export function readConfig(home: string): UserConfig {
  const path = homePaths(home).config;
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return {};
    throw new MaximsError(ExitCode.DestinationWriteFailed, `cannot read ${path}`, { cause: error });
  }
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new MaximsError(ExitCode.DestinationWriteFailed, `${path} is not valid JSON: ${detail}`);
  }
  const parsed = parseUserConfig(json);
  if (!parsed.ok) {
    throw new MaximsError(
      ExitCode.DestinationWriteFailed,
      `${path} is not a valid config: ${parsed.issues.join("; ")}`,
      { hint: `valid keys: ${Object.keys(UserConfigSchema.shape).join(", ")}` },
    );
  }
  return parsed.config;
}

export function configWrite(home: string, config: UserConfig): Change {
  const path = assertInsideRoot(home, homePaths(home).config);
  return { kind: "write", path, content: `${JSON.stringify(config, null, 2)}\n` };
}

// `--cooldown` and `--cap` are the two flags that persist: typed once, they are meant for every
// later sync, so they land in config.json exactly as `config set` would write them and apply to
// the current run at once. Null when neither was given.
export function cooldownCapConfig(args: Args, config: UserConfig): UserConfig | null {
  const cooldown = parseInteger(FLAGS.cooldown, INTEGER.nonNegative, args);
  const cap = parseInteger(FLAGS.cap, INTEGER.positive, args);
  if (cooldown === undefined && cap === undefined) return null;
  return {
    ...config,
    ...(cooldown === undefined ? {} : { cooldownDays: cooldown }),
    ...(cap === undefined ? {} : { ruleCap: cap }),
  };
}

// Writes the persisted flags before the engine runs, so the sync that follows reads the new cap
// and cooldown from the file like every later one.
export async function persistConfig(
  ctx: CommandContext,
  next: UserConfig | null,
): Promise<{ config: UserConfig; changes: Change[] }> {
  if (next === null) return { config: ctx.config, changes: [] };
  const changes = [configWrite(ctx.io.home, next)];
  await applyChanges({ changes, notices: [] }, { dryRun: ctx.global.dryRun });
  return { config: next, changes };
}

export type Intent = {
  state: State;
  notices: string[];
};

// A state file this maxims cannot obey is surfaced, never worked around: a quarantined file
// becomes a notice plus an empty intent, and a file from a newer maxims stops the run, since any
// write here would drop fields that maxims can see and this one cannot.
export function intentFrom(loaded: LoadedState, path: string): Intent {
  switch (loaded.kind) {
    case "absent":
      return { state: emptyState(WRITTEN_BY), notices: [] };
    case "loaded":
      return { state: loaded.state, notices: [] };
    case "quarantined":
      return {
        state: emptyState(WRITTEN_BY),
        notices: [
          `${path} was moved aside to ${loaded.movedTo} (${loaded.issues.join("; ")}); re-add your sources`,
        ],
      };
    case "corrupt":
      return {
        state: emptyState(WRITTEN_BY),
        notices: [`${path} is corrupt (${loaded.issues.join("; ")}) and ${loaded.lockedBy}`],
      };
    case "newer":
      throw new MaximsError(
        ExitCode.Usage,
        `${path} was written by a newer maxims (state version ${loaded.version})`,
        { hint: "upgrade maxims to read it" },
      );
  }
}

export async function loadIntent(home: string): Promise<Intent> {
  return intentFrom(await readState(home), homePaths(home).state);
}

// The read for a verb that must not write: `add --list`, `doctor`, and every `--dry-run`. It
// never takes the lock (which would create the home) and never moves a corrupt file aside or
// persists a migration; such a file becomes an empty intent plus the notice naming the locking
// verb that would settle it.
export async function peekIntent(home: string): Promise<Intent> {
  const inspection = await inspectState(home);
  switch (inspection.kind) {
    case "absent":
      return { state: emptyState(WRITTEN_BY), notices: [] };
    case "current":
      return { state: inspection.state, notices: [] };
    case "newer":
      return intentFrom(
        { kind: "newer", version: inspection.version, path: homePaths(home).state },
        homePaths(home).state,
      );
    case "corrupt":
      return {
        state: emptyState(WRITTEN_BY),
        notices: [
          `state.json is corrupt: ${inspection.issues[0] ?? "unreadable"}; run maxims sync to quarantine it`,
        ],
      };
    case "migrated":
      return {
        state: emptyState(WRITTEN_BY),
        notices: ["state.json needs migration; run maxims sync"],
      };
  }
}

// A dry run of a mutating verb plans against the file as it is. A file the lock-free read cannot
// obey stops the run with exit 1: the real run would first move it aside or migrate it, and a plan
// drawn against an empty intent would not show the writes that settle it.
export async function loadIntentFor(home: string, dryRun: boolean): Promise<Intent> {
  if (!dryRun) return loadIntent(home);
  const peeked = await peekIntent(home);
  const notice = peeked.notices[0];
  if (notice !== undefined) throw new MaximsError(ExitCode.Usage, notice);
  return peeked;
}

export type IntentUpdate = {
  state: State;
  changes: Change[];
  notices: string[];
};

// The one commit point of every intent-changing verb: read under the lock, let the verb compute
// the next state plus any changes that must land with it (a store entry, a manifest, a config
// write), then write the state file last, so a crash before it leaves intent untouched and a crash
// after it leaves everything the next sync re-derives from. The state write is performed by the
// store, not by `apply`, and is appended to the returned plan so --dry-run and --json show it. A
// dry run never takes the lock: taking it would create the home directory, which is a write.
export async function updateIntent(
  home: string,
  dryRun: boolean,
  fn: (intent: Intent) => Promise<IntentUpdate>,
  apply: (plan: Plan) => Promise<unknown>,
): Promise<IntentUpdate> {
  const path = assertInsideRoot(home, homePaths(home).state);
  const withStateWrite = (update: IntentUpdate): IntentUpdate => ({
    ...update,
    changes: [
      ...update.changes,
      { kind: "write", path, content: writableState(update.state, path), mode: 0o600 },
    ],
  });
  if (dryRun) {
    const update = await fn(await loadIntentFor(home, true));
    const planned = withStateWrite(update);
    await apply({ changes: update.changes, notices: update.notices });
    return planned;
  }
  return withStateLock(home, "manual", async (lock) => {
    const intent = intentFrom(await lock.read(), path);
    const update = await fn(intent);
    const planned = withStateWrite(update);
    await apply({ changes: update.changes, notices: update.notices });
    await lock.write(update.state, WRITTEN_BY);
    return planned;
  });
}

// The bytes about to be written are read back through the state parser first: a value that
// reached the state type without passing its schema (a ref carrying `-->`) would otherwise land
// on disk and quarantine the whole file on the next read.
function writableState(state: State, path: string): string {
  const content = serializeState({ ...state, writtenBy: WRITTEN_BY });
  const parsed = parseState(JSON.parse(content));
  if (parsed.ok === "parsed") return content;
  const issues = parsed.ok === "corrupt" ? parsed.issues : [`version ${parsed.version}`];
  throw new MaximsError(
    ExitCode.Usage,
    `refusing to write ${path}: the state would not read back (${issues.join("; ")})`,
  );
}

export type DisabledEdit = { changed: boolean; state: State };

// Which disabled list an edit means: the global one, or a project's under its root. A project
// edit cannot be spelled without the root, so no caller substitutes one.
export type DisabledScope = { scope: "global" } | { scope: "project"; root: string };

// The one edit of the disabled lists. The list stays sorted and unique, which is the shape the
// state schema refuses to read otherwise.
export function withDisabled(
  state: State,
  at: DisabledScope,
  name: MemoryName,
  disabled: boolean,
): DisabledEdit {
  const current =
    at.scope === "global"
      ? (state.disabled?.global ?? [])
      : (state.disabled?.project?.[at.root] ?? []);
  const has = current.includes(name);
  if (has === disabled) return { changed: false, state };
  const next = disabled ? [...current, name].sort() : current.filter((each) => each !== name);
  const lists = { ...state.disabled };
  if (at.scope === "global") {
    if (next.length === 0) delete lists.global;
    else lists.global = next;
  } else {
    const project = { ...lists.project };
    if (next.length === 0) delete project[at.root];
    else project[at.root] = next;
    if (Object.keys(project).length === 0) delete lists.project;
    else lists.project = project;
  }
  const { disabled: _previous, ...rest } = state;
  return {
    changed: true,
    state: Object.keys(lists).length === 0 ? rest : { ...rest, disabled: lists },
  };
}
