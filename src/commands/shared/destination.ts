import { existsSync, realpathSync, statSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { type HarnessId, isBuiltInHarnessId } from "../../contracts/harness-id.ts";
import {
  type HarnessDefinition,
  type Scope,
  scopeRoot,
  type Target,
} from "../../harnesses/contract.ts";
import { configDirExists } from "../../harnesses/detect.ts";
import { rulesDirPath } from "../../harnesses/strategies/rules-dir.ts";
import { sharedBlockPath } from "../../harnesses/strategies/shared-block.ts";
import type { SourceIntent } from "../../state/schema.ts";
import { ExitCode, MaximsError } from "../../util/exit-codes.ts";
import type { RootedPath } from "../../util/fs.ts";
import type { HarnessFilter } from "../types.ts";
import { agentsAllowed, type EngineContext, harnessContext } from "./context.ts";

export type HarnessTarget = {
  def: HarnessDefinition;
  scope: Scope;
  target: Target;
  path: RootedPath;
  // The real path of the target file (or of its nearest existing ancestor plus the rest), so two
  // definitions whose targets are one file through a symlink share one block.
  realKey: string;
};

// `unreachable` means the harness has no usable home at this scope (its config folder is absent
// or is a file): nothing of it, hook included, is touched there.
export type SkippedHarness = {
  id: HarnessId;
  reason: string;
  kind: "no-definition" | "no-target" | "unreachable";
};

export type TargetResolution = {
  targets: HarnessTarget[];
  skipped: SkippedHarness[];
};

// `agents` are the harnesses this run writes; `explicit` the ones the user named with `-a`, which
// a run may widen `agents` beyond (a refreshed source is written for every harness that reads it).
export type TargetRequest = {
  intent: Pick<SourceIntent, "harnesses">;
  scope: Scope;
  sourceSlug: string;
  ctx: EngineContext;
  harnesses: readonly HarnessDefinition[];
  agents: HarnessFilter | undefined;
  explicit: readonly HarnessId[];
};

// Where one source's rule lines go at one scope: one target per harness the intent names, minus
// the ones this run cannot or should not write. A harness the user named with `-a` is written or
// the run fails; one the intent merely lists is skipped with a reason when its project config
// root is absent, so a project install never plants a `.claude/` in a repo that has none.
export function resolveTargets(request: TargetRequest): TargetResolution {
  const { ctx, scope } = request;
  const harnessCtx = harnessContext(ctx);
  const targets: HarnessTarget[] = [];
  const skipped: SkippedHarness[] = [];
  for (const id of request.intent.harnesses) {
    if (!agentsAllowed(request.agents, id)) continue;
    const explicit = request.explicit.includes(id);
    const def = request.harnesses.find((candidate) => candidate.id === id);
    if (def === undefined) {
      skipped.push({ id, reason: noDefinitionReason(id), kind: "no-definition" });
      continue;
    }
    const target = def.targets[scope];
    if (target === null) {
      skipped.push({ id, reason: `no ${scope} target`, kind: "no-target" });
      continue;
    }
    const root = scopeRoot(def, scope, harnessCtx);
    const conflict = destinationConflict(def, target, root, scope);
    if (conflict !== null) {
      if (explicit) throw new MaximsError(ExitCode.DestinationWriteFailed, conflict);
      skipped.push({ id, reason: conflict, kind: "unreachable" });
      continue;
    }
    const path =
      target.kind === "rules-dir"
        ? rulesDirPath({ def, target, scope, ctx: harnessCtx, sourceSlug: request.sourceSlug })
        : sharedBlockPath({ def, target, scope, ctx: harnessCtx });
    targets.push({ def, scope, target, path, realKey: realKeyOf(path) });
  }
  return { targets, skipped };
}

// A built-in id always has a definition, so a missing one names a harness the user declared in
// `harnesses.json` and has since taken out of the file; intent keeps the id until the user drops
// it, and every sync says so.
export function noDefinitionReason(id: HarnessId): string {
  return isBuiltInHarnessId(id)
    ? "no definition in this build"
    : "not defined in harnesses.json; run maxims unlink <source> -a <id> to drop it";
}

// A rules directory lives inside the harness's own config folder (`.claude`, `.github`,
// `.clinerules`); a project that has none of it is not using that harness here. A regular file
// at the folder's path (the single-file `.clinerules` of older Cline) is a conflict, never a
// directory to create over it.
function destinationConflict(
  def: HarnessDefinition,
  target: Target,
  root: string,
  scope: Scope,
): string | null {
  if (target.kind !== "rules-dir") return null;
  const [configFolder] = target.dir.split(/[\\/]/);
  if (configFolder === undefined || configFolder === "") return null;
  const folder = join(root, configFolder);
  if (configDirExists(folder)) return null;
  if (statSync(folder, { throwIfNoEntry: false }) === undefined) {
    return scope === "project" ? `${def.displayName}: ${folder} does not exist` : null;
  }
  return `${def.displayName}: ${folder} is a file, not the directory ${target.dir} needs`;
}

// The identity a rule FILE is grouped and swept under: its parent resolved, its own name kept,
// because the final entry is what a write replaces (a leaf that is a symlink becomes the real
// file), while two spellings of the directory above it are one place.
export function realKeyOf(path: string): string {
  return join(realDirOf(dirname(path)), basename(path));
}

// The identity of a DIRECTORY: fully resolved, so a folder reached through a symlink and the
// folder itself are one place to sweep and to protect.
export function realDirOf(dir: string): string {
  let prefix = dir;
  const tail: string[] = [];
  for (;;) {
    if (existsSync(prefix)) {
      try {
        return join(realpathSync(prefix), ...tail.reverse());
      } catch {
        return dir;
      }
    }
    const parent = dirname(prefix);
    if (parent === prefix) return dir;
    tail.push(basename(prefix));
    prefix = parent;
  }
}
