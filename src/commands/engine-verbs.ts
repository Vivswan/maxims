// The three engine verbs as the command line dispatches them: parse, hand the typed options to
// the engine, and let the engine speak. Its output is the frame here: the `--json` document, the
// dry-run plan, the hook protocol under `--quiet`, the notices and the summary interactively.
//
//   remove   the prompt is the command line's, so the engine takes a confirmed removal or none:
//            without `-y` on a terminal the user is asked; without one anywhere else the run stops
//            before the engine, as `skills remove` does

import { promptsAllowed } from "../console/contract.ts";
import { agentsOnMemory, STRINGS } from "../console/strings.ts";
import type { HarnessId } from "../contracts/harness-id.ts";
import type {
  CliIo,
  CommonOptions,
  HarnessFilter,
  RemoveOptions,
  RemoveTarget,
} from "../engine/types.ts";
import type { Destination, Select, State } from "../state/schema.ts";
import { renderPlan } from "../util/change.ts";
import { ExitCode, MaximsError } from "../util/exit-codes.ts";
import { cooldownCapConfig, loadIntentFor, persistConfig } from "./frame/cli-context.ts";
import { engineIo, exitForFailed } from "./frame/engine-io.ts";
import {
  installedSourceOrNull,
  knownHarnessIds,
  type ResolvedMemory,
  resolveMemoryName,
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
  parseDestination,
  parseSelect,
  usage,
} from "./frame/options.ts";

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
    const persisted = await persistConfig(ctx, cooldownCapConfig(args, ctx.config));
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

// The flags a removal target is read with. `-a '*'` parses to "no filter", which on a whole
// source means every harness; on a memory or a narrowed selection any `-a` is refused, the
// wildcard included, so `agentFlag` says whether one was typed at all.
type RemoveFlags = {
  destination: Destination | null;
  agents: HarnessId[] | null;
  agentFlag: boolean;
  memoryFlag: boolean;
  select: Select | null;
};

// `--all` names nothing: no source, no `-m`, no destination.
function allTarget(positional: string | undefined, flags: RemoveFlags): RemoveTarget {
  if (positional !== undefined || flags.memoryFlag) throw usage(STRINGS.allWithNames);
  if (flags.destination !== null) throw usage("--all removes every source; drop -g, -p or -o");
  return { kind: "all", agents: flags.agents };
}

// A source has one recorded destination; `-m` narrows it to memories, where `-a` has no meaning.
function sourceTarget(key: string, flags: RemoveFlags): RemoveTarget {
  if (flags.destination !== null) {
    throw usage(`${key} has one recorded destination; drop -g, -p or -o`);
  }
  if (flags.select === null || flags.select === "*") {
    return { kind: "source", key, agents: flags.agents };
  }
  if (flags.agentFlag) throw usage(`-a applies to a whole source; drop -m to unlink ${key}`);
  return { kind: "memories", source: key, names: flags.select };
}

// A memory is named bare or as `@owner/repo/name`; `-m`, `-a` and a destination are refused on it.
async function memoryTarget(
  positional: string,
  flags: RemoveFlags,
  state: State,
  io: CliIo,
): Promise<RemoveTarget> {
  if (flags.memoryFlag) {
    throw usage(`${positional} names a memory; -m narrows a source, so name the source instead`);
  }
  if (flags.agentFlag) {
    throw usage(agentsOnMemory(positional), { hint: STRINGS.agentsOnMemoryHint });
  }
  if (flags.destination !== null) {
    throw usage(`${positional} names a memory of one recorded source; drop -g, -p or -o`);
  }
  const resolved: ResolvedMemory = await resolveMemoryName(state, io, positional);
  return { kind: "memories", source: resolved.key, names: [resolved.name] };
}

// `-a` drops harnesses from a whole source; on a memory or a narrowed selection it has no
// meaning, so the two are refused here, once, and the target type cannot hold them together.
async function removeTarget(args: Args, ctx: CommandContext, all: boolean): Promise<RemoveTarget> {
  const positional = args.positionals[0];
  const flags: RemoveFlags = {
    destination: parseDestination(args, ctx.io.cwd, ctx.io.projectRoot),
    agents: agentIds(args, ctx.io) ?? null,
    agentFlag: args.list(FLAGS.agent).length > 0,
    memoryFlag: args.list(FLAGS.memory).length > 0,
    select: parseSelect(args),
  };
  if (all) return allTarget(positional, flags);
  if (positional === undefined) throw usage("Missing required argument: source or memory name");
  const { state } = await loadIntentFor(ctx.io.home, ctx.global.dryRun);
  const key = installedSourceOrNull(state, positional, ctx.io);
  if (key !== null) return sourceTarget(key, flags);
  return memoryTarget(positional, flags, state, ctx.io);
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
