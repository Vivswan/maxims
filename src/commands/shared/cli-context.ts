import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { parseUserConfig, type UserConfig, UserConfigSchema } from "../../state/config.ts";
import { emptyState, type State } from "../../state/schema.ts";
import {
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
import { type Args, type CommandContext, FLAGS, parsePositiveInt } from "./options.ts";

// The project root is the nearest ancestor of the cwd that a git checkout marks, so a project
// install from a subdirectory lands at the repository root the harness reads from.
export function findProjectRoot(cwd: string): string | null {
  let dir = cwd;
  for (;;) {
    if (existsSync(join(dir, ".git"))) return dir;
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
  const cooldown = parsePositiveInt(FLAGS.cooldown, args);
  const cap = parsePositiveInt(FLAGS.cap, args);
  if (cooldown === undefined && cap === undefined) return null;
  return {
    ...config,
    ...(cooldown === undefined ? {} : { cooldownDays: cooldown }),
    ...(cap === undefined ? {} : { ruleCap: cap }),
  };
}

// Writes the persisted flags before the engine runs, so the sync that follows reads the new cap
// and cooldown from the file like every later one.
export async function persistCooldownCap(
  args: Args,
  ctx: CommandContext,
): Promise<{ config: UserConfig; changes: Change[] }> {
  const next = cooldownCapConfig(args, ctx.config);
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
  const withStateWrite = (update: IntentUpdate): IntentUpdate => ({
    ...update,
    changes: [
      ...update.changes,
      {
        kind: "write",
        path: assertInsideRoot(home, homePaths(home).state),
        content: serializeState({ ...update.state, writtenBy: WRITTEN_BY }),
        mode: 0o600,
      },
    ],
  });
  if (dryRun) {
    const update = await fn(await loadIntent(home));
    await apply({ changes: update.changes, notices: update.notices });
    return withStateWrite(update);
  }
  return withStateLock(home, "manual", async (lock) => {
    const intent = intentFrom(await lock.read(), homePaths(home).state);
    const update = await fn(intent);
    await apply({ changes: update.changes, notices: update.notices });
    await lock.write(update.state, WRITTEN_BY);
    return withStateWrite(update);
  });
}
