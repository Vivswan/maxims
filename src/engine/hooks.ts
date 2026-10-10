import type { HarnessId } from "../contracts/harness-id.ts";
import {
  type HarnessContext,
  type HarnessDefinition,
  type Scope,
  scopeRoot,
} from "../harnesses/contract.ts";
import { planHookOnly } from "../harnesses/hook-writer.ts";
import {
  type McpRegistration,
  mcpRegistrationAt,
  planMcpOnly,
  planMcpRegistration,
} from "../harnesses/mcp-stub/register.ts";
import type { State } from "../state/schema.ts";
import { type ScopeAt, scopedAt, scopesOf, withScopedList } from "../state/scoped.ts";
import type { Change } from "../util/change.ts";
import { ExitCode, MaximsError } from "../util/exit-codes.ts";
import { assertInsideRoot, realpathOfExistingPrefix } from "../util/fs.ts";
import { agentsAllowed, type EngineContext, harnessContext } from "./context.ts";
import { destinationConflict, realKeyOf } from "./destination.ts";
import { destinationUnresolvable } from "./fs-probe.ts";
import type { HarnessFilter } from "./types.ts";

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

export type HookStatus = "current" | "missing" | "none" | "not-wanted";

// The one judgment `list` and `doctor` report a hook by. The hook alone is planned: a pending
// config edit beside it is not a missing hook. A harness with no usable home at this scope (its
// config folder absent, or a file) gets no hook from sync either, so none is wanted there.
// `plan` is the engine seam, so a verb outside the engine judges through it.
export async function hookStatus(
  def: HarnessDefinition,
  scope: Scope,
  state: Pick<State, "hooks">,
  projectRoot: string | null,
  ctx: HarnessContext,
  plan: typeof planHookOnly,
): Promise<HookStatus> {
  if (def.hook.kind === "none") return "none";
  if (!hookedAt(state, scope, projectRoot).includes(def.id)) return "not-wanted";
  const target = def.targets[scope];
  if (
    target !== null &&
    destinationConflict(def, target, scopeRoot(def, scope, ctx), scope) !== null
  ) {
    return "not-wanted";
  }
  const planned = await plan({ def, scope, ctx, wanted: true });
  return planned.changes.length === 0 ? "current" : "missing";
}

// The word beside a judged hook; a harness with none, or none wanted, gets no word.
export function hookStatusText(status: HookStatus): string | null {
  if (status === "current") return "hook current";
  if (status === "missing") return "hook missing";
  return null;
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

// Reconciles every definition's hook, MCP server entry and config edit at every scope this run can
// reach. The hook and the stub server entry follow the scope's hook list and the sources the
// harness has there; the config edit a rules directory needs follows the rules alone. Each is its
// own artifact: one that cannot be planned is reported and leaves the others standing.
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
  // A registry this run wants nothing from may be unreadable for reasons of its own; one it must
  // edit is a failure of this run, reported once however many artifacts share the file.
  const attempt = async <T>(mustEdit: boolean, plan: () => Promise<T>): Promise<T | null> => {
    try {
      return await plan();
    } catch (error) {
      if (!(error instanceof MaximsError) || error.code !== ExitCode.DestinationWriteFailed) {
        throw error;
      }
      if (mustEdit && !failures.some((failure) => failure.message === error.message)) {
        failures.push({ message: error.message, hint: error.hint });
      }
      return null;
    }
  };
  for (const def of input.harnesses) {
    if (!agentsAllowed(input.agents, def.id)) continue;
    const answers: ScopeAnswer[] = [];
    // Every file this run's own scopes resolve to, a registry whose plan failed included: another
    // project's hook in such a file is this run's to plan, and the failure this run's to report.
    const reach = new Set<string>();
    for (const scope of scopes) {
      const wants = input.wants(def.id, scope);
      if (wants.unreachable) continue;
      const hook = await attempt(wants.hook, () =>
        hookAnswer(def, scope, harnessCtx, wants.hook, reach),
      );
      const mcp = await attempt(wants.hook, async () => {
        const registration = mcpRegistrationAt(def, scope, harnessCtx);
        if (registration === null) return null;
        reach.add(fileId(registration.path));
        return mcpAnswer(registration, wants.hook, hook);
      });
      const config = await attempt(wants.rules, async () => {
        const edits = (await def.configEdit?.(scope, harnessCtx, wants.rules)) ?? [];
        return {
          artifact: edits,
          claims: edits.map((c) => c.path),
          wanted: wants.rules,
          notices: [],
        };
      });
      for (const answer of [hook, mcp, config]) if (answer !== null) answers.push(answer);
    }
    // Another project's artifact in a file this run reaches too (dsh mounts one bridge under the
    // global root whatever the scope; a project rooted at the home directory shares the global
    // registry) is planned here as wanted, so a run with nothing of its own does not take it down.
    for (const root of input.elsewhere(def.id)) {
      const there = { ...harnessCtx, projectRoot: root, cwd: root };
      const hook = await attempt(true, async () => {
        const declared = resolvedThere(() => declaredHookFile(def, "project", there));
        if (declared === undefined) return null;
        if (declared !== null && !reach.has(fileId(declared))) return null;
        return hookAnswer(def, "project", there, true, null);
      });
      const mcp = await attempt(true, async () => {
        const registration = resolvedThere(() => mcpRegistrationAt(def, "project", there));
        if (registration === undefined || registration === null) return null;
        if (!reach.has(fileId(registration.path))) return null;
        return mcpAnswer(registration, true, hook);
      });
      for (const answer of [hook, mcp]) {
        if (answer?.claims.some((file) => reach.has(fileId(file)))) {
          answers.push(answer);
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

// `claims` are the files the answer resolves to whether or not it changes them there; the notices
// describe the artifact and are accepted or dropped with it.
type ScopeAnswer = { artifact: Change[]; claims: string[]; wanted: boolean; notices: string[] };

// `undefined` when another project cannot resolve a file of its own (its config folder a symlink
// out of the checkout, its root without search permission): that project's failure, not this run's.
function resolvedThere<T>(resolve: () => T): T | undefined {
  try {
    return resolve();
  } catch (error) {
    if (!destinationUnresolvable(error)) throw error;
    return undefined;
  }
}

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

// `reach` collects the files this run's own scopes resolve to; another project's answer adds none.
async function hookAnswer(
  def: HarnessDefinition,
  scope: Scope,
  ctx: HarnessContext,
  wanted: boolean,
  reach: Set<string> | null,
): Promise<ScopeAnswer> {
  const declared = declaredHookFile(def, scope, ctx);
  if (declared !== null) reach?.add(fileId(declared));
  const plan = await planHookOnly({ def, scope, ctx, wanted });
  const claims = hookFiles(def, scope, ctx, plan.changes);
  for (const claim of claims) reach?.add(fileId(claim));
  return { artifact: plan.changes, claims, wanted, notices: noticesOf(plan.notice) };
}

// The stub server entry. A user-defined harness may keep its hooks and its servers in one file:
// the entry is then planned over the hook's planned text and rides in the hook's write, notice
// included. The names are matched by `realKeyOf`: a servers path through a directory link is the
// hook's registry, while a leaf that is a link is replaced by the write and stays its own file.
async function mcpAnswer(
  registration: McpRegistration,
  wanted: boolean,
  hook: ScopeAnswer | null,
): Promise<ScopeAnswer> {
  const file = realKeyOf(registration.path);
  const shared =
    hook?.artifact.findIndex(
      (change) => change.kind === "write" && realKeyOf(change.path) === file,
    ) ?? -1;
  const current = hook?.artifact[shared];
  if (hook === null || current?.kind !== "write") {
    const plan = await planMcpOnly(registration, wanted);
    return {
      artifact: plan.changes,
      claims: [registration.path],
      wanted,
      notices: noticesOf(plan.notice),
    };
  }
  const plan = planMcpRegistration({ registration, wanted, currentText: current.content });
  const [write] = plan.changes;
  if (write?.kind === "write") {
    hook.artifact[shared] = { ...current, content: write.content };
    hook.notices.push(...noticesOf(plan.notice));
  }
  return { artifact: [], claims: [registration.path], wanted, notices: [] };
}

function noticesOf(notice: string | undefined): string[] {
  return notice === undefined ? [] : [notice];
}

// One file under two spellings (a home reached through a symlink, a project root recorded by its
// real path) is one file to reconcile.
function fileId(path: string): string {
  return realpathOfExistingPrefix(path);
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
    notices.push(...answer.notices);
  }
  return { changes, removals, notices };
}
