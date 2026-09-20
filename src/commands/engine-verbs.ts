import { promptsAllowed } from "../console/contract.ts";
import { STRINGS } from "../console/strings.ts";
import type { HarnessId } from "../harnesses/contract.ts";
import { canonicalSourceKey, type State } from "../state/schema.ts";
import { ExitCode, MaximsError } from "../util/exit-codes.ts";
import { loadIntent, persistCooldownCap } from "./shared/cli-context.ts";
import {
  type Args,
  type Command,
  commonOptions,
  FLAGS,
  type FlagSpec,
  parseAgents,
  parseDestination,
  parseSelect,
  usage,
} from "./shared/options.ts";
import { finish } from "./shared/output.ts";
import { projectLockPath, readProjectLock, sourceFromLock } from "./shared/project-lock-io.ts";
import {
  findInstalledSource,
  findSourceKey,
  knownHarnessIds,
  resolveMemoryName,
  tildify,
} from "./shared/sources.ts";
import type { EngineIo, RemoveTarget } from "./types.ts";

// The three engine verbs as the command line dispatches them: parse, hand the typed options to
// the engine, print its report through the one output path.

function agentIds(args: Args, io: EngineIo): HarnessId[] | undefined {
  const selection = parseAgents(args, knownHarnessIds(io));
  return selection.kind === "ids" ? selection.ids : undefined;
}

const SYNC_FLAGS: readonly FlagSpec[] = [FLAGS.agent, FLAGS.noFetch, FLAGS.cooldown, FLAGS.cap];

export const sync: Command = {
  summary: "apply state to this machine and project",
  usage: "sync",
  arity: 0,
  flags: SYNC_FLAGS,
  async run(args, ctx) {
    const console = await ctx.openConsole(true);
    const noFetch = args.flag(FLAGS.noFetch);
    const agents = agentIds(args, ctx.io);
    const persisted = await persistCooldownCap(args, ctx);
    const preview =
      ctx.global.dryRun && persisted.changes.length > 0
        ? {
            state: (await loadIntent(ctx.io.home)).state,
            config: persisted.config,
            changes: persisted.changes,
          }
        : undefined;
    const report = await ctx.engine.runSync(
      {
        ...commonOptions(ctx.global),
        noFetch,
        agents,
        force: false,
        ...(preview === undefined ? {} : { preview }),
      },
      ctx.io,
    );
    if (ctx.io.projectRoot !== null && !ctx.global.quiet && !ctx.global.json) {
      const lock = readProjectLock(ctx.io.projectRoot);
      const { state } = await loadIntent(ctx.io.home);
      const root = ctx.io.projectRoot;
      const missing =
        lock.kind === "present"
          ? Object.entries(lock.lock.sources)
              .filter(
                ([, source]) =>
                  findSourceKey(state, canonicalSourceKey(sourceFromLock(source, root))) === null,
              )
              .map(([key]) => key)
          : [];
      if (missing.length > 0) {
        report.notices.push(
          `${tildify(projectLockPath(ctx.io.projectRoot), ctx.io.userHome)} lists sources this machine has not installed (${missing.join(", ")}); run maxims install`,
        );
      }
    }
    return finish(ctx, console, {
      plan: { changes: [...persisted.changes, ...report.plan.changes], notices: [] },
      notices: report.notices,
      json: {
        sources: report.sources,
        rules: report.rules,
        fetched: report.fetched,
        changed: report.changed,
      },
      lines: [`Synced ${report.sources} sources, ${report.rules} rule lines`],
    });
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
    console.intro();
    console.step(`Memories to remove: ${describeTarget(target)}`);
    const confirmed = await console.confirm("Are you sure you want to remove them?", false);
    if (!confirmed && !yes) {
      if (!promptsAllowed(console.mode))
        throw new MaximsError(ExitCode.Usage, STRINGS.removeNeedsTty);
      console.step(STRINGS.removalCancelled);
      return ExitCode.Ok;
    }
    const report = await ctx.engine.runRemove({ ...commonOptions(ctx.global), target }, ctx.io);
    return finish(ctx, console, {
      plan: report.plan,
      notices: report.notices,
      json: { removed: report.removed },
      lines: [`Removed ${report.removed.length} source(s)`],
    });
  },
};

async function removeTarget(
  args: Parameters<Command["run"]>[0],
  ctx: Parameters<Command["run"]>[1],
  all: boolean,
): Promise<RemoveTarget> {
  const positional = args.positionals[0];
  const destination = parseDestination(args, ctx.io.cwd);
  const agents = agentIds(args, ctx.io) ?? null;
  if (all) {
    if (positional !== undefined || args.list(FLAGS.memory).length > 0) {
      throw usage(STRINGS.allWithNames);
    }
    if (destination !== null) throw usage("--all removes every source; drop -g, -p or -o");
    return { kind: "all", agents };
  }
  if (positional === undefined) throw usage("Missing required argument: source or memory name");
  const { state } = await loadIntent(ctx.io.home);
  const key = installedSourceOrNull(state, positional, ctx.io);
  if (key !== null) {
    if (destination !== null) {
      throw usage(`${key} has one recorded destination; drop -g, -p or -o`);
    }
    const select = parseSelect(args);
    return {
      kind: "source",
      key,
      memories: select === null || select === "*" ? null : select,
      agents,
    };
  }
  if (args.list(FLAGS.memory).length > 0) {
    throw usage(`${positional} names a memory; -m narrows a source, so name the source instead`);
  }
  const resolved = resolveMemoryName(state, ctx.io, positional);
  return { kind: "memory", source: resolved.key, name: resolved.name, agents, destination };
}

// `@owner/repo` names a source and `@owner/repo/name` a memory of one, so the argument is read
// as a source first and as a memory when no recorded source answers to it.
function installedSourceOrNull(state: State, arg: string, io: EngineIo): string | null {
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
      return target.memories === null
        ? target.key
        : `${target.key} (${target.memories.join(", ")})`;
    case "memory":
      return target.name;
  }
}

export const list: Command = {
  summary: "what state holds, per source and per harness",
  usage: "list",
  arity: 0,
  flags: [],
  async run(_args, ctx) {
    const console = await ctx.openConsole(true);
    const report = await ctx.engine.runList(commonOptions(ctx.global), ctx.io);
    if (ctx.global.json) {
      ctx.io.stdout.write(`${JSON.stringify({ ok: true, sources: report.sources }, null, 2)}\n`);
      return ExitCode.Ok;
    }
    if (report.sources.length === 0) {
      console.step("No sources installed.");
      return ExitCode.Ok;
    }
    for (const scope of ["project", "global", "out"] as const) {
      const entries = report.sources.filter((source) => source.intent.destination.scope === scope);
      if (entries.length === 0) continue;
      console.step(
        scope === "project"
          ? "Project Memories"
          : scope === "global"
            ? "Global Memories"
            : "Output Memories",
      );
      for (const source of entries) {
        const where =
          source.intent.destination.scope === "out" ? `  ${source.intent.destination.path}` : "";
        console.line(`${source.key}${where}`);
        console.line(
          `  Agents: ${source.intent.harnesses.join(", ")}  Memories: ${source.memories.length}`,
        );
        if (source.renamesStale.length > 0) {
          console.warn(
            `  renames no longer resolving a collision: ${source.renamesStale.join(", ")}`,
          );
        }
        if (source.lastError !== null) console.warn(`  last fetch failed: ${source.lastError}`);
      }
    }
    return ExitCode.Ok;
  },
};
