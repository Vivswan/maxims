import { isDeepStrictEqual } from "node:util";
import type {
  HarnessContext,
  HarnessDefinition,
  HarnessId,
  Scope,
} from "../../harnesses/contract.ts";
import { type HookPlan, planHookWrite } from "../../harnesses/hook-writer.ts";
import type { Change } from "../../util/change.ts";
import { ExitCode, MaximsError } from "../../util/exit-codes.ts";
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
  agents: HarnessId[] | undefined;
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
      if (hook.notice !== undefined) notices.push(hook.notice);
      (wants.hook ? changes : removals).push(...hook.changes);
      (wants.rules ? changes : removals).push(...config);
    }
  }
  return { changes, removals, notices, failures };
}
