import { count, installedCounts } from "../../console/strings.ts";
import type { EngineContext } from "../../engine/context.ts";
import type { CommonOptions, EngineIo, SyncReport } from "../../engine/types.ts";
import { renderHookStdout } from "../../harnesses/hook-stdin.ts";
import type { State } from "../../state/schema.ts";
import { inspectState, type LoadedState } from "../../state/store.ts";
import { applyChanges, type Change, renderPlan } from "../../util/change.ts";
import { ExitCode, MaximsError } from "../../util/exit-codes.ts";
import { isInside } from "../../util/fs.ts";
import { jsonDocument } from "../../util/json.ts";
import { appendRefreshLog } from "../../util/log.ts";
import type { SyncFailure, SyncOutcome } from "./engine.ts";
import { failedFetches } from "./engine-io.ts";
import { errorDocument, ReportedMaximsError } from "./errors.ts";

export const EMPTY_REPORT: SyncReport = {
  sources: 0,
  memories: 0,
  rules: 0,
  tokens: 0,
  fetched: [],
  held: [],
  heldFiles: [],
  stale: [],
  upstreamChanges: {},
  failed: [],
  changed: [],
  notices: [],
  plan: { changes: [], notices: [] },
};

export type FinishOptions = CommonOptions & { verb: "sync" | "remove" };

// Step 6: apply the plan in order, log what happened, and speak in the channel the run was
// started from. A write failure under `--quiet` stops the run at that change and reports the
// path; every earlier change stays applied, and the next run converges from there. `changed` is
// what landed, not what was planned: a planner may plan a change the apply finds already in
// place, and a hook that counted it would tell the session about a refresh that never happened.
export async function finishSync(
  outcome: SyncOutcome,
  ctx: EngineContext,
  io: EngineIo,
  options: FinishOptions,
): Promise<SyncReport> {
  const { notices } = outcome;
  let applied: Change[] = [];
  try {
    ({ applied } = await applyChanges(outcome.plan, { dryRun: options.dryRun }));
  } catch (error) {
    if (!options.quiet || !(error instanceof MaximsError)) throw error;
    notices.loud(`maxims: ${error.message}`);
    outcome.failures.push({ code: error.code, message: error.message, hint: error.hint });
  }
  const changed = options.dryRun ? outcome.plan.changes : applied;
  const report: SyncReport = {
    ...outcome.report,
    changed: [...new Set(changed.map((change) => change.path))],
  };
  if (!options.dryRun) await writeLog(outcome, applied, ctx, options);
  printOutcome(outcome, report, ctx, io, options);
  const [failure] = outcome.failures;
  if (failure !== undefined && !options.quiet) {
    throw new ReportedMaximsError(failure.code, failure.message, { hint: failure.hint });
  }
  return report;
}

async function writeLog(
  outcome: SyncOutcome,
  applied: readonly Change[],
  ctx: EngineContext,
  options: FinishOptions,
): Promise<void> {
  const stamp = ctx.now.toISOString();
  const lines = [
    ...outcome.report.fetched.map((key) => `refreshed ${key}`),
    ...applied.map((change) => `${change.kind} ${change.path}`),
    ...outcome.notices.log,
  ];
  if (lines.length === 0) return;
  const mode = options.quiet ? `${options.verb} --quiet` : options.verb;
  try {
    for (const line of lines) await appendRefreshLog(ctx.home, `${stamp} ${mode}: ${line}`);
  } catch (error) {
    if (!options.quiet) throw error;
  }
}

// What each channel leaves out, which the code cannot say:
//
// --json     `ok` agrees with the exit a manual run maps from it (a failed refresh is 2 or 3)
// --quiet    the harness protocol, and only the lines a session should hear
// --dry-run  the user notices already ride in the plan as its `note:` lines
// stderr     explains the non-zero exit, which a dry run shares, so both print it
// summary    sync only: a removal's own notice is its report, so no installed count beside it;
//            a standing hold is the run's outcome, so no up-to-date line beside it
function printOutcome(
  outcome: SyncOutcome,
  report: SyncReport,
  ctx: EngineContext,
  io: EngineIo,
  options: FinishOptions,
): void {
  // The store and state live under the maxims home; only a file a harness reads counts as a
  // refresh worth a line.
  const visible = report.changed.filter((path) => !isInside(ctx.home, path));
  const changed = visible.length > 0;
  if (options.json) {
    io.stdout(reportDocument(report, outcome.failures));
    return;
  }
  if (options.quiet) {
    const lines = [...outcome.notices.quietStdout];
    const files = count(visible.length, "file", "files");
    if (changed && options.dryRun)
      lines.push(`maxims: rules would be refreshed (${files} to update)`);
    else if (changed) lines.push(`maxims: rules refreshed (${files} updated)`);
    io.stdout(renderHookStdout(ctx.stdoutVariant, lines));
    return;
  }
  // The engine's notices are the frame's warnings, glyph included, so a sync that refreshed
  // reads like the update that printed the same lines.
  if (options.dryRun) io.stdout(renderPlan(outcome.plan));
  else for (const line of outcome.notices.user) io.stdout(`!  ${line}\n`);
  for (const line of outcome.notices.stderr) io.stderr(`${line}\n`);
  if (options.dryRun || options.verb !== "sync") return;
  if (changed) io.stdout(`${summaryLine(report)}\n`);
  else if (upToDate(outcome, report))
    io.stdout(`o  Up to date: ${installedCounts(report.memories, report.rules)}\n`);
}

function upToDate(outcome: SyncOutcome, report: SyncReport): boolean {
  return (
    outcome.failures.length === 0 &&
    report.failed.length === 0 &&
    report.held.length === 0 &&
    report.heldFiles.length === 0 &&
    report.stale.length === 0
  );
}

export function summaryLine(report: SyncReport): string {
  const tokens = report.tokens > 0 ? ` (~${report.tokens} tokens)` : "";
  return `o  Installed ${installedCounts(report.memories, report.rules)}${tokens}`;
}

// The failure document, when a change failed to apply or a fetch failed, carries what the success
// document carries beside the failure; a failed fetch is the same failure `update` ends in.
function reportDocument(report: SyncReport, failures: SyncFailure[]): string {
  const { plan, ...rest } = report;
  const [failure] = failures;
  if (failure !== undefined) {
    const error = new MaximsError(failure.code, failure.message, { hint: failure.hint });
    return errorDocument(error, { report: rest, plan });
  }
  if (report.failed.length > 0) {
    return errorDocument(failedFetches(report.failed), { report: rest, plan });
  }
  return jsonDocument({ ok: true, report: rest, plan });
}

// The `--json` document of a run that changed nothing and planned nothing.
export function emptyDocument(notices: readonly string[]): string {
  const { plan, ...report } = EMPTY_REPORT;
  return jsonDocument({ ok: true, report: { ...report, notices }, plan });
}

// Under `--json` a failure that escaped the plan is printed as the one document and rethrown as
// already reported, so the caller maps it to an exit and prints nothing more; the original stays
// on `cause` for a log. Any other failure passes through untouched. `extra` is what the verb
// reports beside the failure, as for `errorDocument`.
export function reportedUnderJson(
  error: unknown,
  io: Pick<EngineIo, "stdout">,
  json: boolean,
  extra: Record<string, unknown> = {},
): unknown {
  if (!json || error instanceof ReportedMaximsError) return error;
  io.stdout(errorDocument(error, extra));
  const code = error instanceof MaximsError ? error.code : ExitCode.Usage;
  const message = error instanceof Error ? error.message : String(error);
  return new ReportedMaximsError(code, message, {
    cause: error,
    ...(error instanceof MaximsError && error.hint !== undefined ? { hint: error.hint } : {}),
  });
}

// The newer line names the version alone, so an inspection (which knows no path) can feed it.
export type UnusableState =
  | { kind: "absent" }
  | { kind: "newer"; version: number }
  | Extract<LoadedState, { kind: "quarantined" | "corrupt" }>;

export function unusableStateLine(loaded: UnusableState): string {
  switch (loaded.kind) {
    case "absent":
      return "maxims: nothing installed";
    case "newer":
      return `maxims: state written by a newer maxims (v${loaded.version}), skipping; upgrade maxims to use it`;
    case "quarantined":
      return `maxims: state.json was corrupt and moved to ${loaded.movedTo}; re-add your sources`;
    case "corrupt":
      return `maxims: state.json is corrupt (${loaded.issues[0] ?? "unreadable"}) and ${loaded.lockedBy}; nothing synced`;
  }
}

export type PreviewedState =
  | { kind: "loaded"; state: State }
  | { kind: "absent"; line: string }
  | { kind: "unusable"; line: string };

// The state a run that writes nothing plans against: read without the lock, never quarantined
// and never migrated on disk, so a listing or a dry run leaves a broken file exactly as it found
// it and says which locking verb would settle it.
export async function previewState(home: string): Promise<PreviewedState> {
  const inspection = await inspectState(home);
  switch (inspection.kind) {
    case "current":
      return { kind: "loaded", state: inspection.state };
    case "absent":
      return { kind: "absent", line: unusableStateLine(inspection) };
    case "newer":
      return { kind: "unusable", line: unusableStateLine(inspection) };
    case "corrupt":
      return {
        kind: "unusable",
        line: `maxims: state.json is corrupt: ${inspection.issues[0] ?? "unreadable"}; run maxims sync to quarantine it`,
      };
    case "migrated":
      return { kind: "unusable", line: "maxims: state.json needs migration; run maxims sync" };
  }
}
