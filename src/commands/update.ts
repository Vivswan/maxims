// `update` is `sync` with the refresh forced: every fetched source, or the one named, is fetched
// again whatever the cooldown says, and whatever `-a` limits the writes to.
//
//   the lines afterwards  -> the engine's report: what was fetched, what each refresh changed, what failed, and which refreshed descriptions carry a risky shape
//   `--strict`            -> the engine does the fetching, so it plans the refresh first, at the price of a second fetch, and persists nothing (not the --cap beside it) when a warning exists

import {
  foundUpdates,
  heldUpdate,
  isLive,
  notInstalled,
  ownedBy,
  renameHint,
  STRINGS,
  updated,
} from "../console/strings.ts";
import { isLiveLocal } from "../contracts/source.ts";
import type { SyncOptions, SyncPreview, SyncReport } from "../engine/types.ts";
import { contentHashOf, parseMemoryName } from "../memory/contract.ts";
import { DEFAULT_RULE_CAP } from "../rulefile/budget.ts";
import type { UserConfig } from "../state/config.ts";
import type { RenameMap, State } from "../state/schema.ts";
import { applyChanges } from "../util/change.ts";
import { ExitCode, MaximsError } from "../util/exit-codes.ts";
import {
  cooldownCapConfig,
  loadIntentFor,
  persistConfig,
  updateIntent,
} from "./frame/cli-context.ts";
import { failedFetches, framed } from "./frame/engine-io.ts";
import {
  findInstalledSource,
  installedSources,
  knownHarnessIds,
  resolveIncoming,
  ruleCapRefusal,
  upstreamNames,
  withIntent,
} from "./frame/lookup.ts";
import {
  type Args,
  agentsFilter,
  type Command,
  type CommandContext,
  commonOptions,
  FLAGS,
  type FlagSpec,
  parseAgents,
  parseRenames,
  usage,
} from "./frame/options.ts";
import { failed, finish } from "./frame/output.ts";
import { lockChanges } from "./frame/project-lock-io.ts";
import { refreshWarnings, refuseRisky, riskLine } from "./frame/risk.ts";

const UPDATE_FLAGS: readonly FlagSpec[] = [
  FLAGS.agent,
  FLAGS.rename,
  FLAGS.cooldown,
  FLAGS.cap,
  FLAGS.strict,
];

type UpdateRequest = {
  renames: RenameMap;
  only: string[] | undefined;
  strict: boolean;
  nextConfig: UserConfig | null;
  base: SyncOptions;
};

type Persisted = Awaited<ReturnType<typeof persistConfig>>;

async function parseUpdateRequest(args: Args, ctx: CommandContext): Promise<UpdateRequest> {
  const renames = parseRenames(args);
  const selection = parseAgents(args, knownHarnessIds(ctx.io));
  const strict = args.flag(FLAGS.strict);
  // Every flag is parsed before the first state read: on a real run that read settles a corrupt
  // file, which a request that turns out malformed must not have done.
  const nextConfig = cooldownCapConfig(args, ctx.config);
  const only = await onlySource(args.positionals[0], ctx);
  if (Object.keys(renames).length > 0 && only === undefined) {
    throw usage("--rename on update needs the source it applies to");
  }
  const base: SyncOptions = {
    ...commonOptions(ctx.global),
    quiet: false,
    fetch: "force",
    ...agentsFilter(selection.kind === "ids" ? selection.ids : []),
    ...(only === undefined ? {} : { only }),
  };
  return { renames, only, strict, nextConfig, base };
}

// The strict refusal comes before anything persists, planned against what the run would
// persist (the --cap and --rename typed beside it) without writing it: a refused refresh
// leaves neither behind, and a rename that resolves a collision still counts.
async function refuseRiskyBeforePersist(
  request: UpdateRequest,
  before: State,
  ctx: CommandContext,
): Promise<void> {
  const { io } = ctx;
  const config = request.nextConfig ?? ctx.config;
  const proposed =
    Object.keys(request.renames).length > 0
      ? await recordRenames(request.only?.[0] ?? "", request.renames, ctx, config, true)
      : { state: before, config, changes: [] };
  const planned = await framed(io, (engine) =>
    ctx.engine.runSync({ ...request.base, dryRun: true, json: false, preview: proposed }, engine),
  );
  refuseRisky(await refreshWarnings(planned.plan, proposed.state, io, request.only));
}

// What the run records ahead of the sync: the renames with the config edits, the config edits
// alone, or nothing.
async function recordEdits(
  request: UpdateRequest,
  before: State,
  persisted: Persisted,
  ctx: CommandContext,
): Promise<SyncPreview | undefined> {
  if (Object.keys(request.renames).length > 0) {
    const preview = await recordRenames(
      request.only?.[0] ?? "",
      request.renames,
      ctx,
      persisted.config,
      ctx.global.dryRun,
    );
    return { ...preview, changes: [...persisted.changes, ...preview.changes] };
  }
  if (persisted.changes.length > 0) {
    return { state: before, config: persisted.config, changes: persisted.changes };
  }
  return undefined;
}

// The sources read in place, which the refresh leaves as they are.
function liveKeys(state: State, only: string[] | undefined): string[] {
  return Object.entries(state.sources)
    .filter(
      ([key, entry]) =>
        (only === undefined || only.includes(key)) && isLiveLocal(entry.intent.from),
    )
    .map(([key]) => key);
}

function updateLines(report: SyncReport): string[] {
  return [
    ...report.fetched.map((key) => {
      const changes = report.upstreamChanges[key] ?? [];
      const added = changes.filter((line) => line.startsWith("+ ")).length;
      const removed = changes.filter((line) => line.startsWith("- ")).length;
      return updated(key, added, removed);
    }),
    ...report.held.map((key) => heldUpdate(key, (report.upstreamChanges[key] ?? []).length)),
  ];
}

export const update: Command = {
  summary: "refetch every source, ignoring the cooldown, then sync",
  usage: "update [source]",
  arity: 1,
  flags: UPDATE_FLAGS,
  async run(args, ctx) {
    const { io } = ctx;
    const console = await ctx.openConsole(true);
    const request = await parseUpdateRequest(args, ctx);
    const before = await loadIntentFor(io.home, ctx.global.dryRun);
    if (request.strict && !ctx.global.dryRun) {
      await refuseRiskyBeforePersist(request, before.state, ctx);
    }
    const persisted = await persistConfig(ctx, request.nextConfig);
    const preview = await recordEdits(request, before.state, persisted, ctx);
    console.intro();
    console.step(STRINGS.checkingUpdates);
    for (const key of liveKeys(before.state, request.only)) console.step(isLive(key));
    const options: SyncOptions = {
      ...request.base,
      ...(ctx.global.dryRun && preview !== undefined ? { preview } : {}),
    };
    const report = await framed(io, (engine) => ctx.engine.runSync(options, engine));
    // The scan judges the state this run recorded: a rename moves a memory's local name, which
    // is the name the disabled list knows it by.
    const recorded = preview?.state ?? before.state;
    const warnings = await refreshWarnings(report.plan, recorded, io, request.only);
    if (request.strict) refuseRisky(warnings);
    const lines = updateLines(report);
    const changes = [...(preview?.changes ?? persisted.changes), ...report.plan.changes];
    const outcome = {
      plan: { changes, notices: [] },
      notices: [...warnings.map(riskLine), ...report.notices],
      json: {
        fetched: report.fetched,
        held: report.held,
        upstreamChanges: report.upstreamChanges,
        warnings,
      },
    };
    if (report.failed.length > 0) {
      // The failure is the run's exit, dry run or not, and the plan a dry run exists to show is
      // still printed, through the same frame a finished run ends in.
      throw failed(ctx, console, { ...outcome, lines }, failedFetches(report.failed));
    }
    const found = report.fetched.length + report.held.length;
    const summary = found === 0 ? STRINGS.allUpToDate : foundUpdates(found);
    return finish(ctx, console, { ...outcome, lines: [summary, ...lines] });
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
// map before the forced refetch applies it. `dryRun` computes the edit without writing it, for
// the run's own preview as well as the strict preflight's.
//   an upstream name the last fetch did not see -> the usual case (the memory that just appeared), so checked as incoming rather than refused
//   a pair whose LOCAL name collides            -> refused before anything is written
async function recordRenames(
  key: string,
  renames: RenameMap,
  ctx: CommandContext,
  config: UserConfig,
  dryRun: boolean,
): Promise<SyncPreview> {
  const update = await updateIntent(
    ctx.io.home,
    dryRun,
    async (current) => {
      const existing = current.state.sources[key];
      if (existing === undefined) throw new MaximsError(ExitCode.Usage, notInstalled(key));
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
        rule: existing.intent.rule,
        cap: config.ruleCap ?? DEFAULT_RULE_CAP,
        installed: await installedSources(current.state, ctx.io),
      });
      if (!outcome.ok) {
        if (outcome.code === ExitCode.RuleCapExceeded) throw ruleCapRefusal(key, outcome);
        const [first] = outcome.collisions;
        throw new MaximsError(outcome.code, ownedBy(first.name, first.ownedBy), {
          hint: renameHint(first.name),
        });
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
    (plan) => applyChanges(plan, { dryRun }),
  );
  return { state: update.state, config, changes: update.changes };
}

// The walk keys on names alone; the hash is display only and a rename check has no content to show.
const NO_HASH = contentHashOf("");
