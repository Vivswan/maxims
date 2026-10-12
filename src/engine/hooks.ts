import { append, nil } from "@hyperjump/json-pointer";
import type { HarnessId } from "../contracts/harness-id.ts";
import {
  type ConfigRewrite,
  type HarnessContext,
  type HarnessDefinition,
  hookSpecFor,
  type OwnedChange,
  type RegistryRewrite,
  type Scope,
  scopeRoot,
} from "../harnesses/contract.ts";
import { hasHook, hookPath, planHookOnly, rewriteHookRegistry } from "../harnesses/hook-writer.ts";
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

// `broken` carries the planner's refusal of the registry (a dangling link, a file that does not
// parse): the harness's row says why, and the other harnesses are still reported.
export type HookStatus =
  | "current"
  | "missing"
  | "none"
  | "not-wanted"
  | { kind: "broken"; reason: string; hint: string | null };

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
  try {
    const planned = await plan({ def, scope, ctx, wanted: true });
    return planned.changes.length === 0 ? "current" : "missing";
  } catch (error) {
    if (!registryFailure(error)) throw error;
    return { kind: "broken", reason: error.message, hint: error.hint ?? null };
  }
}

// The word beside a judged hook; a harness with none, or none wanted, gets no word.
export function hookStatusText(status: HookStatus): string | null {
  if (status === "current") return "hook current";
  if (status === "missing") return "hook missing";
  if (typeof status === "object") return `hook broken: ${status.reason}`;
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
// cannot be is reported and leaves the others standing. Every edit of a user's file, a config
// edit included, is minted here over the one text the run holds for the file.
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
  const perHarness: ScopeAnswer[][] = [];
  // Reported once, and only when this run must edit the registry (one it wants nothing from may
  // be unreadable for reasons of its own). A rewrite's failure is keyed by its file: each rewrite
  // of a shared file names it by its own path.
  const failures = new Map<string, HooksPlan["failures"][number]>();
  const attempt = async <T>(
    mustEdit: boolean,
    plan: () => Promise<T>,
    file?: RegistryFile,
  ): Promise<T | null> => {
    try {
      return await plan();
    } catch (error) {
      if (!registryFailure(error)) throw error;
      const identity = file?.key ?? error.message;
      if (mustEdit && !failures.has(identity)) {
        failures.set(identity, { message: error.message, hint: error.hint });
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
        hookAnswer(def, scope, harnessCtx, wants.hook, reach, files),
      );
      const mcp = await attempt(wants.hook, async () => {
        const registration = mcpRegistrationAt(def, scope, harnessCtx);
        if (registration === null) return null;
        reach.add(fileId(registration.path));
        return mcpAnswer(def, scope, harnessCtx, registration, wants.hook, files);
      });
      const config = await attempt(wants.rules, async () => {
        const rewrites = (await def.configEdit?.(scope, harnessCtx, wants.rules)) ?? [];
        return rewriteAnswers(rewrites, [], wants.rules, files);
      });
      answers.push(...(hook ?? []), ...(mcp === null ? [] : [mcp]), ...(config ?? []));
    }
    // Another project's artifact in a file this run reaches too (dsh mounts one bridge under the
    // global root whatever the scope; a project rooted at the home directory shares the global
    // registry) is planned here as wanted, so a run with nothing of its own does not take it down.
    for (const root of input.elsewhere(def.id)) {
      const there = { ...harnessCtx, projectRoot: root, cwd: root };
      const hooks = await attempt(true, async () => {
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
      for (const answer of [...(hooks ?? []), ...(mcp === null ? [] : [mcp])]) {
        if (answer.claims.some((file) => reach.has(fileId(file)))) answers.push(answer);
      }
    }
    perHarness.push(answers);
  }
  const applied = new Set<ScopeAnswer>();
  const owned = new Set<string>();
  const entryKey = (rewrite: Rewrite): string => `${rewrite.file.key}\0${rewrite.entry}`;
  // A file that does not parse is this run's failure when it wants the entry there; a file that
  // must change behind a link the edit refuses is its failure whatever the intent, or the entry
  // stays where the intent says it should not with nothing said.
  const apply = async (answer: ScopeAnswer): Promise<void> => {
    const { rewrite } = answer;
    if (rewrite !== null) {
      const { file } = rewrite;
      const planned = await attempt(
        answer.wanted,
        async () => ({ text: file.plan(rewrite) }),
        file,
      );
      if (planned === null) return;
      if (planned.text !== null) {
        const { text } = planned;
        const alter = async () => file.alter(rewrite, text, answer.wanted);
        if ((await attempt(true, alter, file)) === null) return;
      }
      if (answer.wanted) owned.add(entryKey(rewrite));
    }
    applied.add(answer);
  };
  // Wanted rewrites land first, and an unwanted rewrite of an entry a wanted one owns is skipped:
  // two harnesses at one event or servers key share the entry, which stays for the one wanting it.
  // A wanted answer whose rewrite was refused claims nothing, so the other scope's removal stands.
  for (const answers of perHarness) {
    for (const answer of answers) if (answer.wanted) await apply(answer);
  }
  const admittedAnswers = perHarness.flatMap((answers) =>
    admitted(answers.filter((answer) => !answer.wanted || applied.has(answer))),
  );
  for (const answer of admittedAnswers) {
    if (answer.wanted) continue;
    if (answer.rewrite !== null && owned.has(entryKey(answer.rewrite))) continue;
    await apply(answer);
  }
  const changes: Change[] = [];
  const removals: Change[] = [];
  const notices: string[] = [];
  // A file takes the plan slot of the first admitted answer that reached it, skipped or not, so
  // the plan reads in harness order whatever each harness wants. An answer's own files go before
  // the edit its rewrite lands in: dsh's row points at its hooks file, so the file is written
  // first and a write that fails at apply stops the plan with no row mounted over nothing.
  const emitted = new Set<RegistryFile>();
  for (const answer of admittedAnswers) {
    if (applied.has(answer)) {
      (answer.wanted ? changes : removals).push(...answer.changes);
      notices.push(...answer.notices);
    }
    const file = answer.rewrite?.file;
    if (file !== undefined && !emitted.has(file)) {
      emitted.add(file);
      const planned = file.planned();
      if (planned !== null) {
        (planned.wanted ? changes : removals).push(planned.change);
        notices.push(...file.notices);
      }
    }
  }
  return { changes, removals, notices, failures: [...failures.values()] };
}

//   claims  -> the files the answer resolves to, changed there or not
//   rewrite -> its slot in a user's file, when the artifact has one (a hook registry, a servers
//              file, a config entry, dsh's patch row)
type ScopeAnswer = {
  changes: Change[];
  rewrite: Rewrite | null;
  claims: string[];
  wanted: boolean;
  notices: string[];
};

// `entry` is the slot in the file, the identity two harnesses collide on when their registries are
// one file. `edit` is minted when the rewrite alters the file: a settled file behind a link the
// edit would refuse (out of the root, dangling) costs nothing.
type Rewrite = {
  file: RegistryFile;
  entry: string;
  edit: () => (content: string) => Change;
  plan: (currentText: string | null) => RegistryRewrite | null;
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

// One `RegistryFile` per destination: a leaf, a link to it and a link partway along the chain are
// one file.
class RegistryFiles {
  private readonly files = new Map<string, RegistryFile>();

  constructor(private readonly judgeLink: LinkJudge) {}

  // Judged first, so a chain through a rule file maxims owns whole is refused whatever the read
  // would find.
  async at(root: string, path: RootedPath): Promise<Pick<Rewrite, "file" | "edit">> {
    this.judgeLink(path);
    const key = fileId(path);
    let file = this.files.get(key);
    if (file === undefined) {
      file = new RegistryFile(key, await readThrough(root, path));
      this.files.set(key, file);
    }
    return { file, edit: () => editInPlace(root, path) };
  }
}

// A link the edit cannot follow (to a directory, looped) fails the read too; the edit's refusal
// names the link and the fix, so it speaks first.
async function readThrough(root: string, path: RootedPath): Promise<string | null> {
  try {
    return await readConfigText(path);
  } catch (error) {
    if (registryFailure(error)) editInPlace(root, path);
    throw error;
  }
}

// One registry file as this run leaves it: every rewrite is planned over the text the one before
// it left. Its change is a removal only while no wanted rewrite altered the text: a hook run
// defers removals, and an entry a harness wants must not wait on another harness's leaving.
class RegistryFile {
  // `edit` is the first altering rewrite's, so the change is addressed at the path that first altered
  // the file; every altering rewrite still mints its own, so a refused path is refused whatever
  // altered the file before it.
  private altered: { text: string; edit: (content: string) => Change; wanted: boolean } | null =
    null;
  readonly notices: string[] = [];

  constructor(
    readonly key: string,
    private readonly original: string | null,
  ) {}

  // `null` when the file already says what the rewrite wants.
  plan(rewrite: Rewrite): RegistryRewrite | null {
    return rewrite.plan(this.altered?.text ?? this.original);
  }

  alter(rewrite: Rewrite, rewritten: RegistryRewrite, wanted: boolean): void {
    const edit = rewrite.edit();
    this.altered = {
      text: rewritten.text,
      edit: this.altered?.edit ?? edit,
      wanted: wanted || this.altered?.wanted === true,
    };
    if (rewritten.notice !== undefined) this.notices.push(rewritten.notice);
  }

  // Two rewrites may cancel (Codex's handler, `async` and `statusMessage` included, written over
  // Devin's, then Devin's back): text equal to the original plans nothing.
  planned(): { change: Change; wanted: boolean } | null {
    if (this.altered === null || this.altered.text === this.original) return null;
    return { change: this.altered.edit(this.altered.text), wanted: this.altered.wanted };
  }
}

function destinationOf(change: Change): string {
  return realKeyOf(change.kind === "edit" ? change.target : change.path);
}

// A file hook knows its file before it is planned.
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
// stays a plain write, a real file wherever a link pointed; a custom hook's rewrites are the
// planner's to mint, like a registry's.
async function hookAnswer(
  def: HarnessDefinition,
  scope: Scope,
  ctx: HarnessContext,
  wanted: boolean,
  reach: Set<string> | null,
  files: RegistryFiles,
): Promise<ScopeAnswer[]> {
  const declared = declaredHookFile(def, scope, ctx);
  if (declared !== null) reach?.add(fileId(declared));
  if (hasHook(def, "registry")) {
    const reached = await files.at(scopeRoot(def, scope, ctx), hookPath(def, scope, ctx));
    const plan: Rewrite["plan"] = (currentText) =>
      rewriteHookRegistry({ def, scope, ctx, wanted, currentText });
    const rewrite = { ...reached, entry: entryOf("hook", def.hook.eventPath), plan };
    return [{ changes: [], rewrite, claims: [reached.file.key], wanted, notices: [] }];
  }
  if (hasHook(def, "custom")) {
    const plan = await def.hook.reconcile(scope, ctx, hookSpecFor(def), wanted);
    // The rewrite's file joins `reach` only through a change that names it: dsh's bridge is
    // mounted for another project by that project's own sync, never by a run that merely reads
    // the patch file.
    for (const change of plan.changes) reach?.add(fileId(change.path));
    return rewriteAnswers(plan.rewrites, plan.changes, wanted, files);
  }
  const plan = await planHookOnly({ def, scope, ctx, wanted });
  const claims = hookFiles(def, scope, ctx, plan.changes);
  for (const claim of claims) reach?.add(fileId(claim));
  return [
    { changes: plan.changes, rewrite: null, claims, wanted, notices: noticesOf(plan.notice) },
  ];
}

// One answer per rewrite, the owned changes riding on the first, every answer claiming every file
// of the artifact: dsh's hooks file and its patch row are kept or taken down together. The file is
// reached before the plan runs, so a link at it is judged and read through whatever the rewrite
// would find; an artifact with nothing to plan answers nothing.
async function rewriteAnswers(
  rewrites: readonly ConfigRewrite[],
  owned: OwnedChange[],
  wanted: boolean,
  files: RegistryFiles,
): Promise<ScopeAnswer[]> {
  const reached: Rewrite[] = [];
  for (const { root, path, entry, rewrite } of rewrites) {
    const at = await files.at(root, path);
    reached.push({ ...at, entry: entryOf("config", entry), plan: rewrite });
  }
  const [first = null, ...rest] = reached;
  if (first === null && owned.length === 0) return [];
  const claims = [...owned.map((change) => change.path), ...reached.map((r) => r.file.key)];
  const answer = (rewrite: Rewrite | null, changes: Change[]): ScopeAnswer => ({
    changes,
    rewrite,
    claims,
    wanted,
    notices: [],
  });
  return [answer(first, owned), ...rest.map((rewrite) => answer(rewrite, []))];
}

// The stub server entry. A file hook is maxims's own file, written whole and deleted on removal,
// so a servers file at its path, or linked through it, would lose the hook on the add or bring
// the file back after the remove: refused, the hook standing.
async function mcpAnswer(
  def: HarnessDefinition,
  scope: Scope,
  ctx: HarnessContext,
  registration: McpRegistration,
  wanted: boolean,
  files: RegistryFiles,
): Promise<ScopeAnswer> {
  const reached = await files.at(registration.root, registration.path);
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
  const plan: Rewrite["plan"] = (currentText) =>
    rewriteServers({ registration, wanted, currentText });
  const rewrite = { ...reached, entry: entryOf("servers", registration.serversPath), plan };
  return { changes: [], rewrite, claims: [reached.file.key], wanted, notices: [] };
}

// A key path as a JSON pointer, so a segment holding a separator (`["mcp/one"]`) is not the
// nested path (`["mcp", "one"]`).
function entryOf(kind: "hook" | "servers" | "config", path: readonly string[]): string {
  return `${kind}${path.reduce((pointer, segment) => append(segment, pointer), nil)}`;
}

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

// The unwanted scope's removal applies last, and dsh's bridge is one file for both scopes: a
// project-only install must not delete for the global scope the hook it wrote. Per harness, since
// another harness's entry in a shared file is never this one's to keep. A file matches by where a
// change lands; a registry rewrite is dropped only for a file a wanted plain answer writes or
// claims (a file hook, dsh's bridge: maxims's own, written whole), since the entry a wanted rewrite
// owns is skipped by entry and every other entry of the leaving scope must go:
//   a registry      -> its destination, the file behind every link to it
//   a wanted change -> its leaf, and the file it lands in
//   a claim         -> its leaf, plus the file behind it when no wanted change writes the leaf (a
//                      write there replaces the link with a real file)
//   a removal       -> its leaf and the file behind it, so a write at a link partway along a kept
//                      claim's chain is dropped too
function admitted(answers: readonly ScopeAnswer[]): ScopeAnswer[] {
  const wanted = answers.filter((answer) => answer.wanted);
  const kept = filesKept(wanted);
  const held = filesKept(wanted.filter((answer) => answer.rewrite === null));
  const keeps = (change: Change): boolean =>
    filesOf(change).some((file) => kept.has(file)) || kept.has(fileId(change.path));
  return answers.filter(
    (answer) =>
      answer.wanted ||
      !(
        answer.changes.some(keeps) ||
        (answer.rewrite !== null && held.has(answer.rewrite.file.key))
      ),
  );
}

function filesKept(answers: readonly ScopeAnswer[]): Set<string> {
  const touched = new Set(
    answers.flatMap((answer) => [
      ...answer.changes.flatMap(filesOf),
      ...(answer.rewrite === null ? [] : [answer.rewrite.file.key]),
    ]),
  );
  const kept = new Set(touched);
  for (const claim of answers.flatMap((answer) => answer.claims)) {
    const key = realKeyOf(claim);
    kept.add(key);
    if (!touched.has(key)) kept.add(fileId(claim));
  }
  return kept;
}
