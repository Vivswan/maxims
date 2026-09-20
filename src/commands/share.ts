import { applyChanges } from "../util/change.ts";
import { ExitCode, MaximsError } from "../util/exit-codes.ts";
import { assertShareable, syncCommitted } from "./add.ts";
import { loadIntentFor, updateIntent } from "./shared/cli-context.ts";
import { type Command, FLAGS, type FlagSpec, parseDestination, usage } from "./shared/options.ts";
import { finish } from "./shared/output.ts";
import { lockChanges } from "./shared/project-lock-io.ts";
import { findInstalledSource, installedElsewhere, withShared } from "./shared/sources.ts";

const SHARE_FLAGS: readonly FlagSpec[] = [FLAGS.global, FLAGS.project];

// `share` and `unshare` edit one intent field of a project-scope source, whether the project lock
// carries it for teammates, and never touch what is installed. The source must be this project's:
// a user-scope source has no lock to enter, and another project's lock is written from there.
function command(verb: "share" | "unshare"): Command {
  const shared = verb === "share";
  return {
    summary: shared
      ? "put a project-scope source into .agents/maxims.lock for teammates"
      : "take a project-scope source out of .agents/maxims.lock, keeping it installed",
    usage: `${verb} <source>`,
    arity: 1,
    flags: SHARE_FLAGS,
    async run(args, ctx) {
      const { io } = ctx;
      const positional = args.positionals[0];
      if (positional === undefined) throw usage(`${verb} needs a source`);
      const destination = parseDestination(args, io.cwd, io.projectRoot);
      if (destination !== null && destination.scope !== "project") {
        throw usage(`${verb} applies to a project-scope source; drop -g`, {
          hint: "a user-scope source has no project lock to appear in",
        });
      }
      if (io.projectRoot === null) {
        throw usage(`${verb} needs a project root`, { hint: "run inside a git checkout" });
      }
      const console = await ctx.openConsole(true);
      const { state } = await loadIntentFor(io.home, ctx.global.dryRun);
      const key = findInstalledSource(state, positional, io);
      const update = await updateIntent(
        io.home,
        ctx.global.dryRun,
        async (current) => {
          const existing = current.state.sources[key];
          if (existing === undefined)
            throw new MaximsError(ExitCode.Usage, `${key} is not installed`);
          const { destination: recorded } = existing.intent;
          if (recorded.scope !== "project") {
            throw usage(
              `${key} is installed at ${recorded.scope} scope; ${verb} applies to a project source`,
            );
          }
          if (recorded.root !== io.projectRoot) throw installedElsewhere(key, recorded.root);
          if (shared) assertShareable(existing.intent.from, recorded.root);
          const entry = withShared(existing, shared);
          const next = { ...current.state, sources: { ...current.state.sources, [key]: entry } };
          return {
            state: next,
            changes: await lockChanges(entry, current.state, next, io),
            notices: current.notices,
          };
        },
        (plan) => applyChanges(plan, { dryRun: ctx.global.dryRun }),
      );
      const report = await syncCommitted(
        ctx,
        { state: update.state, config: ctx.config, changes: update.changes },
        [],
      );
      return finish(ctx, console, {
        plan: { changes: [...update.changes, ...report.plan.changes], notices: [] },
        notices: [...update.notices, ...report.notices],
        json: { source: key, shared },
        lines: [shared ? `Shared ${key}` : `Unshared ${key}`],
      });
    },
  };
}

export const share = command("share");
export const unshare = command("unshare");
