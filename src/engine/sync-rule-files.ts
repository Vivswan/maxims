// The rule-file render of a sync: the files sources share, their readers, each file's plan, and
// the budget retry's choice of block to hold. `planInstall` assembles the files and renders them
// through it.

import { join, relative, sep } from "node:path";
import type { Scope, SourceSlug } from "../harnesses/contract.ts";
import { BudgetExceeded } from "../harnesses/strategies/rules-dir.ts";
import type { MemoryName } from "../memory/contract.ts";
import { MarkerRefused } from "../rulefile/block.ts";
import { compareInstalled } from "../rulefile/dedupe.ts";
import type { SourceEntry, State } from "../state/schema.ts";
import type { Change } from "../util/change.ts";
import { assertInsideRoot, isSymlink, realKeyOf } from "../util/fs.ts";
import { agentsAllowed, type EngineContext, harnessContext } from "./context.ts";
import { type HarnessTarget, resolveTargets } from "./destination.ts";
import { destinationUnresolvable } from "./fs-probe.ts";
import type { SourceMemory } from "./memories.ts";
import {
  type BlockRequest,
  claimedByMaxims,
  LinkedAtRuleFile,
  ownedWhole,
  ownershipOf,
  planRuleFile,
  type RuleFile,
  RuleFileHeld,
  type RuleFilePlan,
  regularFileText,
} from "./rules.ts";
import { sourceSlug } from "./slug.ts";
import { outRuleFile } from "./sync-dirs.ts";
import { INSTALLED_FIRST } from "./sync-retained.ts";
import type { SourceWork } from "./sync-trees.ts";
import type { EngineIo, HarnessFilter } from "./types.ts";

export function harnessFile(
  files: Map<string, RuleFile>,
  group: HarnessTarget[],
  first: HarnessTarget,
  slug: SourceSlug,
  key: string,
): Extract<RuleFile, { kind: "harness" }> {
  const existing = files.get(first.realKey);
  if (existing?.kind === "out" && ownershipOf(first.target) === "shared") {
    throw new LinkedAtRuleFile([key], first.path, existing.path);
  }
  const file: Extract<RuleFile, { kind: "harness" }> =
    existing?.kind === "harness"
      ? existing
      : {
          kind: "harness",
          owned: ownershipOf(first.target),
          path: first.path,
          sourceSlug: slug,
          targets: [],
          aliases: [],
          blocks: [],
        };
  addReaders(file, group, key);
  return file;
}

// Sources sharing one file each bring their own readers; the file carries the union, so its
// rendering and its byte budget answer to every harness a source brings to it, not the first
// source's. A reader that would hold the file the other way (a shared file linked at a rule file
// maxims owns whole) never joins: the link is refused by name, since the file cannot be both.
export function addReaders(
  file: Extract<RuleFile, { kind: "harness" }>,
  group: HarnessTarget[],
  key: string,
): void {
  for (const target of group) {
    if (ownershipOf(target.target) !== file.owned) {
      const [link, ruleFile] =
        file.owned === "shared" ? [file.path, target.path] : [target.path, file.path];
      throw new LinkedAtRuleFile([key], link, ruleFile);
    }
    const seen = file.targets.some(
      (known) => known.def.id === target.def.id && known.scope === target.scope,
    );
    if (!seen) file.targets.push(target);
  }
}

export function fileIdentity(file: RuleFile): string {
  return file.kind === "harness" ? (file.targets[0]?.realKey ?? file.path) : realKeyOf(file.path);
}

// The block whose source was installed last, so the sources that were there first keep loading.
export function newestBlock(
  blocks: readonly BlockRequest[],
  sources: State["sources"],
): BlockRequest | undefined {
  const installed = blocks.map((block) => ({
    block,
    key: block.key,
    addedAt: sources[block.key]?.addedAt ?? INSTALLED_FIRST,
  }));
  return installed.sort(compareInstalled).at(-1)?.block;
}

type RenderedFiles =
  | { ok: true; plans: RuleFilePlan[]; held: RuleFileHeld[] }
  | { ok: false; file: RuleFile; error: BudgetExceeded };

export async function renderFiles(
  files: Map<string, RuleFile>,
  keepAt: ReadonlyMap<string, ReadonlySet<string>>,
): Promise<RenderedFiles> {
  const plans: RuleFilePlan[] = [];
  const held: RuleFileHeld[] = [];
  for (const file of files.values()) {
    try {
      const keep = keepAt.get(fileIdentity(file)) ?? new Set<string>();
      plans.push(await planRuleFile(file, { keep }));
    } catch (error) {
      if (error instanceof RuleFileHeld) {
        held.push(error);
        continue;
      }
      if (!(error instanceof BudgetExceeded)) throw error;
      return { ok: false, file, error };
    }
  }
  return { ok: true, plans, held };
}

// Taken only when the file carries maxims markers: the name is derived, and a user's own file at it
// stays theirs. A file this run plans (an `-o` folder that is also a harness's rules directory) is
// the current destination's and is kept. A file behind a marker the grammar refuses is held where
// it is.
export function removedOutRuleFiles(
  removed: readonly SourceEntry[],
  planned: ReadonlySet<string>,
  hold: (held: RuleFileHeld) => void,
): Change[] {
  const changes: Change[] = [];
  for (const entry of removed) {
    if (entry.intent.destination.scope !== "out") continue;
    const root = entry.intent.destination.path;
    const path = outRuleFile(root, sourceSlug(entry.intent.from));
    if (planned.has(realKeyOf(path))) continue;
    const text = regularFileText(path);
    if (text === null) continue;
    try {
      if (!claimedByMaxims(text)) continue;
    } catch (error) {
      if (!(error instanceof MarkerRefused)) throw error;
      hold(new RuleFileHeld(path, error));
      continue;
    }
    changes.push({ kind: "delete", path: assertInsideRoot(root, path) });
  }
  return changes;
}

// The detail path a rule line carries: absolute into the store at user scope, project-relative
// into the bodies directory at project scope so the committed file is machine-independent.
export function detailPathFor(
  work: SourceWork,
  group: HarnessTarget[],
  ctx: EngineContext,
): (memory: SourceMemory, local: MemoryName) => string {
  if (work.scopeKind !== "project" || ctx.projectRoot === null) {
    return (memory) => join(work.storeEntry, ...memory.relPath.split("/"));
  }
  const projectRoot = ctx.projectRoot;
  const harnessCtx = { ...harnessContext(ctx), projectRoot };
  const bodiesDir =
    group
      .map((target) => target.def.bodiesDir("project", harnessCtx))
      .find((dir) => dir !== null) ?? join(projectRoot, ".agents", "memories");
  return (_memory, local) =>
    relative(projectRoot, join(bodiesDir, `${local}.md`))
      .split(sep)
      .join("/");
}

export function supportsPathScoping(target: HarnessTarget): boolean {
  if (target.target.kind !== "rules-dir") return false;
  return target.target.frontmatter !== undefined || target.def.scopeFrontmatter !== undefined;
}

// Shared files this run planned no block for may still hold blocks of sources that left intent;
// they are visited so the orphan strip reaches them.
export function addSharedFilesWithOrphans(
  files: Map<string, RuleFile>,
  scopes: Scope[],
  ctx: EngineContext,
  io: EngineIo,
  agents: HarnessFilter | undefined,
): void {
  for (const def of io.harnesses) {
    const allowed = agentsAllowed(agents, def.id);
    for (const scope of scopes) {
      const target = def.targets[scope];
      if (target === null || target.kind !== "shared-block") continue;
      // A harness `-a` leaves out is not planned, but a link it reads a visited file by is the
      // user's, and the file must not be deleted under it. It is resolved for that alone, so a
      // destination it cannot resolve (its config folder linked out of the root) costs this run
      // nothing; a harness this run writes fails on the same, as it would for a source.
      let only: HarnessTarget | undefined;
      try {
        [only] = resolveTargets({
          intent: { harnesses: [def.id] },
          scope,
          sourceSlug: null,
          ctx,
          harnesses: io.harnesses,
          agents: undefined,
          explicit: [],
        }).targets;
      } catch (error) {
        if (allowed || !destinationUnresolvable(error)) throw error;
        continue;
      }
      if (only === undefined) continue;
      const visited = files.get(only.realKey);
      if (visited !== undefined) {
        // A file maxims owns whole is refused under this link as under a link a source brings:
        // retiring the file would delete it and leave the link dangling. An orphan reader brings
        // no block, so there is no budget to judge it by.
        if (isSymlink(only.path)) {
          if (ownedWhole(visited)) throw new LinkedAtRuleFile([], only.path, visited.path);
          if (visited.kind === "harness" && !visited.aliases.includes(only.path)) {
            visited.aliases.push(only.path);
          }
        }
        continue;
      }
      if (!allowed || regularFileText(only.path) === null) continue;
      files.set(only.realKey, {
        kind: "harness",
        owned: "shared",
        path: only.path,
        sourceSlug: null,
        targets: [only],
        aliases: [],
        blocks: [],
      });
    }
  }
}
