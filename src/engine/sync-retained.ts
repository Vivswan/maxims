// What a source holds installed right now, read from what the last run left behind: the names its
// store copy, its blocks and its bodies directories carry, which enter the name index ahead of
// every source. `planInstall` reads it per source; `remove` and `list` read it too.

import { lstatSync, readdirSync, readFileSync, readlinkSync } from "node:fs";
import { join, resolve } from "node:path";
import { isLiveLocal } from "../contracts/source.ts";
import {
  type ContentHash,
  contentHashOf,
  type MemoryName,
  memoryStem,
  parseMemoryName,
  renamed,
} from "../memory/contract.ts";
import { MarkerRefused } from "../rulefile/block.ts";
import { heldRuleBlocks, parseRuleBlocks, type RuleBlock } from "../rulefile/blocks.ts";
import type { SourceEntry } from "../state/schema.ts";
import { ExitCode, MaximsError } from "../util/exit-codes.ts";
import { isAbsent, isInside, realpathOfExistingPrefix } from "../util/fs.ts";
import { storePathFor } from "../util/home.ts";
import { inStore } from "./bodies.ts";
import { actsHere, type EngineContext } from "./context.ts";
import { resolveTargets } from "./destination.ts";
import type { SourceTree } from "./memories.ts";
import { RuleFileHeld, regularFileText } from "./rules.ts";
import { inSelect, selectMemories } from "./select.ts";
import { sourceSlug } from "./slug.ts";
import { bodiesDirsFor, outRuleFile } from "./sync-dirs.ts";
import { isFetchedEntry } from "./sync-refresh.ts";
import { installedRoot, installedTree } from "./sync-trees.ts";
import type { EngineIo } from "./types.ts";

// Earlier than any source's `addedAt`: the name index places what is installed first.
export const INSTALLED_FIRST = "1970-01-01T00:00:00.000Z";

// The local names a source holds installed right now, read from what the last run left behind. A
// copy carries no owner of its own: one whose bytes match no current memory, because the memory
// has since changed, names no owner either, and the dedupe rule decides the name.
//   store copy read through the selection       so a hidden internal memory is left out
//   user-scope detail paths through the renames  they name the store file under the upstream name
//   its blocks' names                            `retainedBlockNames`
//   copies judged by `own` minus `ambiguous`     a hash several sources ship names nobody
export async function retainedNames(
  key: string,
  entry: SourceEntry,
  ctx: EngineContext,
  io: EngineIo,
  hold: (held: RuleFileHeld, owned: boolean) => void,
  ambiguous: ReadonlySet<ContentHash> = new Set(),
  installedSnapshot?: SourceTree | null,
): Promise<MemoryName[]> {
  const names = new Set<MemoryName>();
  const { intent } = entry;
  const storeEntry = storePathFor(ctx.home, intent.from);
  const live = isLiveLocal(intent.from);
  const installed =
    installedSnapshot === undefined
      ? await installedTree(installedRoot(entry, ctx), intent)
      : installedSnapshot;
  if (installed !== null && !live) {
    for (const selected of selectMemories({
      memories: installed.memories,
      intent,
      installInternal: ctx.installInternal,
      disabled: new Set(),
      detailPath: () => "",
    }).selected) {
      names.add(selected.localName);
    }
  } else {
    const fetched = isFetchedEntry(entry) ? entry.fetched : undefined;
    for (const upstream of Object.keys(fetched?.memories ?? {})) {
      const parsed = parseMemoryName(upstream);
      if (parsed !== null && inSelect(intent.select, parsed)) {
        names.add(renamed(intent.rename, parsed));
      }
    }
  }
  for (const name of retainedBlockNames(key, entry, ctx, io, hold)) names.add(name);
  // A source installed for another project has no body in this one; `readTrees` skips it before
  // sync reads anything, and `list` reads every entry.
  if (!actsHere(entry, ctx)) return [...names];
  const entryReal = inStore(ctx.paths.store, storeEntry);
  const own = new Set(
    (installed?.memories ?? [])
      .map((memory) => memory.memory.contentHash)
      .filter((hash) => !ambiguous.has(hash)),
  );
  for (const dir of bodiesDirsFor(entry, ctx, io, undefined)) {
    for (const name of installedBodies(dir.dir, entryReal, own)) names.add(name);
  }
  return [...names];
}

// The one read that raises a hold for a refused marker, on every verb. The source owns the hold
// only with a block of its own in the file, since the hold freezes its owner. The held block keeps
// its names (`heldRuleBlocks`): a rival shipping one collides instead of writing its body under
// the kept line.
export function retainedBlockNames(
  key: string,
  entry: SourceEntry,
  ctx: EngineContext,
  io: EngineIo,
  hold: (held: RuleFileHeld, owned: boolean) => void,
): MemoryName[] {
  // The files resolve against the project the run is in, not the entry's own: an entry installed
  // for another project would read this project's shared file, or refuse outside any project.
  if (!actsHere(entry, ctx)) return [];
  const { intent } = entry;
  const names = new Set<MemoryName>();
  const upstreamPaths = intent.destination.scope === "global";
  for (const path of retainedRuleFiles(entry, ctx, io)) {
    const text = regularFileText(path);
    if (text === null) continue;
    let blocks: RuleBlock[];
    let refused: MarkerRefused | null = null;
    try {
      blocks = parseRuleBlocks(text);
    } catch (error) {
      if (!(error instanceof MarkerRefused)) throw error;
      refused = error;
      blocks = heldRuleBlocks(text);
    }
    const block = blocks.find((candidate) => candidate.source === key);
    if (refused !== null) hold(new RuleFileHeld(path, refused), block !== undefined);
    for (const name of block?.names ?? []) {
      names.add(upstreamPaths ? renamed(intent.rename, name) : name);
    }
  }
  return [...names];
}

// A directory that exists but cannot be listed stops the run: read as empty, it would hand every
// installed name to whichever source is older and let a write repoint another source's body.
function installedBodies(
  dir: string,
  entryReal: string,
  own: ReadonlySet<ContentHash>,
): MemoryName[] {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch (error) {
    if (isAbsent(error)) return [];
    const reason = error instanceof Error ? error.message : String(error);
    throw new MaximsError(ExitCode.DestinationWriteFailed, `cannot list ${dir}: ${reason}`, {
      hint: "fix the directory's permissions and run maxims sync again",
    });
  }
  const names: MemoryName[] = [];
  for (const name of entries) {
    const stem = memoryStem(name);
    if (stem === null) continue;
    const path = join(dir, name);
    const stat = lstatSync(path, { throwIfNoEntry: false });
    if (stat === undefined) continue;
    const parsed = parseMemoryName(stem);
    if (parsed === null) continue;
    if (stat.isSymbolicLink()) {
      const target = resolve(realpathOfExistingPrefix(dir), readlinkSync(path));
      if (isInside(entryReal, target)) names.push(parsed);
    } else if (stat.isFile() && own.has(contentHashOf(readFileSync(path, "utf8")))) {
      names.push(parsed);
    }
  }
  return names;
}

function retainedRuleFiles(entry: SourceEntry, ctx: EngineContext, io: EngineIo): string[] {
  const { intent } = entry;
  if (!intent.rule) return [];
  if (intent.destination.scope === "out") {
    return [outRuleFile(intent.destination.path, sourceSlug(intent.from))];
  }
  return resolveTargets({
    intent,
    scope: intent.destination.scope,
    sourceSlug: sourceSlug(intent.from),
    ctx,
    harnesses: io.harnesses,
    agents: undefined,
    explicit: [],
  }).targets.map((target) => target.path);
}
