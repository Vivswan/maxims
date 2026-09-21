import { isDeepStrictEqual } from "node:util";
import {
  type HarnessContext,
  type HarnessDefinition,
  type HarnessId,
  type Scope,
  scopeRoot,
} from "../../harnesses/contract.ts";
import { type HookPlan, planHookWrite } from "../../harnesses/hook-writer.ts";
import type { State } from "../../state/schema.ts";
import { type ScopeAt, scopedAt, scopesOf, withScopedList } from "../../state/scoped.ts";
import type { Change } from "../../util/change.ts";
import { ExitCode, MaximsError } from "../../util/exit-codes.ts";
import { assertInsideRoot } from "../../util/fs.ts";
import type { HarnessFilter } from "../types.ts";
import { agentsAllowed, type EngineContext, harnessContext } from "./context.ts";
import { destinationUnresolvable, realpathOfExistingPrefix } from "./fs-probe.ts";

// The harnesses whose hook state wants at one scope; a project scope with no project root wants
// none.
export function hookedAt(
  state: Pick<State, "hooks">,
  scope: Scope,
  projectRoot: string | null,
): readonly HarnessId[] {
  if (scope === "global") return scopedAt(state.hooks, { scope });
  return projectRoot === null ? [] : scopedAt(state.hooks, { scope, root: projectRoot });
}

// `add --add-hook` at a scope: the ids join that scope's list and no other.
export function withHooks(state: State, at: ScopeAt, ids: readonly HarnessId[]): State {
  const hooks = withScopedList(state.hooks, at, [...scopedAt(state.hooks, at), ...ids]);
  const { hooks: _previous, ...rest } = state;
  return hooks === undefined ? rest : { ...rest, hooks };
}

// A hook is wanted at a scope only while some source there lists the harness. Every verb that
// edits the sources settles the lists here, so a scope whose last source for a harness left
// gives its hook up, and a later add there without `--add-hook` registers nothing.
export function prunedHooks(state: State): State {
  let hooks = state.hooks;
  for (const at of scopesOf(hooks)) {
    const listed = scopedAt(hooks, at).filter((id) =>
      Object.values(state.sources).some(
        (entry) => sameScope(entry.intent.destination, at) && entry.intent.harnesses.includes(id),
      ),
    );
    hooks = withScopedList(hooks, at, listed);
  }
  const { hooks: _previous, ...rest } = state;
  return hooks === undefined ? rest : { ...rest, hooks };
}

function sameScope(destination: State["sources"][string]["intent"]["destination"], at: ScopeAt) {
  if (at.scope === "global") return destination.scope === "global";
  return destination.scope === "project" && destination.root === at.root;
}

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
// hook follows the scope's hook list and the sources the harness has there; the config edit a
// rules directory needs follows the rules alone, so a harness that lists rules without a hook
// keeps its config entry while its registry loses ours.
export async function planHooks(input: {
  ctx: EngineContext;
  harnesses: readonly HarnessDefinition[];
  agents: HarnessFilter | undefined;
  wants: (id: HarnessId, scope: Scope) => HarnessWants;
  // The roots of the other projects whose entries want the harness's hook.
  elsewhere: (id: HarnessId) => string[];
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
    // Every file this run's own scopes resolve to, a registry whose plan failed included: another
    // project's hook in such a file is this run's to plan, and the failure this run's to report.
    const reach = new Set<string>();
    for (const scope of scopes) {
      const wants = input.wants(def.id, scope);
      if (wants.unreachable) continue;
      let hook: HookPlan;
      let config: Change[];
      try {
        const declared = declaredHookFile(def, scope, harnessCtx);
        if (declared !== null) reach.add(fileId(declared));
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
      const claims = hookFiles(def, scope, harnessCtx, hook.changes);
      for (const claim of claims) reach.add(fileId(claim));
      answers.push({ artifact: hook.changes, claims, wanted: wants.hook, notice: hook.notice });
      answers.push({ artifact: config, claims: config.map((c) => c.path), wanted: wants.rules });
    }
    for (const root of input.elsewhere(def.id)) {
      try {
        const shared = await sharedHookOf(def, { ...harnessCtx, projectRoot: root }, reach);
        if (shared !== null) answers.push(shared);
      } catch (error) {
        if (!(error instanceof MaximsError) || error.code !== ExitCode.DestinationWriteFailed) {
          throw error;
        }
        // A file this run reaches and cannot edit is this run's failure, whoever wants it.
        if (!failures.some((failure) => failure.message === error.message)) {
          failures.push({ message: error.message, hint: error.hint });
        }
      }
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
  const declared = declaredHookFile(def, scope, ctx);
  if (declared !== null) files.push(declared);
  return files;
}

function declaredHookFile(
  def: HarnessDefinition,
  scope: Scope,
  ctx: HarnessContext,
): string | null {
  if (def.hook.kind !== "registry" && def.hook.kind !== "file") return null;
  return assertInsideRoot(scopeRoot(def, scope, ctx), def.hook.path(scope, ctx));
}

// One file under two spellings (a home reached through a symlink, a project root recorded by its
// real path) is one file to reconcile.
function fileId(path: string): string {
  return realpathOfExistingPrefix(path);
}

// Another project's entries want their hook at their own root. A plan of theirs that touches a
// file this run reaches too (dsh mounts one bridge under the global root whatever the scope; a
// project rooted at the home directory shares the global registry) is planned here as wanted, so a
// run with nothing of its own does not take another project's hook down. It is taken whole: dsh's
// hooks file loads only through its patch row. A plan touching nothing this run reaches is that
// project's, written by a sync run there; a registry known to lie there is not read, and one that
// project cannot resolve (its config folder a symlink out of the checkout, its root without search
// permission) is that project's failure.
async function sharedHookOf(
  def: HarnessDefinition,
  there: HarnessContext,
  reach: ReadonlySet<string>,
): Promise<ScopeAnswer | null> {
  try {
    const declared = declaredHookFile(def, "project", there);
    if (declared !== null && !reach.has(fileId(declared))) return null;
  } catch (error) {
    if (!destinationUnresolvable(error)) throw error;
    return null;
  }
  const hook = await planHookAlone(def, "project", there, true);
  const claims = hookFiles(def, "project", there, hook.changes);
  if (!claims.some((file) => reach.has(fileId(file)))) return null;
  return {
    artifact: hook.changes,
    claims,
    wanted: true,
    ...(hook.notice === undefined ? {} : { notice: hook.notice }),
  };
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
    answers.filter((answer) => answer.wanted).flatMap((answer) => answer.claims.map(fileId)),
  );
  for (const answer of answers) {
    if (answer.wanted) changes.push(...answer.artifact);
    else if (answer.artifact.some((change) => kept.has(fileId(change.path)))) continue;
    else removals.push(...answer.artifact);
    if (answer.notice !== undefined) notices.push(answer.notice);
  }
  return { changes, removals, notices };
}
