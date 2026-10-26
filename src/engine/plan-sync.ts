import type { ContentHash } from "../memory/contract.ts";
import type { SourceEntry, State } from "../state/schema.ts";
import type { Change, Plan } from "../util/change.ts";
import type { ExitCode } from "../util/exit-codes.ts";
import { compareCodeUnits } from "../util/order.ts";
import { actsHere, type EngineContext } from "./context.ts";
import { Notices } from "./notices.ts";
import { planInstall } from "./plan-install.ts";
import { readProjectLock } from "./project-lock-read.ts";
import { findSourceKey } from "./source-key.ts";
import { refreshAll } from "./sync-refresh.ts";
import { previewStoreTrees } from "./sync-trees.ts";
import type { EngineIo, SyncOptions, SyncReport } from "./types.ts";

export type SyncFailure = { code: ExitCode; message: string; hint?: string };

//   previousState  -> the state as the caller read it under the lock; the state write is planned
//                     when the state this run ends with differs from it, whether the caller or the
//                     fetch step changed it
//   removed        -> entries the caller took out of intent: their `-o` folders are swept (no
//                     harness sweep reaches them), and the content hashes of their bodies let a
//                     copied body under a project be told from the user's own file with the same
//                     name
export type SyncExtras = {
  verb: "sync" | "remove";
  previousState: State;
  extraChanges: readonly Change[];
  removed: readonly SourceEntry[];
  removedCopies: ReadonlySet<ContentHash>;
};

// `changed` is known only once the plan has been applied, so the outcome's report lacks it.
export type SyncOutcome = {
  plan: Plan;
  deferred: Change[];
  report: Omit<SyncReport, "changed">;
  nextState: State;
  failures: SyncFailure[];
  notices: Notices;
};

// Steps 2 to 5 of a sync over a state already read under the lock, as one plan: store swaps,
// bodies, rule files, hook and config reconciliation, the orphan sweep and the state write.
// A fresh refresh that is refused (collision, cap, byte budget) is rolled back to the source's
// last-good copy and the whole installation is planned again from it, so what the retained rules
// point at is what the name index and the sweeps see; the refusal's own lines are carried over.
export async function planSync(
  state: State,
  ctx: EngineContext,
  io: EngineIo,
  options: SyncOptions,
  extras: SyncExtras,
): Promise<SyncOutcome> {
  const base = new Notices();
  if (ctx.configIssue !== null) base.notice(`maxims: ${ctx.configIssue}`);
  await noticeLockOnlySources(state, ctx, base, [
    ...extras.extraChanges,
    ...(options.preview?.changes ?? []),
  ]);
  const refreshed = await refreshAll(state, ctx, io, options, base);
  const overlay = previewStoreTrees(options.preview, ctx);
  const carried = new Notices();
  const carriedFailures: SyncFailure[] = [];
  // A readable source refused by admission is planned again as if unreadable: its block stays
  // and the names that block points at stay reserved, so no newer source takes its bodies over.
  const held = new Set<string>();
  for (;;) {
    const attempt = await planInstall(state, ctx, io, options, extras, refreshed, held, overlay);
    const retry = [...attempt.refusedFresh, ...attempt.refusedKept];
    if (retry.length === 0) {
      const notices = new Notices();
      notices.absorb(base);
      for (const key of refreshed.fetchedKeys) {
        for (const line of refreshed.lines.get(key) ?? []) notices.notice(line);
        for (const line of refreshed.changeLines.get(key) ?? []) notices.notice(line);
      }
      // A reason is said once, whether the final attempt found it again on its own or a source
      // earned it twice (refused fresh, then again from last-good), and on the channel it was
      // first said on: a held source's lines stay loud so a hook session hears them.
      const said = new Set(attempt.notices.user);
      const loud = new Set(carried.quietStdout);
      for (const line of carried.user) {
        if (said.has(line)) continue;
        said.add(line);
        if (loud.has(line)) notices.loud(line);
        else notices.notice(line);
      }
      notices.absorb(attempt.notices);
      const found = new Set(attempt.failures.map((failure) => failure.message));
      const failures = [
        ...carriedFailures.filter((failure) => !found.has(failure.message)),
        ...attempt.failures,
      ];
      const built = attempt.builder.build({
        deferDeletions: attempt.hookRun,
        notices: notices.user,
      });
      if (built.deferred.length > 0) {
        notices.trace(`deferred ${built.deferred.length} deletion(s) until an interactive sync`);
      }
      const failed = [...refreshed.failed, ...attempt.failed].sort((a, b) =>
        compareCodeUnits(a.key, b.key),
      );
      return {
        plan: built.plan,
        deferred: built.deferred,
        report: {
          sources: attempt.sources,
          memories: attempt.memories,
          rules: attempt.rules,
          tokens: attempt.tokens,
          fetched: refreshed.fetchedKeys,
          held: attempt.awaitingReview.map((source) => source.key),
          heldFiles: attempt.heldFiles,
          stale: attempt.stale,
          upstreamChanges: Object.fromEntries([
            ...refreshed.fetchedKeys.map((key) => [key, refreshed.changeLines.get(key) ?? []]),
            ...attempt.awaitingReview.map((source) => [source.key, source.summary]),
          ]),
          failed,
          notices: notices.user,
          plan: built.plan,
        },
        nextState: attempt.nextState,
        failures,
        notices,
      };
    }
    for (const key of attempt.refusedFresh) refreshed.refuse(key);
    for (const key of attempt.refusedKept) held.add(key);
    // Only the refused sources' own refusals travel: an unrelated failure is found again by the
    // next attempt, and would otherwise be reported twice. One reason shared by several sources
    // (a held file they all render into) travels once.
    const seen = new Set<Notices>();
    for (const refusal of attempt.refusals) {
      if (!retry.includes(refusal.key) || seen.has(refusal.said)) continue;
      seen.add(refusal.said);
      carried.absorb(refusal.said);
      if (refusal.failure !== null) carriedFailures.push(refusal.failure);
    }
  }
}

// The lock is a projection the CLI writes; sync only says when it names a source this machine
// never installed, and never installs from it. The lock judged is the one this run leaves behind:
// a rewrite the caller planned beside the state edit counts before it lands.
async function noticeLockOnlySources(
  state: State,
  ctx: EngineContext,
  notices: Notices,
  planned: readonly Change[],
): Promise<void> {
  if (ctx.projectRoot === null) return;
  const lock = await readProjectLock(ctx.projectRoot, planned);
  if (lock.kind === "corrupt") {
    notices.notice(`maxims: ${lock.path} could not be read: ${lock.issues.join("; ")}`);
    return;
  }
  if (lock.kind !== "parsed") return;
  const missing = lock.keys.filter((key) => !installedHere(state, key, ctx));
  if (missing.length === 0) return;
  const verb = missing.length === 1 ? "is" : "are";
  notices.notice(
    `maxims: ${missing.join(", ")} ${verb} in .agents/maxims.lock but not installed here; run maxims install`,
  );
}

// A lock entry is installed here when state holds it for this project (or the user), not merely
// for some other checkout. A teammate's `@Acme/rules` is this machine's `@acme/rules`, the same
// identity the lock merge uses.
export function installedHere(
  state: State,
  key: string,
  ctx: { projectRoot: string | null },
): boolean {
  const recorded = findSourceKey(state, key);
  const entry = recorded === null ? undefined : state.sources[recorded];
  return entry !== undefined && actsHere(entry, ctx);
}
