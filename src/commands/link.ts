import { noTargetAtScope } from "../console/strings.ts";
import type { HarnessId } from "../harnesses/contract.ts";
import type { State } from "../state/schema.ts";
import { applyChanges } from "../util/change.ts";
import { ExitCode, MaximsError } from "../util/exit-codes.ts";
import { syncAfterCommit } from "./add.ts";
import { loadIntent, updateIntent } from "./shared/cli-context.ts";
import {
  type Args,
  type Command,
  type CommandContext,
  commonOptions,
  FLAGS,
  type FlagSpec,
  parseAgents,
  usage,
} from "./shared/options.ts";
import { finish } from "./shared/output.ts";
import { planProjectLock } from "./shared/project-lock-io.ts";
import {
  findInstalledSource,
  harnessById,
  knownHarnessIds,
  scopeOf,
  withIntent,
} from "./shared/sources.ts";

const LINK_FLAGS: readonly FlagSpec[] = [FLAGS.agent, FLAGS.yes];

type LinkTarget = { key: string; ids: HarnessId[] };

// `link` and `unlink` edit one intent field, the source's harness list, and never refetch.
async function linkTarget(
  args: Args,
  ctx: CommandContext,
  verb: string,
): Promise<{ target: LinkTarget; state: State }> {
  const positional = args.positionals[0];
  if (positional === undefined)
    throw usage(`${verb} needs a source`, { hint: `maxims ${verb} <source> -a <harness>` });
  const selection = parseAgents(args, knownHarnessIds(ctx.io));
  if (selection.kind !== "ids") throw usage(`${verb} needs -a <harness>`);
  const { state } = await loadIntent(ctx.io.home);
  const key = findInstalledSource(state, positional, ctx.io);
  return { target: { key, ids: selection.ids }, state };
}

export const link: Command = {
  summary: "add a harness to a source's recorded list, then sync",
  usage: "link <source> -a <harness>",
  arity: 1,
  flags: LINK_FLAGS,
  async run(args, ctx) {
    const { io } = ctx;
    const console = await ctx.openConsole(true);
    const { target, state } = await linkTarget(args, ctx, "link");
    const entry = state.sources[target.key];
    if (entry === undefined)
      throw new MaximsError(ExitCode.Usage, `${target.key} is not installed`);
    const scope = scopeOf(entry.intent.destination);
    const added: HarnessId[] = [];
    const warnings: string[] = [];
    for (const id of target.ids) {
      if (entry.intent.harnesses.includes(id)) continue;
      const def = harnessById(io, id);
      if (entry.intent.destination.scope !== "out" && def.targets[scope] === null) {
        warnings.push(noTargetAtScope(id, scope));
        continue;
      }
      added.push(id);
    }
    for (const warning of warnings) console.warn(warning);
    if (added.length === 0) {
      throw new MaximsError(
        ExitCode.NothingResolved,
        `nothing to link: ${target.key} already targets ${target.ids.join(", ")} or they have no ${scope} target`,
      );
    }
    const update = await updateIntent(
      io.home,
      ctx.global.dryRun,
      async (current) => {
        const existing = current.state.sources[target.key];
        if (existing === undefined)
          throw new MaximsError(ExitCode.Usage, `${target.key} is not installed`);
        const next: State = {
          ...current.state,
          sources: {
            ...current.state.sources,
            [target.key]: withIntent(existing, {
              harnesses: [...existing.intent.harnesses, ...added],
            }),
          },
        };
        const changes =
          existing.intent.destination.scope === "project" && io.projectRoot !== null
            ? [planProjectLock(io.projectRoot, next)]
            : [];
        return { state: next, changes, notices: current.notices };
      },
      (plan) => applyChanges(plan, { dryRun: ctx.global.dryRun }),
    );
    const preview = { state: update.state, config: ctx.config, changes: update.changes };
    const report = await ctx.engine.runSync(syncAfterCommit(ctx, preview, added), io);
    return finish(ctx, console, {
      plan: { changes: [...update.changes, ...report.plan.changes], notices: [] },
      notices: [...update.notices, ...report.notices],
      json: { source: target.key, linked: added },
      lines: [`Linked ${target.key} to ${added.join(", ")}`],
    });
  },
};

export const unlink: Command = {
  summary: "drop a harness from a source's recorded list, then sync",
  usage: "unlink <source> -a <harness>",
  arity: 1,
  flags: LINK_FLAGS,
  async run(args, ctx) {
    const console = await ctx.openConsole(true);
    const { target } = await linkTarget(args, ctx, "unlink");
    const report = await ctx.engine.runRemove(
      {
        ...commonOptions(ctx.global),
        target: { kind: "source", key: target.key, memories: null, agents: target.ids },
      },
      ctx.io,
    );
    return finish(ctx, console, {
      plan: report.plan,
      notices: report.notices,
      json: { source: target.key, unlinked: target.ids, removed: report.removed },
      lines: [`Unlinked ${target.key} from ${target.ids.join(", ")}`],
    });
  },
};
