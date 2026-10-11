// Where a source's bodies and its `-o` rule file land: the bodies directories its harnesses read
// at project scope, and the `-o` folder's layout. `planInstall`, `retainedNames` and the rule-file
// render resolve paths through it.

import { join, resolve } from "node:path";
import type { SourceSlug } from "../harnesses/contract.ts";
import type { MemoryName } from "../memory/contract.ts";
import type { SourceEntry } from "../state/schema.ts";
import { realpathOfExistingPrefix } from "../util/fs.ts";
import { agentsAllowed, type EngineContext, harnessContext } from "./context.ts";
import { destinationUnresolvable } from "./fs-probe.ts";
import type { SourceWork } from "./sync-trees.ts";
import type { EngineIo, HarnessFilter } from "./types.ts";

// A harness reads a rule line's detail path relative to the rule file, so the bodies folder sits
// beside the rule file at the `-o` root.
const OUT_BODIES_DIR = "memories";

export function outRuleFile(root: string, slug: SourceSlug): string {
  return join(root, `maxims-${slug}.md`);
}

function outBodiesDir(root: string): string {
  return join(root, OUT_BODIES_DIR);
}

export function outDetailPath(local: MemoryName): string {
  return `${OUT_BODIES_DIR}/${local}.md`;
}

// `id` is the directory's real path, the identity two spellings of one folder share.
type BodiesDir = { id: string; dir: string; root: string };

// Every distinct memory directory the source's harnesses read at this scope; the user scope
// links nothing (rule lines point into the store) and `-o` gets its own bodies folder.
export function bodiesDirsFor(
  work: Pick<SourceWork, "intent">,
  ctx: EngineContext,
  io: EngineIo,
  agents: HarnessFilter | undefined,
): BodiesDir[] {
  const { intent } = work;
  if (intent.destination.scope === "out") {
    const root = intent.destination.path;
    return [bodiesDir(outBodiesDir(root), root)];
  }
  if (intent.destination.scope === "global" || ctx.projectRoot === null) return [];
  const projectRoot = ctx.projectRoot;
  const harnessCtx = { ...harnessContext(ctx), projectRoot };
  const dirs = new Map<string, BodiesDir>();
  for (const id of intent.harnesses) {
    if (!agentsAllowed(agents, id)) continue;
    const def = io.harnesses.find((candidate) => candidate.id === id);
    const dir = def?.bodiesDir("project", harnessCtx);
    if (dir === undefined || dir === null) continue;
    const entry = bodiesDir(resolve(dir), projectRoot);
    dirs.set(entry.id, entry);
  }
  return [...dirs.values()];
}

// Every bodies directory this run can reach, whatever `-a` limited it to, so a source that left
// intent is swept even when no surviving source shares the directory. Nothing here writes to
// these, so one that cannot be looked at (a link that loops, a folder without search permission)
// is warned about and left out; a source's own directory refuses the run in `bodiesDirsFor`.
export function allBodiesDirs(
  ctx: EngineContext,
  io: EngineIo,
  removed: readonly SourceEntry[],
  warn: (line: string) => void,
): BodiesDir[] {
  const dirs = new Map<string, BodiesDir>();
  // One look per spelled directory, so two harnesses naming the same folder warn once; a later
  // entry for the same folder still supplies the root (a removed `-o` folder that is also a
  // project's bodies directory is swept inside its own root).
  const looked = new Map<string, string | null>();
  const idOf = (dir: string): string | null => {
    const known = looked.get(dir);
    if (known !== undefined) return known;
    let id: string | null = null;
    try {
      id = realpathOfExistingPrefix(dir);
    } catch (error) {
      if (!destinationUnresolvable(error)) throw error;
      warn(error instanceof Error ? error.message : String(error));
    }
    looked.set(dir, id);
    return id;
  };
  const sweepable = (dir: string, root: string): void => {
    const id = idOf(dir);
    if (id !== null) dirs.set(id, { id, dir, root });
  };
  if (ctx.projectRoot !== null) {
    const projectRoot = ctx.projectRoot;
    const harnessCtx = { ...harnessContext(ctx), projectRoot };
    for (const def of io.harnesses) {
      const dir = def.bodiesDir("project", harnessCtx);
      if (dir === null) continue;
      sweepable(resolve(dir), projectRoot);
    }
  }
  for (const entry of removed) {
    if (entry.intent.destination.scope !== "out") continue;
    const root = entry.intent.destination.path;
    sweepable(outBodiesDir(root), root);
  }
  return [...dirs.values()];
}

function bodiesDir(dir: string, root: string): BodiesDir {
  return { id: realpathOfExistingPrefix(dir), dir, root };
}
