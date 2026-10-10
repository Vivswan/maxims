import { ExitCode, MaximsError } from "../../util/exit-codes.ts";
import { jsonDocument } from "../../util/json.ts";

// A failure the run has already printed (as the `--json` document or the interactive lines), so
// the caller maps it to an exit code without printing it a second time. It lives apart from the
// report module so the command line can recognize it without drawing the planner in.
export class ReportedMaximsError extends MaximsError {}

// The one `--json` failure document, whichever printer: the command line for an uncaught failure,
// the engine for a failed sync, a verb for a run that finished with a failure to report. A defect
// with no exit code takes the usage code, and `hint` is null rather than absent so a reader can
// always address it. `extra` is the verb's own fields beside the failure (a dry run's plan, a
// partly failed update's warnings).
export function errorDocument(error: unknown, extra: Record<string, unknown> = {}): string {
  const code = error instanceof MaximsError ? error.code : ExitCode.Usage;
  const hint = error instanceof MaximsError ? (error.hint ?? null) : null;
  const message = error instanceof Error ? error.message : String(error);
  return jsonDocument({ ok: false, code, message, hint, ...extra });
}
