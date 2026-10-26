// The refresh round that opens a sync: every fetched source that acts here goes through
// `refreshSource`, what a refresh brought in waits on admission, and a stale source is judged
// here. `planSync` runs it once; `planInstall` and `readTrees` read its result.

import type { HarnessId } from "../contracts/harness-id.ts";
import type { LastError } from "../contracts/last-error.ts";
import { isLiveLocal } from "../contracts/source.ts";
import type { ContentHash } from "../memory/contract.ts";
import { STALE_REASON, type Staleness } from "../rulefile/types.ts";
import type { Fetched, SourceEntry, State } from "../state/schema.ts";
import type { Change } from "../util/change.ts";
import { actsHere, type EngineContext } from "./context.ts";
import { DAY_MS, type FetchedEntry, type RefreshResult, refreshSource } from "./fetch.ts";
import type { SourceTree } from "./memories.ts";
import type { Notices } from "./notices.ts";
import type { EngineIo, FetchIntent, HarnessFilter, SyncOptions, SyncReport } from "./types.ts";

const STALE_AT_ONCE: ReadonlySet<LastError["kind"]> = new Set(["missing", "invalid"]);

export function isFetchedEntry(entry: SourceEntry): entry is FetchedEntry {
  return !isLiveLocal(entry.intent.from);
}

// The content hashes a set of entries recorded at their last fetch: what a copy of theirs in a
// bodies directory would hash to, so it is told from the user's own file with the same name.
export function recordedCopies(entries: readonly SourceEntry[]): Set<ContentHash> {
  const copies = new Set<ContentHash>();
  for (const entry of entries) {
    const fetched = isFetchedEntry(entry) ? entry.fetched : undefined;
    for (const facts of Object.values(fetched?.memories ?? {})) copies.add(facts.content);
  }
  return copies;
}

export function shortSha(sha: string): string {
  return sha.replace(/^sha256:/, "").slice(0, 7);
}

// `storeChanges` wait per source until admission: a fresh fetch that collides or exceeds the cap is
// refused whole, and `refuse` puts the previous entry back so store and state keep last-good.
//   pendingChanges   answer to no admission: the store copy the run installs from is unchanged
//   changeLines      what a held revision changes stays out of them
//   lines            shown only once the refresh has survived admission
export type Refreshed = {
  sources: State["sources"];
  freshTrees: Map<string, SourceTree>;
  storeChanges: Map<string, Change[]>;
  pendingChanges: Map<string, Change[]>;
  changeLines: Map<string, string[]>;
  lines: Map<string, string[]>;
  fetchedKeys: string[];
  failed: SyncReport["failed"];
  refuse(key: string): void;
};

// What a fresh refresh earns to say once it has survived admission.
function freshLines(key: string, result: Extract<RefreshResult, { outcome: "fresh" }>): string[] {
  const lines = [`maxims: ${key} refreshed (${shortSha(result.tree.sha)})`];
  if (result.newUpstream.length > 0) {
    const names = result.newUpstream.join(", ");
    lines.push(`maxims: ${key} has new memories not in your selection: ${names}`);
  }
  return lines;
}

// Until a transient failure is said out loud, the run's non-zero exit has this line to explain
// it; none once the staleness notice says it, or for a failure that is said at once.
function failureAside(
  key: string,
  result: Extract<RefreshResult, { outcome: "failed" | "no-valid" }>,
  ctx: EngineContext,
): string | null {
  if (STALE_AT_ONCE.has(result.error.kind)) return null;
  if (staleness(result.entry.fetched, ctx.now, ctx.cooldownDays) !== undefined) return null;
  return `maxims: ${key}: fetch failed (${STALE_REASON[result.error.kind]}); kept last-good`;
}

// A failed fetch is never a stop: the source keeps last-good and the failure is reported, so the
// caller decides what a manual run's exit says about it. A hold is traced line by line here; the
// install pass says it to the user, since a standing hold is said at every run.
export async function refreshAll(
  state: State,
  ctx: EngineContext,
  io: EngineIo,
  options: SyncOptions,
  notices: Notices,
): Promise<Refreshed> {
  const sources: State["sources"] = {};
  const freshTrees = new Map<string, SourceTree>();
  const storeChanges = new Map<string, Change[]>();
  const pendingChanges = new Map<string, Change[]>();
  const changeLines = new Map<string, string[]>();
  const lines = new Map<string, string[]>();
  const fetchedKeys: string[] = [];
  const failed: SyncReport["failed"] = [];
  for (const key of Object.keys(state.sources).sort()) {
    const entry = state.sources[key];
    if (entry === undefined) continue;
    if (!isFetchedEntry(entry) || !actsHere(entry, ctx)) {
      sources[key] = entry;
      continue;
    }
    const result = await refreshSource(key, entry, ctx, io, notices, {
      fetch: fetchIntentFor(key, options),
    });
    sources[key] = result.entry;
    switch (result.outcome) {
      case "fresh":
        fetchedKeys.push(key);
        freshTrees.set(key, result.tree);
        storeChanges.set(key, result.storeChanges);
        changeLines.set(key, result.changeLines);
        lines.set(key, freshLines(key, result));
        break;
      case "held": {
        pendingChanges.set(key, result.storeChanges);
        for (const line of result.summary) notices.trace(`${key}: held ${line}`);
        break;
      }
      case "failed":
      case "no-valid": {
        notices.trace(`${key}: fetch failed (${result.error.kind}): ${result.error.message}`);
        failed.push({ key, message: result.error.message, kind: result.error.kind });
        const aside = failureAside(key, result, ctx);
        if (aside !== null) notices.aside(aside);
        break;
      }
      case "skipped":
      case "not-due":
      case "unchanged":
        break;
    }
  }
  return {
    sources,
    freshTrees,
    storeChanges,
    pendingChanges,
    changeLines,
    lines,
    fetchedKeys,
    failed,
    refuse(key) {
      if (!freshTrees.has(key)) return;
      const previous = state.sources[key];
      if (previous !== undefined) sources[key] = previous;
      freshTrees.delete(key);
      storeChanges.delete(key);
      changeLines.delete(key);
      lines.delete(key);
      fetchedKeys.splice(fetchedKeys.indexOf(key), 1);
      notices.trace(`${key}: refresh refused; last-good kept`);
    },
  };
}

// A store swap removes the bodies every rule file of the source points at, so a run limited by
// `-a` that refreshed a source writes every harness that source lists.
export function widenedAgents(
  agents: HarnessFilter | undefined,
  refreshed: Refreshed,
): HarnessFilter | undefined {
  if (agents === undefined) return undefined;
  const widened = new Set<HarnessId>(agents);
  for (const key of refreshed.freshTrees.keys()) {
    for (const id of refreshed.sources[key]?.intent.harnesses ?? []) widened.add(id);
  }
  const [first, ...rest] = widened;
  return first === undefined ? agents : [first, ...rest];
}

// A `due` run limited to some harnesses fetches nothing, since a refresh reaches every harness's
// rule file; a forced one fetches, and the planner widens the filter to the refreshed sources'
// harnesses.
function fetchIntentFor(key: string, options: SyncOptions): FetchIntent {
  if (options.only !== undefined && !options.only.includes(key)) return "none";
  if (options.fetch === "due" && options.agents !== undefined) return "none";
  return options.fetch;
}

const STALE_GRACE_MS = 7 * DAY_MS;

// Stale means fetching has been failing: at once for a kind in `STALE_AT_ONCE`, and for a
// transient kind once the longer of a week and the cooldown has passed, since a source is not
// stale before its refresh was due. Until then `refreshAll`'s aside is the failure's one stderr
// line.
export function staleness(
  fetched: Fetched | undefined,
  now: Date,
  cooldownDays: number,
): Staleness | undefined {
  if (fetched === undefined || fetched.lastError === null) return undefined;
  const { kind } = fetched.lastError;
  if (STALE_AT_ONCE.has(kind)) return { since: fetched.at, kind };
  const staleAfterMs = Math.max(STALE_GRACE_MS, cooldownDays * DAY_MS);
  if (now.getTime() - Date.parse(fetched.at) >= staleAfterMs) return { since: fetched.at, kind };
  return undefined;
}
