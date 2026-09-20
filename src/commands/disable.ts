import { wasNotDisabled } from "../console/strings.ts";
import { applyChanges } from "../util/change.ts";
import { syncCommitted } from "./add.ts";
import {
  type DisabledScope,
  loadIntentFor,
  updateIntent,
  withDisabled,
} from "./shared/cli-context.ts";
import {
  type Args,
  type Command,
  type CommandContext,
  FLAGS,
  type FlagSpec,
  parseDestination,
  usage,
} from "./shared/options.ts";
import { finish } from "./shared/output.ts";
import { projectLockChange } from "./shared/project-lock-io.ts";
import { resolveMemoryName } from "./shared/sources.ts";

const DISABLE_FLAGS: readonly FlagSpec[] = [FLAGS.global, FLAGS.project, FLAGS.agent];

// A disabled memory stays in state and loses its rule line and link at one scope. The list is per
// scope, so a harness cannot be named: `-a` has no representation there and is refused.
async function resolveEdit(args: Args, ctx: CommandContext, verb: string) {
  const positional = args.positionals[0];
  if (positional === undefined)
    throw usage(`${verb} needs a memory name`, { hint: `maxims ${verb} <memory>` });
  if (args.list(FLAGS.agent).length > 0) {
    throw usage(`${verb} applies per scope, not per harness; drop -a`, {
      hint: `maxims unlink <source> -a <harness> removes one harness's copy`,
    });
  }
  const destination = parseDestination(args, ctx.io.cwd);
  if (destination?.scope === "out") throw usage(`${verb} takes -g or -p, not -o`);
  const scope = destination?.scope ?? (ctx.io.projectRoot === null ? "global" : "project");
  let at: DisabledScope;
  if (scope === "global") at = { scope };
  else if (ctx.io.projectRoot !== null) at = { scope, root: ctx.io.projectRoot };
  else {
    throw usage("a project-scoped change needs a project root", {
      hint: "run inside a git checkout, or pass -g",
    });
  }
  const { state } = await loadIntentFor(ctx.io.home, ctx.global.dryRun);
  const resolved = resolveMemoryName(state, ctx.io, positional);
  return { at, name: resolved.name, key: resolved.key };
}

function command(verb: "disable" | "enable"): Command {
  const disabled = verb === "disable";
  return {
    summary: disabled
      ? "withhold a memory's rule line and link at this scope, then sync"
      : "undo disable for a memory at this scope, then sync",
    usage: `${verb} <memory>`,
    arity: 1,
    flags: DISABLE_FLAGS,
    async run(args, ctx) {
      const { io } = ctx;
      const console = await ctx.openConsole(true);
      const edit = await resolveEdit(args, ctx, verb);
      let changed = false;
      const update = await updateIntent(
        io.home,
        ctx.global.dryRun,
        async (current) => {
          const next = withDisabled(current.state, edit.at, edit.name, disabled);
          changed = next.changed;
          // The manifest carries a copy of the project's list, so the list's edit rewrites it.
          const changes =
            next.changed && edit.at.scope === "project"
              ? [projectLockChange(edit.at.root, next.state)]
              : [];
          return { state: next.state, changes, notices: current.notices };
        },
        (plan) => applyChanges(plan, { dryRun: ctx.global.dryRun }),
      );
      if (!changed && !disabled) console.step(wasNotDisabled(edit.name, edit.at.scope));
      const report = await syncCommitted(
        ctx,
        { state: update.state, config: ctx.config, changes: update.changes },
        [],
      );
      return finish(ctx, console, {
        plan: { changes: [...update.changes, ...report.plan.changes], notices: [] },
        notices: [...update.notices, ...report.notices],
        json: { memory: edit.name, source: edit.key, scope: edit.at.scope, disabled, changed },
        lines: changed
          ? [`${disabled ? "Disabled" : "Enabled"} ${edit.name} at ${edit.at.scope} scope`]
          : [],
      });
    },
  };
}

export const disable = command("disable");
export const enable = command("enable");
