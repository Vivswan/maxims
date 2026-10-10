import type { Console } from "../../console/contract.ts";
import { type Plan, renderPlan } from "../../util/change.ts";
import { ExitCode, type MaximsError } from "../../util/exit-codes.ts";
import { jsonDocument } from "../../util/json.ts";
import { errorDocument, ReportedMaximsError } from "./errors.ts";
import type { CommandContext } from "./options.ts";

// `code` is the exit of a run that finished its work and still has something to report as failed
// (a source whose refresh failed); absent means success.
export type Outcome = {
  plan: Plan;
  notices: string[];
  json: Record<string, unknown>;
  lines: string[];
  code?: ExitCode;
};

// The one exit of every verb that changes something. `--json` writes exactly one document and
// nothing else; `--dry-run` prints the plan the writes would have been; `--quiet` prints the
// engine's notices, one per line, or nothing, and exits 0 whatever `code` says, because it is the
// hook's mode; the frame gets the verb's own lines plus any notice as a warning.
export function finish(ctx: CommandContext, console: Console, outcome: Outcome): number {
  const { io, global } = ctx;
  const code = outcome.code ?? ExitCode.Ok;
  if (global.json) {
    const body = { ok: code === ExitCode.Ok, ...documentFields(outcome) };
    io.stdout.write(jsonDocument(body));
    return code;
  }
  if (global.quiet) {
    printQuiet(ctx, outcome);
    return ExitCode.Ok;
  }
  printFrame(ctx, console, outcome);
  return code;
}

// The exit of a verb that finished its work and failed: the frame a finished run ends in, then
// the failure for the command line to print. Under `--json` the one document is the failure's
// with the success document's fields (a dry run's plan as `sync --json` puts it), and the error
// comes back already reported. `--quiet` prints the notices alone, and the command line logs
// either error once.
export function failed(
  ctx: CommandContext,
  console: Console,
  outcome: Omit<Outcome, "code">,
  error: MaximsError,
): MaximsError {
  const { io, global } = ctx;
  if (global.json) {
    io.stdout.write(errorDocument(error, documentFields(outcome)));
    return new ReportedMaximsError(error.code, error.message, { hint: error.hint });
  }
  if (global.quiet) {
    printQuiet(ctx, outcome);
    return error;
  }
  printFrame(ctx, console, outcome);
  return error;
}

function documentFields(outcome: Omit<Outcome, "code">): Record<string, unknown> {
  return { ...outcome.json, notices: outcome.notices, plan: outcome.plan };
}

function printQuiet(ctx: CommandContext, outcome: Omit<Outcome, "code">): void {
  for (const notice of outcome.notices) ctx.io.stdout.write(`${notice}\n`);
}

function printFrame(ctx: CommandContext, console: Console, outcome: Omit<Outcome, "code">): void {
  if (ctx.global.dryRun) {
    ctx.io.stdout.write(renderPlan({ changes: outcome.plan.changes, notices: [] }));
  }
  for (const line of outcome.lines) console.step(line);
  for (const notice of outcome.notices) console.warn(notice);
}

export function mergePlans(...plans: Plan[]): Plan {
  return {
    changes: plans.flatMap((plan) => plan.changes),
    notices: plans.flatMap((plan) => plan.notices),
  };
}
