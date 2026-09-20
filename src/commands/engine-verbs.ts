import { promptsAllowed } from "../console/contract.ts";
import { STRINGS } from "../console/strings.ts";
import type { HarnessId } from "../harnesses/contract.ts";
import { renderPlan } from "../util/change.ts";
import { ExitCode, MaximsError } from "../util/exit-codes.ts";
import { loadIntentFor, persistCooldownCap } from "./shared/cli-context.ts";
import { engineIo, exitForFailed } from "./shared/engine-io.ts";
import {
  type Args,
  agentsFilter,
  type Command,
  type CommandContext,
  commonOptions,
  FLAGS,
  type FlagSpec,
  parseAgents,
  parseDestination,
  parseSelect,
  usage,
} from "./shared/options.ts";
import {
  findInstalledSource,
  knownHarnessIds,
  type ResolvedMemory,
  resolveMemoryName,
} from "./shared/sources.ts";
import type { CliIo, CommonOptions, HarnessFilter, RemoveOptions, RemoveTarget } from "./types.ts";

// The three engine verbs as the command line dispatches them: parse, hand the typed options to
// the engine, and let the engine speak. Its output is the frame here: the `--json` document, the
// dry-run plan, the hook protocol under `--quiet`, the notices and the summary interactively.

function agentIds(args: Args, io: CliIo): HarnessId[] | undefined {
  const selection = parseAgents(args, knownHarnessIds(io));
  return selection.kind === "ids" ? selection.ids : undefined;
}

// `-a` on `sync` narrows the run; without it every harness is meant, spelled as an absent key.
function syncAgents(args: Args, io: CliIo): { agents?: HarnessFilter } {
  return agentsFilter(agentIds(args, io) ?? []);
}

const SYNC_FLAGS: readonly FlagSpec[] = [FLAGS.agent, FLAGS.noFetch, FLAGS.cooldown, FLAGS.cap];

export const sync: Command = {
  summary: "apply state to this machine and project",
  usage: "sync",
  arity: 0,
  flags: SYNC_FLAGS,
  async run(args, ctx) {
    const agents = syncAgents(args, ctx.io);
    const persisted = await persistCooldownCap(args, ctx);
    const preview =
      ctx.global.dryRun && persisted.changes.length > 0
        ? {
            state: (await loadIntentFor(ctx.io.home, true)).state,
            config: persisted.config,
            changes: persisted.changes,
          }
        : undefined;
    // The config write is the verb's own, so its dry-run plan is printed here, ahead of the
    // engine's; `--json` is the engine's one document.
    if (preview !== undefined && !ctx.global.json) {
      ctx.io.stdout.write(renderPlan({ changes: preview.changes, notices: [] }));
    }
    const report = await ctx.engine.runSync(
      {
        ...commonOptions(ctx.global),
        fetch: args.flag(FLAGS.noFetch) ? "none" : "due",
        ...agents,
        ...(preview === undefined ? {} : { preview }),
      },
      engineIo(ctx.io, { stdout: ctx.io.stdout }),
    );
    return exitForFailed(report.failed);
  },
};

const REMOVE_FLAGS: readonly FlagSpec[] = [
  FLAGS.global,
  FLAGS.project,
  FLAGS.out,
  FLAGS.memory,
  FLAGS.agent,
  FLAGS.yes,
  FLAGS.all,
];

// The prompt is the command line's: the engine takes a confirmed removal or none. Without `-y`
// on a terminal the user is asked; without one anywhere else the run stops before the engine,
// as `skills remove` does.
export const remove: Command = {
  summary: "take a source or a memory out of state, then sync",
  usage: "remove <source or memory>",
  arity: 1,
  flags: REMOVE_FLAGS,
  async run(args, ctx) {
    const all = args.flag(FLAGS.all);
    const yes = args.flag(FLAGS.yes) || all;
    const console = await ctx.openConsole(yes);
    const target = await removeTarget(args, ctx, all);
    if (!yes) {
      console.intro();
      console.step(`Memories to remove: ${describeTarget(target)}`);
      const confirmed = await console.confirm("Are you sure you want to remove them?", false);
      if (!confirmed) {
        if (!promptsAllowed(console.mode))
          throw new MaximsError(ExitCode.Usage, STRINGS.removeNeedsTty);
        console.step(STRINGS.removalCancelled);
        return ExitCode.Ok;
      }
    }
    const report = await ctx.engine.runRemove(
      removeOptions(target, commonOptions(ctx.global)),
      engineIo(ctx.io, { stdout: ctx.io.stdout }),
    );
    return exitForFailed(report.failed);
  },
};

// The engine takes source keys, bare memory names, and memories named with their source, which
// is how a narrowed selection reaches it without a spelling a source key could share.
export function removeOptions(target: RemoveTarget, common: CommonOptions): RemoveOptions {
  switch (target.kind) {
    case "all":
      return {
        ...common,
        targets: [],
        all: true,
        ...agentsFilter(target.agents ?? []),
        confirmed: true,
      };
    case "source":
      return {
        ...common,
        targets: [target.key],
        all: false,
        ...agentsFilter(target.agents ?? []),
        confirmed: true,
      };
    case "memories":
      return {
        ...common,
        targets: target.names.map((memory) => ({ source: target.source, memory })),
        all: false,
        confirmed: true,
      };
  }
}

// `-a` drops harnesses from a whole source; on a memory or a narrowed selection it has no
// meaning, so the two are refused here, once, and the target type cannot hold them together.
async function removeTarget(args: Args, ctx: CommandContext, all: boolean): Promise<RemoveTarget> {
  const positional = args.positionals[0];
  const destination = parseDestination(args, ctx.io.cwd);
  const agents = agentIds(args, ctx.io) ?? null;
  const select = parseSelect(args);
  if (all) {
    if (positional !== undefined || args.list(FLAGS.memory).length > 0) {
      throw usage(STRINGS.allWithNames);
    }
    if (destination !== null) throw usage("--all removes every source; drop -g, -p or -o");
    return { kind: "all", agents };
  }
  if (positional === undefined) throw usage("Missing required argument: source or memory name");
  const { state } = await loadIntentFor(ctx.io.home, ctx.global.dryRun);
  const key = installedSourceOrNull(state, positional, ctx.io);
  if (key !== null) {
    if (destination !== null) {
      throw usage(`${key} has one recorded destination; drop -g, -p or -o`);
    }
    if (select === null || select === "*") return { kind: "source", key, agents };
    if (agents !== null) throw usage(`-a applies to a whole source; drop -m to unlink ${key}`);
    return { kind: "memories", source: key, names: select };
  }
  if (args.list(FLAGS.memory).length > 0) {
    throw usage(`${positional} names a memory; -m narrows a source, so name the source instead`);
  }
  if (agents !== null) {
    throw usage(`-a applies to a source, not to the memory ${positional}`, {
      hint: "name the source to drop a harness from, or drop the name without -a",
    });
  }
  if (destination !== null) {
    throw usage(`${positional} names a memory of one recorded source; drop -g, -p or -o`);
  }
  const resolved: ResolvedMemory = resolveMemoryName(state, ctx.io, positional);
  return { kind: "memories", source: resolved.key, names: [resolved.name] };
}

// `@owner/repo` names a source and `@owner/repo/name` a memory of one, so the argument is read
// as a source first and as a memory when no recorded source answers to it.
function installedSourceOrNull(
  state: Parameters<typeof findInstalledSource>[0],
  arg: string,
  io: CliIo,
): string | null {
  try {
    return findInstalledSource(state, arg, io);
  } catch (error) {
    if (error instanceof MaximsError && error.code === ExitCode.Usage) return null;
    throw error;
  }
}

function describeTarget(target: RemoveTarget): string {
  switch (target.kind) {
    case "all":
      return "every source";
    case "source":
      return target.agents === null ? target.key : `${target.key} from ${target.agents.join(", ")}`;
    case "memories":
      return target.names.join(", ");
  }
}

export const list: Command = {
  summary: "what state holds, per source and per harness",
  usage: "list",
  arity: 0,
  flags: [],
  async run(_args, ctx) {
    await ctx.engine.runList(
      commonOptions(ctx.global),
      engineIo(ctx.io, { stdout: ctx.io.stdout }),
    );
    return ExitCode.Ok;
  },
};
