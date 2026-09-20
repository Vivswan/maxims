import type { State } from "../state/schema.ts";
import type { StateLock } from "../state/store.ts";
import { withStateLock } from "../state/store.ts";
import { maximsHome } from "../util/home.ts";
import { appendRefreshLog } from "../util/log.ts";
import { type EngineContext, loadContext } from "./shared/context.ts";
import { isDebounced, stampLastSync } from "./shared/debounce.ts";
import { planSync } from "./shared/engine.ts";
import {
  EMPTY_REPORT,
  emptyDocument,
  errorDocument,
  finishSync,
  previewState,
  ReportedMaximsError,
  unusableStateLine,
} from "./shared/report.ts";
import type { EngineIo, SyncOptions, SyncReport } from "./types.ts";

// The verb every other verb ends in. Under `--quiet` nothing here may throw or block: the run is
// debounced, takes the lock without waiting, and any failure past the rungs the plan handles is
// logged with its stack and swallowed, so a session start never sees a failing hook.
export async function runSync(options: SyncOptions, io: EngineIo): Promise<SyncReport> {
  try {
    return await runSyncChecked(options, io);
  } catch (error) {
    if (options.json && !(error instanceof ReportedMaximsError)) io.stdout(errorDocument(error));
    if (options.quiet) {
      await logCrash(io, error);
      return EMPTY_REPORT;
    }
    throw error;
  }
}

async function runSyncChecked(options: SyncOptions, io: EngineIo): Promise<SyncReport> {
  const ctx = await loadContext(io, { readHookStdin: options.quiet });
  // The two quiet no-op paths: nothing is read or written, and `--json` still gets its document.
  const skipped = (line: string): SyncReport => {
    if (options.json) io.stdout(emptyDocument([line]));
    return { ...EMPTY_REPORT, notices: [line] };
  };
  if (options.quiet && isDebounced(ctx.paths, ctx.now)) {
    return skipped("maxims: skipped, a sync ran less than a minute ago");
  }
  if (options.dryRun) return syncPreview(ctx, io, options);
  stampLastSync(ctx.home, ctx.paths, ctx.now);
  const run = (lock: StateLock): Promise<SyncReport> => syncUnderLock(lock, ctx, io, options);
  if (!options.quiet) return withStateLock(ctx.home, "manual", run);
  const outcome = await withStateLock(ctx.home, "hook", run);
  if (outcome.kind === "ran") return outcome.value;
  await appendRefreshLog(
    ctx.home,
    `${ctx.now.toISOString()} sync --quiet: skipped, ${outcome.reason}`,
  );
  return skipped(`maxims: skipped, ${outcome.reason}`);
}

async function syncUnderLock(
  lock: StateLock,
  ctx: EngineContext,
  io: EngineIo,
  options: SyncOptions,
): Promise<SyncReport> {
  const loaded = await lock.read();
  if (loaded.kind !== "loaded")
    return reportUnusableState(unusableStateLine(loaded), ctx, io, options);
  return planAndFinish(loaded.state, ctx, io, options);
}

// A dry run takes no lock and settles nothing: a corrupt or outdated file is left as it is and
// named, since the run that would move it aside is the one that writes.
async function syncPreview(
  ctx: EngineContext,
  io: EngineIo,
  options: SyncOptions,
): Promise<SyncReport> {
  const preview = await previewState(ctx.home);
  if (preview.kind !== "loaded") return reportUnusableState(preview.line, ctx, io, options);
  return planAndFinish(preview.state, ctx, io, options);
}

async function planAndFinish(
  state: State,
  ctx: EngineContext,
  io: EngineIo,
  options: SyncOptions,
): Promise<SyncReport> {
  const outcome = await planSync(state, ctx, io, options, {
    verb: "sync",
    previousState: state,
    extraChanges: [],
    removed: [],
    removedCopies: new Set(),
  });
  return finishSync(outcome, ctx, io, { ...options, verb: "sync" });
}

// Step 1's stops. Each is a clean exit 0 that changes nothing: under `--quiet` the line goes to
// the log alone, since a hook has no user to tell and a corrupt file must not empty a machine; an
// interactive run prints it.
async function reportUnusableState(
  line: string,
  ctx: EngineContext,
  io: EngineIo,
  options: SyncOptions,
): Promise<SyncReport> {
  if (!options.dryRun) await appendRefreshLog(ctx.home, `${ctx.now.toISOString()} sync: ${line}`);
  if (options.json) {
    io.stdout(emptyDocument([line]));
  } else if (!options.quiet) {
    io.stdout(`${line}\n`);
  }
  return { ...EMPTY_REPORT, notices: [line] };
}

// The only place a stack trace is written: everything the plan can classify is one log line.
async function logCrash(io: EngineIo, error: unknown): Promise<void> {
  const detail = error instanceof Error ? (error.stack ?? error.message) : String(error);
  try {
    await appendRefreshLog(
      maximsHome(io.env),
      `${io.now().toISOString()} sync --quiet: crashed\n${detail}`,
    );
  } catch {
    // The log is the last resort; a home that cannot be written has nowhere left to report to.
  }
}
