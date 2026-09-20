import type { Console } from "../../console/contract.ts";
import { type Plan, renderPlan } from "../../util/change.ts";
import { ExitCode } from "../../util/exit-codes.ts";
import type { CommandContext } from "./options.ts";

export type Outcome = {
  plan: Plan;
  notices: string[];
  json: Record<string, unknown>;
  lines: string[];
};

// The one exit of every verb that changes something. `--json` writes exactly one document and
// nothing else; `--dry-run` prints the plan the writes would have been; `--quiet` prints the
// engine's notices, one per line, or nothing; the frame gets the verb's own lines plus any notice
// as a warning.
export function finish(ctx: CommandContext, console: Console, outcome: Outcome): number {
  const { io, global } = ctx;
  if (global.json) {
    const body = { ok: true, ...outcome.json, notices: outcome.notices, plan: outcome.plan };
    io.stdout.write(`${JSON.stringify(body, null, 2)}\n`);
    return ExitCode.Ok;
  }
  if (global.quiet) {
    for (const notice of outcome.notices) io.stdout.write(`${notice}\n`);
    return ExitCode.Ok;
  }
  if (global.dryRun) {
    io.stdout.write(renderPlan({ changes: outcome.plan.changes, notices: [] }));
  }
  for (const line of outcome.lines) console.step(line);
  for (const notice of outcome.notices) console.warn(notice);
  return ExitCode.Ok;
}

export function mergePlans(...plans: Plan[]): Plan {
  return {
    changes: plans.flatMap((plan) => plan.changes),
    notices: plans.flatMap((plan) => plan.notices),
  };
}
