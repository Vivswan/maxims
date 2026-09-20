import { wasNotDisabled } from "../console/strings.ts";
import type { Scope } from "../harnesses/contract.ts";
import { syncAfterCommit } from "./add.ts";
import { loadIntent } from "./shared/cli-context.ts";
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
import { resolveMemoryName } from "./shared/sources.ts";

const DISABLE_FLAGS: readonly FlagSpec[] = [FLAGS.global, FLAGS.project, FLAGS.agent, FLAGS.yes];

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
  const scope: Scope = destination?.scope ?? (ctx.io.projectRoot === null ? "global" : "project");
  if (scope === "project" && ctx.io.projectRoot === null) {
    throw usage("a project-scoped change needs a project root", {
      hint: "run inside a git checkout, or pass -g",
    });
  }
  const { state } = await loadIntent(ctx.io.home);
  const resolved = resolveMemoryName(state, ctx.io, positional);
  return { scope, name: resolved.name, key: resolved.key };
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
      const console = await ctx.openConsole(true);
      const edit = await resolveEdit(args, ctx, verb);
      const { changed, state, changes } = await ctx.engine.editDisabled(
        { scope: edit.scope, name: edit.name, disabled, dryRun: ctx.global.dryRun },
        ctx.io,
      );
      if (!changed && !disabled) console.step(wasNotDisabled(edit.name, edit.scope));
      const report = await ctx.engine.runSync(
        syncAfterCommit(ctx, { state, config: ctx.config, changes }, []),
        ctx.io,
      );
      return finish(ctx, console, {
        plan: { changes: [...changes, ...report.plan.changes], notices: [] },
        notices: report.notices,
        json: { memory: edit.name, source: edit.key, scope: edit.scope, disabled, changed },
        lines: changed
          ? [`${disabled ? "Disabled" : "Enabled"} ${edit.name} at ${edit.scope} scope`]
          : [],
      });
    },
  };
}

export const disable = command("disable");
export const enable = command("enable");
