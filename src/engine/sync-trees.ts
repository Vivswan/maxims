// The tree reads of a sync: each source's memories, from its fresh fetch, a dry run's preview
// overlay, or what is installed. `planInstall` works over the result; `remove`, `show` and `list`
// read installed trees through it.

import { lstatSync, readlinkSync } from "node:fs";
import { relative, resolve, sep } from "node:path";
import type { LastError } from "../contracts/last-error.ts";
import { isLiveLocal } from "../contracts/source.ts";
import type { MemoryName } from "../memory/contract.ts";
import type { Staleness } from "../rulefile/types.ts";
import { type LocalSourceFrom, materializeLocal } from "../sources/local.ts";
import { hashFiles, type TreeFile } from "../sources/tree.ts";
import type { SourceEntry, SourceIntent } from "../state/schema.ts";
import type { Change } from "../util/change.ts";
import { isInside, type RootedPath } from "../util/fs.ts";
import { storePathFor } from "../util/home.ts";
import { actsHere, type EngineContext } from "./context.ts";
import { storeEntryPresent } from "./fetch.ts";
import { readSourceMemories, type SourceTree, validateMemoryFiles } from "./memories.ts";
import type { Notices } from "./notices.ts";
import { selectMemories } from "./select.ts";
import { isFetchedEntry, type Refreshed, staleness } from "./sync-refresh.ts";
import type { SyncPreview, SyncReport } from "./types.ts";

export type ScopeKind = SourceIntent["destination"]["scope"];

// `storeChanges` are the store swap or link this source lands with, planned only once admission
// has passed.
export type SourceWork = {
  key: string;
  entry: SourceEntry;
  intent: SourceIntent;
  scopeKind: ScopeKind;
  storeEntry: RootedPath;
  tree: SourceTree;
  sha: string;
  stale: Staleness | undefined;
  ownedUpstreamNames: MemoryName[];
  storeChanges: Change[];
};

type ReadTrees = {
  works: SourceWork[];
  unreadable: { key: string; entry: SourceEntry }[];
  failed: SyncReport["failed"];
};

// A source with nothing readable keeps whatever blocks it has on disk; a live source's read is its
// refresh, so one that fails is reported like a failed fetch.
export async function readTrees(
  refreshed: Refreshed,
  held: ReadonlySet<string>,
  overlay: StoreOverlay,
  ctx: EngineContext,
  notices: Notices,
): Promise<ReadTrees> {
  const works: SourceWork[] = [];
  const unreadable: ReadTrees["unreadable"] = [];
  const failed: ReadTrees["failed"] = [];
  for (const key of Object.keys(refreshed.sources).sort()) {
    const entry = refreshed.sources[key];
    if (entry === undefined) continue;
    const { intent } = entry;
    const { from } = intent;
    const scopeKind = intent.destination.scope;
    if (!actsHere(entry, ctx)) {
      notices.trace(`${key}: installed for another project; skipped`);
      continue;
    }
    if (held.has(key)) {
      unreadable.push({ key, entry });
      continue;
    }
    const storeEntry = storePathFor(ctx.home, from);
    const live = isLiveLocal(from);
    const read = await treeFor(key, entry, storeEntry, refreshed.freshTrees, overlay, notices);
    if (read.kind === "unreadable") {
      notices.notice(`maxims: ${key}: ${read.reason}; kept whatever is installed`);
      if (live) failed.push({ key, message: read.reason, kind: read.cause });
      unreadable.push({ key, entry });
      continue;
    }
    const fetched = isFetchedEntry(entry) ? entry.fetched : undefined;
    works.push({
      key,
      entry,
      intent,
      scopeKind,
      storeEntry,
      tree: read.tree,
      sha: !live && fetched !== undefined ? fetched.sha : read.tree.sha,
      stale: staleness(fetched, ctx.now, ctx.cooldownDays),
      ownedUpstreamNames: selectMemories({
        memories: read.tree.memories,
        intent,
        installInternal: ctx.installInternal,
        disabled: new Set(),
        detailPath: () => "",
      }).ownedUpstreamNames,
      storeChanges: live
        ? liveStoreChanges(from, storeEntry, ctx.home)
        : (refreshed.storeChanges.get(key) ?? []),
    });
  }
  return { works, unreadable, failed };
}

function liveStoreChanges(from: LocalSourceFrom, storeEntry: string, home: string): Change[] {
  if (currentLinkTarget(storeEntry) === resolve(from.path)) return [];
  return materializeLocal(from, home, []);
}

// `cause` classifies an unreadable source the way a failed fetch is classified, so the report
// tells a directory that is gone from one that holds nothing valid to install.
export type TreeRead =
  | { kind: "tree"; tree: SourceTree }
  | { kind: "unreadable"; reason: string; cause: LastError["kind"] };

async function treeFor(
  key: string,
  entry: SourceEntry,
  storeEntry: RootedPath,
  freshTrees: Map<string, SourceTree>,
  overlay: StoreOverlay,
  notices: Notices,
): Promise<TreeRead> {
  const fresh = freshTrees.get(key) ?? overlay.get(storeEntry);
  if (fresh !== undefined) return { kind: "tree", tree: fresh };
  const warn = (line: string): void => notices.notice(`maxims: ${key}: ${line}`);
  return readInstalledTree(entry, storeEntry, warn);
}

export async function readInstalledTree(
  entry: SourceEntry,
  storeEntry: string,
  warn: (line: string) => void,
): Promise<TreeRead> {
  const { intent } = entry;
  const { from } = intent;
  const live = isLiveLocal(from);
  const root = live ? from.path : storeEntry;
  if (!live && !(await storeEntryPresent(storeEntry))) {
    const lastError = isFetchedEntry(entry) ? entry.fetched?.lastError : undefined;
    return {
      kind: "unreadable",
      reason: lastError?.message ?? "not fetched yet",
      cause: lastError?.kind ?? "missing",
    };
  }
  try {
    const tree = await readSourceMemories(root, intent, warn);
    // A tree holding no valid memory is a layout that changed or a folder emptied by hand, never
    // an empty source to install: what is installed stays until a valid memory is back. The
    // fetch path refuses the same tree before it reaches the store.
    if (tree.memories.length === 0) {
      const reasons = tree.invalid.map((file) => `${file.relPath}: ${file.reason}`).join("; ");
      const reason = tree.invalid.length === 0 ? "no memories" : `no valid memories (${reasons})`;
      return { kind: "unreadable", reason, cause: "invalid" };
    }
    return { kind: "tree", tree };
  } catch (cause) {
    return {
      kind: "unreadable",
      reason: cause instanceof Error ? cause.message : String(cause),
      cause: "missing",
    };
  }
}

// A store entry as a dry run's caller would have written it, keyed by the entry path and read in
// place of the copy that is not on disk. Only writes under the store count; a state, config or
// manifest write in the same preview says nothing about memories.
export type StoreOverlay = ReadonlyMap<string, SourceTree>;

export function previewStoreTrees(
  preview: SyncPreview | undefined,
  ctx: EngineContext,
): StoreOverlay {
  const overlay = new Map<string, SourceTree>();
  if (preview === undefined) return overlay;
  for (const entry of Object.values(preview.state.sources)) {
    const path = storePathFor(ctx.home, entry.intent.from);
    const files: TreeFile[] = [];
    for (const change of preview.changes) {
      if (change.kind !== "write" || !isInside(path, change.path)) continue;
      files.push({
        relPath: relative(path, change.path).split(sep).join("/"),
        text: change.content,
      });
    }
    if (files.length > 0)
      overlay.set(path, { sha: hashFiles(files), ...validateMemoryFiles(files) });
  }
  return overlay;
}

function currentLinkTarget(path: string): string | null {
  const entry = lstatSync(path, { throwIfNoEntry: false });
  if (entry === undefined || !entry.isSymbolicLink()) return null;
  return resolve(readlinkSync(path));
}

export function installedRoot(entry: SourceEntry, ctx: EngineContext): string {
  const { from } = entry.intent;
  return isLiveLocal(from) ? from.path : storePathFor(ctx.home, from);
}

export async function installedTree(
  root: string,
  intent: SourceIntent,
): Promise<SourceTree | null> {
  if (!(await storeEntryPresent(root))) return null;
  try {
    return await readSourceMemories(root, intent, () => undefined);
  } catch {
    return null;
  }
}
