import {
  failedToUpdate,
  foundUpdates,
  isLive,
  ownedBy,
  renameHint,
  STRINGS,
  updated,
} from "../console/strings.ts";
import { contentHashOf, parseMemoryName } from "../memory/contract.ts";
import type { UserConfig } from "../state/config.ts";
import type { RenameMap, State } from "../state/schema.ts";
import { applyChanges } from "../util/change.ts";
import { ExitCode, MaximsError } from "../util/exit-codes.ts";
import { DEFAULT_RULE_CAP } from "./add.ts";
import {
  cooldownCapConfig,
  loadIntentFor,
  persistConfig,
  updateIntent,
} from "./shared/cli-context.ts";
import { exitForFailed, framed } from "./shared/engine-io.ts";
import {
  agentsFilter,
  type Command,
  type CommandContext,
  commonOptions,
  FLAGS,
  type FlagSpec,
  parseAgents,
  parseRenames,
  usage,
} from "./shared/options.ts";
import { finish } from "./shared/output.ts";
import { lockChanges } from "./shared/project-lock-io.ts";
import {
  findInstalledSource,
  installedSources,
  knownHarnessIds,
  resolveIncoming,
  upstreamNames,
  withIntent,
} from "./shared/sources.ts";
import type { SyncOptions, SyncPreview } from "./types.ts";

const UPDATE_FLAGS: readonly FlagSpec[] = [FLAGS.agent, FLAGS.rename, FLAGS.cooldown, FLAGS.cap];

// `update` is `sync` with the refresh forced: every fetched source, or the one named, is fetched
// again whatever the cooldown says, and whatever `-a` limits the writes to. The lines afterwards
// come from the engine's report: what was fetched, what each refresh changed, what failed.
export const update: Command = {
  summary: "refetch every source, ignoring the cooldown, then sync",
  usage: "update [source]",
  arity: 1,
  flags: UPDATE_FLAGS,
  async run(args, ctx) {
    const { io } = ctx;
    const console = await ctx.openConsole(true);
    const renames = parseRenames(args);
    const selection = parseAgents(args, knownHarnessIds(ctx.io));
    // Every flag is parsed before the first state read: on a real run that read settles a corrupt
    // file, which a request that turns out malformed must not have done.
    const nextConfig = cooldownCapConfig(args, ctx.config);
    const only = await onlySource(args.positionals[0], ctx);
    if (Object.keys(renames).length > 0 && only === undefined) {
      throw usage("--rename on update needs the source it applies to");
    }
    const persisted = await persistConfig(ctx, nextConfig);
    let preview: SyncPreview | undefined;
    if (Object.keys(renames).length > 0) {
      preview = await recordRenames(only?.[0] ?? "", renames, ctx, persisted.config);
      preview = { ...preview, changes: [...persisted.changes, ...preview.changes] };
    } else if (persisted.changes.length > 0) {
      const { state } = await loadIntentFor(io.home, ctx.global.dryRun);
      preview = { state, config: persisted.config, changes: persisted.changes };
    }
    const before = await loadIntentFor(io.home, ctx.global.dryRun);
    console.intro();
    console.step(STRINGS.checkingUpdates);
    const liveKeys = Object.entries(before.state.sources)
      .filter(
        ([key, entry]) =>
          (only === undefined || only.includes(key)) &&
          entry.intent.from.type === "local" &&
          entry.intent.from.live === true,
      )
      .map(([key]) => key);
    for (const key of liveKeys) console.step(isLive(key));
    const options: SyncOptions = {
      ...commonOptions(ctx.global),
      quiet: false,
      fetch: "force",
      ...agentsFilter(selection.kind === "ids" ? selection.ids : []),
      ...(only === undefined ? {} : { only }),
      ...(ctx.global.dryRun && preview !== undefined ? { preview } : {}),
    };
    const report = await framed(io, (engine) => ctx.engine.runSync(options, engine));
    const lines = report.fetched.map((key) => {
      const changes = report.upstreamChanges[key] ?? [];
      const added = changes.filter((line) => line.startsWith("+ ")).length;
      const removed = changes.filter((line) => line.startsWith("- ")).length;
      return updated(key, added, removed);
    });
    if (report.failed.length > 0) {
      for (const line of lines) console.step(line);
      const failures = report.failed.map((failure) => failedToUpdate(failure.key, failure.message));
      throw new MaximsError(exitForFailed(report.failed), failures.join("\n"), {
        hint: "the last good copy of each failed source stays installed",
      });
    }
    const summary =
      report.fetched.length === 0 ? STRINGS.allUpToDate : foundUpdates(report.fetched.length);
    return finish(ctx, console, {
      plan: {
        changes: [...(preview?.changes ?? persisted.changes), ...report.plan.changes],
        notices: [],
      },
      notices: report.notices,
      json: { fetched: report.fetched, upstreamChanges: report.upstreamChanges },
      lines: [summary, ...lines],
    });
  },
};

async function onlySource(
  arg: string | undefined,
  ctx: CommandContext,
): Promise<string[] | undefined> {
  if (arg === undefined) return undefined;
  const { state } = await loadIntentFor(ctx.io.home, ctx.global.dryRun);
  return [findInstalledSource(state, arg, ctx.io)];
}

// A collision that appeared upstream is resolved the way `add --rename` resolves one: the pair is
// checked against the name index with the same walk `add` runs, then joins the source's rename
// map before the forced refetch applies it. An upstream name the last fetch did not see is the
// usual case (the memory that just appeared), so it is checked as incoming rather than refused;
// a pair whose LOCAL name collides is refused before anything is written.
async function recordRenames(
  key: string,
  renames: RenameMap,
  ctx: CommandContext,
  config: UserConfig,
): Promise<SyncPreview> {
  const update = await updateIntent(
    ctx.io.home,
    ctx.global.dryRun,
    async (current) => {
      const existing = current.state.sources[key];
      if (existing === undefined) throw new MaximsError(ExitCode.Usage, `${key} is not installed`);
      const rename = { ...existing.intent.rename, ...renames };
      const known = await upstreamNames(existing, ctx.io);
      const incoming = Object.keys(renames).flatMap((name) => {
        const parsed = parseMemoryName(name);
        return parsed === null || known.includes(parsed) ? [] : [parsed];
      });
      const outcome = resolveIncoming({
        source: key,
        memories: [...known, ...incoming].map((name) => ({
          name,
          description: "",
          contentHash: NO_HASH,
        })),
        select: existing.intent.select,
        rename,
        cap: config.ruleCap ?? DEFAULT_RULE_CAP,
        installed: await installedSources(current.state, ctx.io),
      });
      if (!outcome.ok) {
        const first = outcome.code === ExitCode.NameCollision ? outcome.collisions[0] : undefined;
        throw new MaximsError(
          outcome.code,
          first === undefined
            ? `${key} would exceed the rule cap`
            : ownedBy(first.name, first.ownedBy),
          { hint: first === undefined ? undefined : renameHint(first.name) },
        );
      }
      const next: State = {
        ...current.state,
        sources: {
          ...current.state.sources,
          [key]: withIntent(existing, (fields) => ({ ...fields, rename })),
        },
      };
      const changes = await lockChanges(existing, current.state, next, ctx.io);
      return { state: next, changes, notices: current.notices };
    },
    (plan) => applyChanges(plan, { dryRun: ctx.global.dryRun }),
  );
  return { state: update.state, config, changes: update.changes };
}

// The walk keys on names alone; the hash is display only and a rename check has no content to show.
const NO_HASH = contentHashOf("");
