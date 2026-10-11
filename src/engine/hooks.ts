import type { HarnessId } from "../contracts/harness-id.ts";
import {
  type HarnessContext,
  type HarnessDefinition,
  type Scope,
  scopeRoot,
} from "../harnesses/contract.ts";
import {
  hasHook,
  hookPath,
  planHookOnly,
  type RegistryRewrite,
  rewriteHookRegistry,
} from "../harnesses/hook-writer.ts";
import {
  type McpRegistration,
  mcpRegistrationAt,
  rewriteServers,
} from "../harnesses/mcp-stub/register.ts";
import type { State } from "../state/schema.ts";
import { type ScopeAt, scopedAt, scopesOf, withScopedList } from "../state/scoped.ts";
import { type Change, editInPlace } from "../util/change.ts";
import { ExitCode, MaximsError } from "../util/exit-codes.ts";
import { assertInsideRoot, followLinks, type RootedPath, realKeyOf } from "../util/fs.ts";
import { readConfigText } from "../util/jsonc.ts";
import { agentsAllowed, type EngineContext, harnessContext } from "./context.ts";
import { destinationConflict } from "./destination.ts";
import { destinationUnresolvable } from "./fs-probe.ts";
import { LinkedAtRuleFile } from "./rules.ts";
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

// Refuses a link an edit would pass through a rule file maxims owns whole: the sync planner's
// one judgment, shared files and registries alike, so a registry linked at a rule file never
// holds the registry until the next sync writes rules over the user's settings.
export type LinkJudge = (link: string, keys?: readonly string[]) => void;

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
// reach. The hook and the servers entry follow the scope's hook list and the harness's sources
// there; the config edit follows the rules alone. Each artifact is planned on its own: one that
// cannot be is reported and leaves the others standing. One `RegistryFile` per destination plans a
// file reached twice once.
export async function planHooks(input: {
  ctx: EngineContext;
  harnesses: readonly HarnessDefinition[];
  agents: HarnessFilter | undefined;
  judgeLink: LinkJudge;
  wants: (id: HarnessId, scope: Scope) => HarnessWants;
  // The roots of the other projects whose entries want the harness's hook.
  elsewhere: (id: HarnessId) => string[];
}): Promise<HooksPlan> {
  const { ctx } = input;
  const harnessCtx = harnessContext(ctx);
  const scopes: Scope[] = ctx.projectRoot === null ? ["global"] : ["global", "project"];
  const files = new RegistryFiles(input.judgeLink);
  const answers: ScopeAnswer[] = [];
  const failures: HooksPlan["failures"] = [];
  // A registry this run wants nothing from may be unreadable for reasons of its own; one it must
  // edit is a failure of this run, reported once however many artifacts share the file.
  const attempt = async <T>(mustEdit: boolean, plan: () => Promise<T>): Promise<T | null> => {
    try {
      return await plan();
    } catch (error) {
      if (!registryFailure(error)) throw error;
      if (mustEdit && !failures.some((failure) => failure.message === error.message)) {
        failures.push({ message: error.message, hint: error.hint });
      }
      return null;
    }
  };
  for (const def of input.harnesses) {
    if (!agentsAllowed(input.agents, def.id)) continue;
    // Every file this run's own scopes resolve to, a registry whose plan failed included: another
    // project's hook in such a file is this run's to plan, and the failure this run's to report.
    const reach = new Set<string>();
    for (const scope of scopes) {
      const wants = input.wants(def.id, scope);
      if (wants.unreachable) continue;
      const hook = await attempt(wants.hook, () =>
        hookAnswer(def, scope, harnessCtx, wants.hook, reach, files),
      );
      const mcp = await attempt(wants.hook, async () => {
        const registration = mcpRegistrationAt(def, scope, harnessCtx);
        if (registration === null) return null;
        reach.add(fileId(registration.path));
        return mcpAnswer(def, scope, harnessCtx, registration, wants.hook, files);
      });
      const config = await attempt(wants.rules, async () => {
        const edits = (await def.configEdit?.(scope, harnessCtx, wants.rules)) ?? [];
        return {
          changes: edits,
          files: [],
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
        return hookAnswer(def, "project", there, true, null, files);
      });
      const mcp = await attempt(true, async () => {
        const registration = resolvedThere(() => mcpRegistrationAt(def, "project", there));
        if (registration === undefined || registration === null) return null;
        if (!reach.has(fileId(registration.path))) return null;
        return mcpAnswer(def, "project", there, registration, true, files);
      });
      for (const answer of [hook, mcp]) {
        if (answer?.claims.some((file) => reach.has(fileId(file)))) {
          answers.push(answer);
        }
      }
    }
  }
  return { ...reconcile(answers), failures };
}

// `changes` are planned outright (a hook script, dsh's bridge, a config edit); `files` are the
// registries the answer rewrote, each emitted once however many answers rewrote it. `claims` are
// the files the answer resolves to whether or not it changes them there; the notices describe the
// artifact and are accepted or dropped with it.
type ScopeAnswer = {
  changes: Change[];
  files: RegistryFile[];
  claims: string[];
  wanted: boolean;
  notices: string[];
};

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

// A registry this run cannot read or edit (unparsable, a file where a folder should be, a link
// nothing can follow) fails that harness alone, the others proceeding. A registry linked at a rule
// file maxims owns whole refuses the plan whole instead, as a shared file's link does.
function registryFailure(error: unknown): error is MaximsError {
  return (
    error instanceof MaximsError &&
    error.code === ExitCode.DestinationWriteFailed &&
    !(error instanceof LinkedAtRuleFile)
  );
}

// The registry files this run rewrites, one per destination (the file a link at the path reaches,
// by its real path), so a leaf, a link to it and a link partway along the chain are one file.
// Wanted and unwanted rewrites keep separate files, since an unwanted rewrite is dropped whole when
// a wanted answer claims the file. The link is judged before the file is read through it.
class RegistryFiles {
  private readonly wanted = new Map<string, RegistryFile>();
  private readonly unwanted = new Map<string, RegistryFile>();

  constructor(private readonly judgeLink: LinkJudge) {}

  async at(root: string, path: RootedPath, wanted: boolean): Promise<RegistryFile> {
    this.judgeLink(path);
    const edit = editInPlace(root, path);
    // Where an edit lands does not depend on what it writes.
    const key = destinationOf(edit(""));
    const files = wanted ? this.wanted : this.unwanted;
    let file = files.get(key);
    if (file === undefined) {
      file = new RegistryFile(key, await readConfigText(path), edit);
      files.set(key, file);
    }
    return file;
  }
}

// One registry file as this run leaves it: every rewrite is planned over the text the one before
// it left, so the file gets one change however many artifacts land in it.
class RegistryFile {
  private text: string | null;
  readonly notices: string[] = [];

  constructor(
    readonly key: string,
    private readonly original: string | null,
    private readonly edit: (content: string) => Change,
  ) {
    this.text = original;
  }

  rewrite(plan: (currentText: string | null) => RegistryRewrite | null): void {
    const rewritten = plan(this.text);
    if (rewritten === null) return;
    this.text = rewritten.text;
    this.notices.push(rewritten.notice);
  }

  // The change the file ends in, or none when every rewrite found it current.
  planned(): Change | null {
    return this.text === null || this.text === this.original ? null : this.edit(this.text);
  }
}

// Where a change lands: the file behind the link an edit follows, the leaf a write replaces, under
// one spelling for one file.
function destinationOf(change: Change): string {
  return realKeyOf(change.kind === "edit" ? change.target : change.path);
}

// A file hook knows its file before it is planned; a custom hook names its files only through the
// changes it returns (dsh's bridge emits its hooks-file write whenever it is wanted).
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
// A registry is rewritten through its destination's file; a file hook is maxims's own artifact and
// stays a plain write, a real file wherever a link pointed.
async function hookAnswer(
  def: HarnessDefinition,
  scope: Scope,
  ctx: HarnessContext,
  wanted: boolean,
  reach: Set<string> | null,
  files: RegistryFiles,
): Promise<ScopeAnswer> {
  const declared = declaredHookFile(def, scope, ctx);
  if (declared !== null) reach?.add(fileId(declared));
  if (hasHook(def, "registry")) {
    const file = await files.at(scopeRoot(def, scope, ctx), hookPath(def, scope, ctx), wanted);
    file.rewrite((currentText) => rewriteHookRegistry({ def, scope, ctx, wanted, currentText }));
    return { changes: [], files: [file], claims: [file.key], wanted, notices: [] };
  }
  const plan = await planHookOnly({ def, scope, ctx, wanted });
  const claims = hookFiles(def, scope, ctx, plan.changes);
  for (const claim of claims) reach?.add(fileId(claim));
  return { changes: plan.changes, files: [], claims, wanted, notices: noticesOf(plan.notice) };
}

// The stub server entry, planned over the text the hook left in a file they share. A file hook is
// maxims's own file, written whole over any link at its path and deleted on removal, so a servers
// file whose path, or any link on the way to its file, is the hook file would lose the hook on the
// add or come back after the remove: refused, the hook standing.
async function mcpAnswer(
  def: HarnessDefinition,
  scope: Scope,
  ctx: HarnessContext,
  registration: McpRegistration,
  wanted: boolean,
  files: RegistryFiles,
): Promise<ScopeAnswer> {
  const file = await files.at(registration.root, registration.path, wanted);
  const hookFile = fileHookKey(def, scope, ctx);
  if (
    hookFile !== null &&
    entriesOf(registration.path).some((entry) => realKeyOf(entry) === hookFile)
  ) {
    throw new MaximsError(
      ExitCode.DestinationWriteFailed,
      `cannot register the maxims MCP server in ${registration.path}: it is the maxims hook file`,
      { hint: "declare the servers file apart from the hook's path in harnesses.json" },
    );
  }
  file.rewrite((currentText) => rewriteServers({ registration, wanted, currentText }));
  return { changes: [], files: [file], claims: [file.key], wanted, notices: [] };
}

// The files a change names by `realKeyOf`: its leaf, and for an edit the file behind the link too.
function filesOf(change: Change): string[] {
  return [...new Set([realKeyOf(change.path), destinationOf(change)])];
}

function noticesOf(notice: string | undefined): string[] {
  return notice === undefined ? [] : [notice];
}

// The file a file hook writes, by `realKeyOf`; null for another hook kind, and for a hook path this
// run cannot resolve (its folder linked out of the root), which the hook's own answer has reported
// and which no servers file can collide with.
function fileHookKey(def: HarnessDefinition, scope: Scope, ctx: HarnessContext): string | null {
  if (!hasHook(def, "file")) return null;
  try {
    return realKeyOf(hookPath(def, scope, ctx));
  } catch (error) {
    if (registryFailure(error) || destinationUnresolvable(error)) return null;
    throw error;
  }
}

// Every entry a path names on the way to its file: the leaf, each link passed, the file reached.
function entriesOf(path: string): string[] {
  const chain = followLinks(path);
  return [path, ...chain.hops, ...(chain.kind === "reached" ? [chain.end] : [])];
}

// One file under two spellings is one file to reconcile. The leaf is walked as an edit finds its
// target, never through `realpathSync`: node's folds a `..` in a link's target lexically
// (`hooks.json -> ../jump/../hooks.json`, `jump` a link) and names another file.
function fileId(path: string): string {
  const chain = followLinks(path);
  return realKeyOf(chain.kind === "reached" ? chain.end : path);
}

// One file can be reached twice: from both scopes (dsh's bridge under the global root; a home that
// is a repository), or by two harnesses. A removal touching a file a wanted answer claims is
// dropped whole, dsh's patch row included, or a project-only install would delete for the global
// scope the hook it wrote for the project. Files are matched by where a change lands:
//   a registry      -> its destination, the file behind every link to it
//   a wanted change -> its leaf, and the file it lands in
//   a claim         -> its leaf, plus the file behind it when no wanted change writes the leaf (a
//                      write there replaces the link with a real file)
//   a removal       -> its leaf and the file behind it, so a write at a link partway along a kept
//                      claim's chain is dropped too
function reconcile(
  answers: readonly ScopeAnswer[],
): Pick<HooksPlan, "changes" | "removals" | "notices"> {
  const changes: Change[] = [];
  const removals: Change[] = [];
  const notices: string[] = [];
  const wanted = answers.filter((answer) => answer.wanted);
  const touched = new Set(
    wanted.flatMap((answer) => [
      ...answer.changes.flatMap(filesOf),
      ...answer.files.map((file) => file.key),
    ]),
  );
  const kept = new Set(touched);
  for (const claim of wanted.flatMap((answer) => answer.claims)) {
    const key = realKeyOf(claim);
    kept.add(key);
    if (!touched.has(key)) kept.add(fileId(claim));
  }
  const keeps = (change: Change): boolean =>
    filesOf(change).some((file) => kept.has(file)) || kept.has(fileId(change.path));
  const emitted = new Set<RegistryFile>();
  for (const answer of answers) {
    const dropped =
      !answer.wanted &&
      (answer.changes.some(keeps) || answer.files.some((file) => kept.has(file.key)));
    if (dropped) continue;
    const into = answer.wanted ? changes : removals;
    into.push(...answer.changes);
    for (const file of answer.files) {
      if (emitted.has(file)) continue;
      emitted.add(file);
      const change = file.planned();
      if (change !== null) into.push(change);
      notices.push(...file.notices);
    }
    notices.push(...answer.notices);
  }
  return { changes, removals, notices };
}
