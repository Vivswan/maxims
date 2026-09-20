import { isDeepStrictEqual } from "node:util";
import {
  type HarnessContext,
  type HarnessDefinition,
  type HarnessId,
  type Scope,
  scopeRoot,
} from "../../harnesses/contract.ts";
import { type HookPlan, planHookWrite } from "../../harnesses/hook-writer.ts";
import type { Change } from "../../util/change.ts";
import { ExitCode, MaximsError } from "../../util/exit-codes.ts";
import { assertInsideRoot } from "../../util/fs.ts";
import type { HarnessFilter } from "../types.ts";
import { agentsAllowed, type EngineContext, harnessContext } from "./context.ts";

// `unreachable` says the harness has no home at this scope; nothing there is read or written.
export type HarnessWants = {
  hook: boolean;
  rules: boolean;
  unreachable: boolean;
};

// `removals` take our entry or artifact out of a registry the intent no longer wants it in; a
// hook run defers them like any other removal.
export type HooksPlan = {
  changes: Change[];
  removals: Change[];
  notices: string[];
  // Registries this run needed and could not read or edit (unparsable, or a file where a folder
  // should be); each is a write failure to report, never a reason to stop the other harnesses.
  failures: { message: string; hint: string | undefined }[];
};

// The hook writer plans a definition's config edit together with the hook, under the hook's
// `wanted`. Here the hook is planned alone: the bundled edit is taken back out, so the registry
// entry and the config entry each follow their own answer (the hook list, the rules).
export async function planHookAlone(
  def: HarnessDefinition,
  scope: Scope,
  ctx: HarnessContext,
  wanted: boolean,
): Promise<HookPlan> {
  const hook = await planHookWrite({ def, scope, ctx, wanted });
  if (def.configEdit === undefined) return hook;
  const bundled = await def.configEdit(scope, ctx, wanted);
  return {
    ...hook,
    changes: hook.changes.filter(
      (change) => !bundled.some((other) => isDeepStrictEqual(other, change)),
    ),
  };
}

// Reconciles every definition's hook and config edit at every scope this run can reach. The
// hook follows `state.hooks` and the scopes where the harness has sources; the config edit a
// rules directory needs follows the rules alone, so a harness that lists rules without a hook
// keeps its config entry while its registry loses ours.
export async function planHooks(input: {
  ctx: EngineContext;
  harnesses: readonly HarnessDefinition[];
  agents: HarnessFilter | undefined;
  wants: (id: HarnessId, scope: Scope) => HarnessWants;
}): Promise<HooksPlan> {
  const { ctx } = input;
  const harnessCtx = harnessContext(ctx);
  const scopes: Scope[] = ctx.projectRoot === null ? ["global"] : ["global", "project"];
  const changes: Change[] = [];
  const removals: Change[] = [];
  const notices: string[] = [];
  const failures: HooksPlan["failures"] = [];
  for (const def of input.harnesses) {
    if (!agentsAllowed(input.agents, def.id)) continue;
    const answers: ScopeAnswer[] = [];
    for (const scope of scopes) {
      const wants = input.wants(def.id, scope);
      if (wants.unreachable) continue;
      let hook: HookPlan;
      let config: Change[];
      try {
        hook = await planHookAlone(def, scope, harnessCtx, wants.hook);
        config = (await def.configEdit?.(scope, harnessCtx, wants.rules)) ?? [];
      } catch (error) {
        if (!(error instanceof MaximsError) || error.code !== ExitCode.DestinationWriteFailed) {
          throw error;
        }
        // A registry this run wants nothing from may be unreadable for reasons of its own; one it
        // must edit is a failure of this run.
        if (wants.hook || wants.rules) failures.push({ message: error.message, hint: error.hint });
        continue;
      }
      answers.push({
        artifact: hook.changes,
        claims: hookFiles(def, scope, harnessCtx, hook.changes),
        wanted: wants.hook,
        notice: hook.notice,
      });
      answers.push({ artifact: config, claims: config.map((c) => c.path), wanted: wants.rules });
    }
    const reconciled = reconcileScopes(answers);
    changes.push(...reconciled.changes);
    removals.push(...reconciled.removals);
    notices.push(...reconciled.notices);
  }
  return { changes, removals, notices, failures };
}

// `claims` are the files the answer resolves to whether or not it changes them there; the notice
// describes the artifact and leaves with it.
type ScopeAnswer = { artifact: Change[]; claims: string[]; wanted: boolean; notice?: string };

// A registry or file hook knows its file before it is planned; a custom hook names its files only
// through the changes it returns (dsh's bridge emits its hooks-file write whenever it is wanted).
function hookFiles(
  def: HarnessDefinition,
  scope: Scope,
  ctx: HarnessContext,
  planned: Change[],
): string[] {
  const files: string[] = planned.map((change) => change.path);
  if (def.hook.kind === "registry" || def.hook.kind === "file") {
    files.push(assertInsideRoot(scopeRoot(def, scope, ctx), def.hook.path(scope, ctx)));
  }
  return files;
}

// One file can be reached from both scopes: dsh mounts its bridge under the global root whatever
// the install scope, and a home directory that is itself a repository makes the project and the
// global registry one file. A project-only install would then write the hook for the project scope
// and delete it again for the global scope, the deletion applied last. A removal touching any file
// a wanted answer claims is dropped whole, its companion edits (the patch row) included. The claim
// covers files the wanted answer leaves alone: on a settled registry the wanted scope has nothing
// to write while the unwanted scope still finds our entry to remove.
function reconcileScopes(
  answers: readonly ScopeAnswer[],
): Pick<HooksPlan, "changes" | "removals" | "notices"> {
  const changes: Change[] = [];
  const removals: Change[] = [];
  const notices: string[] = [];
  const kept = new Set(
    answers.filter((answer) => answer.wanted).flatMap((answer) => answer.claims),
  );
  for (const answer of answers) {
    if (answer.wanted) changes.push(...answer.artifact);
    else if (answer.artifact.some((change) => kept.has(change.path))) continue;
    else removals.push(...answer.artifact);
    if (answer.notice !== undefined) notices.push(answer.notice);
  }
  return { changes, removals, notices };
}
