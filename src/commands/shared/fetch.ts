import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { contentHashOf, type MemoryName, parseContentHash } from "../../memory/contract.ts";
import { pruneRenames, shortHash } from "../../rulefile/dedupe.ts";
import { needsFetch } from "../../sources/github/index.ts";
import { FetchFailure } from "../../sources/github/ladder.ts";
import type { TreeFile } from "../../sources/tree.ts";
import {
  type Fetched,
  type LastError,
  parseGitSha,
  type RenameMap,
  type SourceEntry,
} from "../../state/schema.ts";
import type { Change } from "../../util/change.ts";
import { ExitCode, MaximsError } from "../../util/exit-codes.ts";
import { assertInsideRoot, type RootedPath } from "../../util/fs.ts";
import { pendingPathFor, storePathFor } from "../../util/home.ts";
import type { EngineIo, FetchIntent } from "../types.ts";
import type { EngineContext } from "./context.ts";
import type { SourceMemory, SourceTree } from "./memories.ts";
import { validateMemoryFiles } from "./memories.ts";
import type { Notices } from "./notices.ts";
import { inSelect } from "./select.ts";

const DAY_MS = 24 * 60 * 60 * 1000;
// A failed fetch is retried well inside the cooldown, since the cooldown clock runs from the last
// SUCCESS and would otherwise ask the network at every session start while a source is down.
export const FAILED_FETCH_RETRY_MS = 60 * 60 * 1000;

export type FetchedEntry = Extract<SourceEntry, { fetched?: Fetched }>;
// The two fetched variants record different sha types (a commit id, a content hash), so every
// edit of a fetch record narrows to one of them first.
export type RemoteEntry = Extract<FetchedEntry, { intent: { from: { ref: string } } }>;

export function isRemoteEntry(entry: FetchedEntry): entry is RemoteEntry {
  return entry.intent.from.type !== "local";
}

// A fresh fetch carries its content: the store swap is only planned at this point, so the rest of
// the run reads the memories from `tree`, not from disk. Every outcome returns the entry to keep,
// with the fetch facts a failure or a confirmed-unchanged remote updated. A `held` fetch is a
// reviewed source's fresh revision parked under the pending root: the entry keeps its last-good
// record and gains `pending`, and `storeChanges` lay the files there, not in the store.
export type RefreshResult =
  | { outcome: "skipped" | "not-due"; entry: FetchedEntry }
  | { outcome: "unchanged"; entry: FetchedEntry }
  | {
      outcome: "fresh";
      entry: FetchedEntry;
      tree: SourceTree;
      storeChanges: Change[];
      newUpstream: MemoryName[];
    }
  | { outcome: "held"; entry: FetchedEntry; summary: string[]; storeChanges: Change[] }
  | { outcome: "failed" | "no-valid"; entry: FetchedEntry; error: LastError };

export type RefreshOptions = {
  fetch: FetchIntent;
};

export function storeEntryPath(home: string, entry: SourceEntry): RootedPath {
  return storePathFor(home, entry.intent.from);
}

// Only "nothing is there" reads as absent; an entry that cannot be inspected is treated as present
// so the read that follows reports the real error instead of a needless fetch hiding it.
export async function storeEntryPresent(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch (error) {
    const code = error instanceof Error && "code" in error ? error.code : undefined;
    return code !== "ENOENT" && code !== "ENOTDIR";
  }
}

// Due: never fetched, store copy missing, cooldown elapsed since the last success, or a failure
// old enough to retry (and past any Retry-After). `force` is `update`.
export function isDue(
  fetched: Fetched | undefined,
  now: Date,
  cooldownDays: number,
  storePresent: boolean,
  force: boolean,
): boolean {
  if (force || fetched === undefined || !storePresent) return true;
  const time = now.getTime();
  if (fetched.lastError === null) return time - Date.parse(fetched.at) >= cooldownDays * DAY_MS;
  const { retryAfter, at } = fetched.lastError;
  if (retryAfter !== undefined && time < Date.parse(retryAfter)) return false;
  return time - Date.parse(at) >= FAILED_FETCH_RETRY_MS;
}

// One source's step 2. A failure at any rung keeps the last-good record and store copy and writes
// only `lastError`; a fetch with zero valid memories is the same, classified `invalid`. A remote
// standing at the sha of a revision already held is unchanged: the hold waits, nothing is fetched
// twice. A reviewed source with a last-good copy has its revision held instead of applied; with
// none (never fetched, store copy gone) there is nothing to keep behind, so it applies.
export async function refreshSource(
  key: string,
  entry: FetchedEntry,
  ctx: EngineContext,
  io: EngineIo,
  notices: Notices,
  options: RefreshOptions,
): Promise<RefreshResult> {
  if (options.fetch === "none") return { outcome: "skipped", entry };
  const entryPath = storeEntryPath(ctx.home, entry);
  const storePresent = await storeEntryPresent(entryPath);
  if (!isDue(entry.fetched, ctx.now, ctx.cooldownDays, storePresent, options.fetch === "force")) {
    return { outcome: "not-due", entry };
  }
  const { from } = entry.intent;
  const resolver = io.resolvers(from);
  const auth = entry.intent.auth;
  const tempDir = await mkdtemp(join(tmpdir(), "maxims-fetch-"));
  const now = ctx.now.toISOString();
  const lastGood = storePresent ? entry.fetched : undefined;
  // Upstream standing at the installed revision has nothing to apply, and a hold it may have left
  // behind is withdrawn: what was held is no longer what upstream has. Standing at the held
  // revision, the hold waits and nothing is downloaded twice.
  const settled = (sha: string): RefreshResult | null => {
    if (lastGood === undefined) return null;
    if (!needsFetch(from, lastGood.sha, sha)) {
      if (entry.pending !== undefined) notices.trace(`${key}: held revision withdrawn upstream`);
      return { outcome: "unchanged", entry: withoutPending(touched(entry, now)) };
    }
    if (sha === entry.pending?.sha) return { outcome: "unchanged", entry: touched(entry, now) };
    return null;
  };
  try {
    if (resolver.resolveRef !== undefined && lastGood !== undefined) {
      const byRef = settled(await resolver.resolveRef(from, undefined, { auth }));
      if (byRef !== null) return byRef;
    }
    const result = await resolver.fetch(from, {
      memoryPath: entry.intent.memoryPath,
      fullDepth: entry.intent.fullDepth,
      tempDir,
      auth,
    });
    const byFetch = settled(result.sha);
    if (byFetch !== null) return byFetch;
    const { memories, invalid } = validateMemoryFiles(result.files);
    for (const bad of invalid) notices.notice(`${key}: skipped ${bad.relPath}: ${bad.reason}`);
    if (memories.length === 0) {
      const message = `no valid memories at ${result.memoryPath} (layout probably changed upstream)`;
      return failed(entry, { kind: "invalid", message, at: now }, "no-valid");
    }
    const unusable: LastError = {
      kind: "invalid",
      message: `the source reported an unusable commit id ${JSON.stringify(result.sha)}`,
      at: now,
    };
    const files = memories.map((memory) => ({ relPath: memory.relPath, text: memory.text }));
    if (entry.intent.review === true && lastGood !== undefined) {
      const summary = diffLines(lastGood.memories, memoryFacts(memories));
      const held = heldEntry(entry, result.sha, now, summary);
      if (held === null) return failed(entry, unusable, "failed");
      return {
        outcome: "held",
        entry: held,
        summary,
        storeChanges: swapStoreEntry(pendingPathFor(ctx.home, from), files),
      };
    }
    const names = memories.map((memory) => memory.memory.name);
    const next = fetchedFactsFor(entry, memories, result.memoryPath, { sha: result.sha, at: now });
    if (next === null) return failed(entry, unusable, "failed");
    const previous = new Set(Object.keys(entry.fetched?.memories ?? {}));
    const newUpstream =
      entry.intent.select === "*"
        ? []
        : names.filter((name) => !previous.has(name) && !inSelect(entry.intent.select, name));
    return {
      outcome: "fresh",
      entry: next,
      tree: { sha: result.sha, memories, invalid },
      storeChanges: swapStoreEntry(entryPath, files),
      newUpstream,
    };
  } catch (error) {
    const classified = classifyFetchError(error, now);
    if (classified === null) throw error;
    return failed(entry, classified, "failed");
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
}

// A remote confirmed unchanged: the success clock restarts and a past failure is forgotten.
function touched(entry: FetchedEntry, at: string): FetchedEntry {
  return withFetched(entry, { at, lastError: null });
}

function failed(
  entry: FetchedEntry,
  error: LastError,
  outcome: "failed" | "no-valid",
): RefreshResult {
  return { outcome, entry: withFetched(entry, { lastError: error }), error };
}

// An entry with no record yet has nothing to patch: a failure before the first success is
// reported to the run but leaves the entry as it was.
function withFetched(
  entry: FetchedEntry,
  patch: Partial<Pick<Fetched, "at" | "lastError">>,
): FetchedEntry {
  if (entry.fetched === undefined) return entry;
  if (isRemoteEntry(entry)) return { ...entry, fetched: { ...entry.fetched, ...patch } };
  return { ...entry, fetched: { ...entry.fetched, ...patch } };
}

function withRename(entry: FetchedEntry, rename: RenameMap): FetchedEntry {
  if (isRemoteEntry(entry)) return { ...entry, intent: { ...entry.intent, rename } };
  return { ...entry, intent: { ...entry.intent, rename } };
}

export function withoutPending(entry: FetchedEntry): FetchedEntry {
  if (isRemoteEntry(entry)) {
    const { pending: _withdrawn, ...rest } = entry;
    return rest;
  }
  const { pending: _withdrawn, ...rest } = entry;
  return rest;
}

// What a fetch records per memory: the hashes a later diff and the copy sweep compare by.
export function memoryFacts(memories: readonly SourceMemory[]): Fetched["memories"] {
  return Object.fromEntries(
    memories.map((memory) => [
      memory.memory.name,
      {
        content: memory.memory.contentHash,
        description: contentHashOf(memory.memory.description),
      },
    ]),
  );
}

// The entry an applied revision leaves: the intent with the renames upstream has outgrown pruned,
// fresh fetch facts, and no `pending`, since whatever was held is either this revision or
// superseded by it. The sha a resolver reports is parsed into the variant's own type here, once:
// a remote names a commit, a copied directory the hash of its tree. A remote whose id does not
// parse (a sha256 repository, a proxy answering with something else) is a fetch that failed, not
// a crash.
export function fetchedFactsFor(
  entry: FetchedEntry,
  memories: readonly SourceMemory[],
  memoryPath: string,
  revision: { sha: string; at: string },
): FetchedEntry | null {
  const facts = { at: revision.at, memoryPath, memories: memoryFacts(memories), lastError: null };
  const names = memories.map((memory) => memory.memory.name);
  const renamed = withRename(entry, pruneRenames(entry.intent.rename, names));
  const { addedAt } = renamed;
  if (isRemoteEntry(renamed)) {
    const sha = parseGitSha(revision.sha);
    return sha === null ? null : { intent: renamed.intent, addedAt, fetched: { ...facts, sha } };
  }
  const sha = parseContentHash(revision.sha);
  return sha === null ? null : { intent: renamed.intent, addedAt, fetched: { ...facts, sha } };
}

// A hold keeps the last-good record, restarts the cooldown as a confirmed-unchanged remote does,
// and records the revision it did not apply; a second hold replaces the first, since the summary
// is always read against last-good.
function heldEntry(
  entry: FetchedEntry,
  sha: string,
  at: string,
  summary: string[],
): FetchedEntry | null {
  const current = touched(entry, at);
  if (isRemoteEntry(current)) {
    const parsed = parseGitSha(sha);
    return parsed === null ? null : { ...current, pending: { sha: parsed, at, summary } };
  }
  const parsed = parseContentHash(sha);
  return parsed === null ? null : { ...current, pending: { sha: parsed, at, summary } };
}

// The memories a revision adds (`+ name`), removes (`- name`) or changes (`~ name (old -> new)`)
// against a recorded fetch, in name order.
export function diffLines(before: Fetched["memories"], after: Fetched["memories"]): string[] {
  const old = new Map(Object.entries(before));
  const next = new Map(Object.entries(after));
  const lines: string[] = [];
  for (const name of [...new Set([...old.keys(), ...next.keys()])].sort()) {
    const was = old.get(name);
    const is = next.get(name);
    if (was === undefined && is !== undefined) lines.push(`+ ${name}`);
    else if (was !== undefined && is === undefined) lines.push(`- ${name}`);
    else if (was !== undefined && is !== undefined && was.content !== is.content) {
      lines.push(`~ ${name} (${shortHash(was.content)} -> ${shortHash(is.content)})`);
    }
  }
  return lines;
}

// A ladder failure carries its own class; a local directory that is gone reads as `missing`,
// the same permanent condition a deleted repository is. Anything else is a defect and propagates.
function classifyFetchError(error: unknown, at: string): LastError | null {
  if (error instanceof FetchFailure) {
    const retryAfter =
      error.retryAfterSeconds === undefined
        ? {}
        : { retryAfter: new Date(Date.parse(at) + error.retryAfterSeconds * 1000).toISOString() };
    return { kind: error.kind, message: error.message, at, ...retryAfter };
  }
  if (error instanceof MaximsError && error.code === ExitCode.SourceUnresolvable) {
    return { kind: "missing", message: error.message, at };
  }
  return null;
}

// The entry is replaced wholesale, laid out like the source (`relPath` from the source root), so
// `fetched.memoryPath` finds the files there and a memory deleted upstream leaves nothing behind.
// A file's path is asserted against the entry because `relPath` comes from the source tree.
export function swapStoreEntry(entry: RootedPath, files: TreeFile[]): Change[] {
  const changes: Change[] = [
    { kind: "delete", path: entry },
    { kind: "mkdir", path: entry },
  ];
  for (const file of files) {
    changes.push({
      kind: "write",
      path: assertInsideRoot(entry, join(entry, ...file.relPath.split("/"))),
      content: file.text,
    });
  }
  return changes;
}
