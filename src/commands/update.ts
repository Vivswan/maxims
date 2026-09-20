import {
  failedToUpdate,
  foundUpdates,
  isLive,
  notInSelection,
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
import { loadIntentFor, persistCooldownCap, updateIntent } from "./shared/cli-context.ts";
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
import { planProjectLock } from "./shared/project-lock-io.ts";
import {
  findInstalledSource,
  installedSources,
  knownHarnessIds,
  upstreamNames,
  withIntent,
} from "./shared/sources.ts";
import type { SyncPreview } from "./types.ts";

const UPDATE_FLAGS: readonly FlagSpec[] = [FLAGS.agent, FLAGS.rename, FLAGS.cooldown, FLAGS.cap];

// `update` is `sync` with the refresh forced: every fetched source, or the one named, is fetched
// again whatever the cooldown says. The lines afterwards come from the engine's report (what was
// fetched, what failed) and from the state it wrote: a selection that no longer covers every
// upstream memory is pointed out.
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
    const only = await onlySource(args.positionals[0], ctx);
    if (Object.keys(renames).length > 0 && only === undefined) {
      throw usage("--rename on update needs the source it applies to");
    }
    const persisted = await persistCooldownCap(args, ctx);
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
    const report = await ctx.engine.runSync(
      {
        ...commonOptions(ctx.global),
        noFetch: false,
        force: true,
        ...agentsFilter(selection.kind === "ids" ? selection.ids : []),
        ...(only === undefined ? {} : { only }),
        ...(ctx.global.dryRun && preview !== undefined ? { preview } : {}),
      },
      io,
    );
    const after = await loadIntentFor(io.home, ctx.global.dryRun);
    const lines: string[] = [];
    const failures = report.failed
      .filter((failure) => only === undefined || only.includes(failure.key))
      .map((failure) => failedToUpdate(failure.key, failure.message));
    for (const [key, entry] of Object.entries(after.state.sources)) {
      if (only !== undefined && !only.includes(key)) continue;
      if (!("fetched" in entry) || entry.fetched === undefined) continue;
      if (report.failed.some((failure) => failure.key === key)) continue;
      if (report.fetched.includes(key)) {
        const added = report.changed.filter((line) => line.startsWith(`+${key} `)).length;
        const removed = report.changed.filter((line) => line.startsWith(`-${key} `)).length;
        lines.push(updated(key, added, removed));
      }
      // The selection notice reads the fetch record this run wrote; a dry run wrote none.
      if (entry.intent.select !== "*" && !ctx.global.dryRun) {
        const upstream = Object.keys(entry.fetched.memories).flatMap((name) => {
          const parsed = parseMemoryName(name);
          return parsed === null ? [] : [parsed];
        });
        const missing = upstream.filter((name) => !entry.intent.select.includes(name));
        if (missing.length > 0) report.notices.push(notInSelection(key, missing));
      }
    }
    if (failures.length > 0) {
      for (const line of lines) console.step(line);
      throw new MaximsError(ExitCode.SourceUnresolvable, failures.join("\n"), {
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
      json: { fetched: report.fetched, changed: report.changed },
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
      const known = upstreamNames(existing, ctx.io);
      const incoming = Object.keys(renames).flatMap((name) => {
        const parsed = parseMemoryName(name);
        return parsed === null || known.includes(parsed) ? [] : [parsed];
      });
      const outcome = ctx.engine.resolveIncoming({
        source: key,
        memories: [...known, ...incoming].map((name) => ({
          name,
          description: "",
          contentHash: NO_HASH,
        })),
        select: existing.intent.select,
        rename,
        cap: config.ruleCap ?? DEFAULT_RULE_CAP,
        installed: installedSources(current.state, ctx.io),
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
        sources: { ...current.state.sources, [key]: withIntent(existing, { rename }) },
      };
      const changes =
        existing.intent.destination.scope === "project" && ctx.io.projectRoot !== null
          ? [planProjectLock(ctx.io.projectRoot, next)]
          : [];
      return { state: next, changes, notices: current.notices };
    },
    (plan) => applyChanges(plan, { dryRun: ctx.global.dryRun }),
  );
  return { state: update.state, config, changes: update.changes };
}

// The walk keys on names alone; the hash is display only and a rename check has no content to show.
const NO_HASH = contentHashOf("");
