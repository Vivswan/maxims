import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import type { Console } from "../console/contract.ts";
import { type Collision, promptRenames } from "../console/rename.ts";
import {
  firstSourceFrom,
  found,
  hiddenCharacter,
  hookRegistered,
  installed,
  linksTo,
  memories,
  noTargetAtScope,
  notAMemory,
  notDefinedHere,
  ownedBy,
  privacyWarning,
  renameHint,
  replacedSelection,
  STRINGS,
  selected,
} from "../console/strings.ts";
import { type HarnessDefinition, type HarnessId, HOOK_COMMAND } from "../harnesses/contract.ts";
import {
  contentHashOf,
  type HiddenCharacter,
  hiddenCharacters,
  type Memory,
  type MemoryName,
  parseContentHash,
  parseMemory,
} from "../memory/contract.ts";
import { resolveWikilinks } from "../memory/wikilinks.ts";
import { materializeLocal } from "../sources/local.ts";
import type { TreeFile } from "../sources/tree.ts";
import type { UserConfig } from "../state/config.ts";
import {
  canonicalSourceKey,
  DEFAULT_GIT_REF,
  type Destination,
  GitRefSchema,
  parseGitSha,
  parseRemote,
  parseSourceSelector,
  type RenameMap,
  type Select,
  type SourceEntry,
  type SourceFrom,
  type State,
  storable,
} from "../state/schema.ts";
import { applyChanges, type Change } from "../util/change.ts";
import { ExitCode, MaximsError } from "../util/exit-codes.ts";
import { storePathFor } from "../util/home.ts";
import { flattenIssues } from "../util/zod-issues.ts";
import {
  configWrite,
  cooldownCapConfig,
  loadIntentFor,
  peekIntent,
  updateIntent,
  withDisabled,
} from "./shared/cli-context.ts";
import { framed } from "./shared/engine-io.ts";
import { swapStoreEntry, withoutAbsentDeletes } from "./shared/fetch.ts";
import { prunedHooks, withHooks } from "./shared/hooks.ts";
import {
  type AgentSelection,
  type Args,
  agentsFilter,
  type Command,
  type CommandContext,
  commonOptions,
  FLAGS,
  type FlagSpec,
  INTENT_DEFAULTS,
  parseAgents,
  parseDestination,
  parseRenames,
  parseSelect,
  usage,
} from "./shared/options.ts";
import { finish, mergePlans } from "./shared/output.ts";
import { insideProject, listedInLock, projectLockChange } from "./shared/project-lock-io.ts";
import {
  type MemoryRiskWarning,
  refuseRisky,
  riskWarningsFor,
  showRiskWarnings,
} from "./shared/risk.ts";
import { disabledNames } from "./shared/select.ts";
import { sourceSlug } from "./shared/slug.ts";
import {
  detectedHarnesses,
  effectiveNames,
  findSourceKey,
  harnessContext,
  installedAtOtherScope,
  installedSources,
  knownHarnessIds,
  realLocal,
  resolveIncoming,
  scopeOf,
  sourcesHere,
  storeTree,
  targetPath,
  tildify,
} from "./shared/sources.ts";
import type { CliIo, SyncOptions, SyncPreview, SyncReport } from "./types.ts";

export const DEFAULT_RULE_CAP = 25;

// Everything `add` decided from the command line and the config, parsed once into a shape that
// cannot hold a conflict: one destination, one selection, one harness choice.
export type AddRequest = {
  key: string;
  from: SourceFrom;
  destination: Destination;
  select: Select;
  rename: RenameMap;
  rule: boolean;
  addHook: boolean;
  shared: boolean;
  copy: boolean;
  memoryPath: string;
  fullDepth: boolean;
  paths: string[] | undefined;
  auth: boolean;
  agents: AgentSelection;
  allowHidden: boolean;
  strict: boolean;
  review: boolean;
  cap: number;
  list: boolean;
  noFetch: boolean;
  verbose: boolean;
  configChanges: UserConfig | null;
};

const ADD_FLAGS: readonly FlagSpec[] = [
  FLAGS.global,
  FLAGS.project,
  FLAGS.out,
  FLAGS.memory,
  FLAGS.agent,
  FLAGS.list,
  FLAGS.yes,
  FLAGS.all,
  FLAGS.rule,
  FLAGS.addHook,
  FLAGS.copy,
  FLAGS.from,
  FLAGS.fullDepth,
  FLAGS.link,
  FLAGS.share,
  FLAGS.pin,
  FLAGS.paths,
  FLAGS.auth,
  FLAGS.rename,
  FLAGS.allowHidden,
  FLAGS.strict,
  FLAGS.review,
  FLAGS.cooldown,
  FLAGS.cap,
  FLAGS.noFetch,
];

export const add: Command = {
  summary: "fetch a source, record it in state, then sync",
  usage: "add <source>",
  arity: 1,
  flags: ADD_FLAGS,
  async run(args, ctx) {
    const request = await parseAddRequest(args, ctx);
    const yes = args.flag(FLAGS.yes) || args.flag(FLAGS.all) || ctx.config.yes === true;
    const console = await ctx.openConsole(yes);
    console.intro();
    if (request.list) {
      for (const spec of [FLAGS.rule, FLAGS.addHook, FLAGS.yes]) {
        if (args.flag(spec)) console.warn(`--${spec.name} is ignored with --list`);
      }
      if (args.value(FLAGS.out) !== undefined) console.warn("--out is ignored with --list");
    }
    const stage = await stageAdd(request, ctx, console);
    if (stage.kind === "store-empty") {
      return finish(ctx, console, {
        plan: { changes: [], notices: [] },
        notices: [],
        json: { source: request.key, memories: [], harnesses: [] },
        lines: [STRINGS.storeEmpty],
      });
    }
    // A preview has no plan to sit above, and its output is the specified listing.
    const provenance = request.list ? null : provenanceFor(stage.staged);
    if (provenance !== null) showProvenance(console, provenance);
    const outcome = await planAdd(stage.staged, ctx, console, []);
    if (outcome.kind !== "prepared") return ExitCode.Ok;
    const { prepared } = outcome;
    const commit = await commitAdd([prepared], ctx, { writeManifest: true });
    const report = await syncCommitted(ctx, commit, commit.harnesses);
    const planned = ctx.global.dryRun;
    const lines = [installed(prepared.names.length, report.rules, report.tokens, planned)];
    for (const _ of commit.hooked) lines.push(hookRegistered(HOOK_COMMAND, planned));
    const code = finish(ctx, console, {
      plan: mergePlans({ changes: commit.changes, notices: [] }, report.plan),
      notices: [...commit.notices, ...report.notices],
      json: {
        source: prepared.request.key,
        memories: prepared.names,
        harnesses: prepared.harnesses.ids,
        warnings: prepared.warnings,
        provenance,
      },
      lines,
    });
    if (!ctx.global.json && !ctx.global.quiet) console.gap();
    return code;
  },
};

// The sync that follows a commit never fetches (the commit just did) and, under --dry-run, plans
// against the state the commit would have written, since the file itself was left alone. The
// verb frames the output, so the engine's own lines go nowhere and its report is what is shown;
// `--quiet` is the frame's silence, never the hook's debounce or deferred deletions, so the
// engine runs it as an interactive sync.
export function syncCommitted(
  ctx: CommandContext,
  preview: SyncPreview & { retired?: readonly SourceEntry[] },
  agents: readonly HarnessId[],
): Promise<SyncReport> {
  return framed(ctx.io, (io) => ctx.engine.runSync(committedSyncOptions(ctx, preview, agents), io));
}

function committedSyncOptions(
  ctx: CommandContext,
  preview: SyncPreview & { retired?: readonly SourceEntry[] },
  agents: readonly HarnessId[],
): SyncOptions {
  const retired = preview.retired ?? [];
  return {
    ...commonOptions(ctx.global),
    quiet: false,
    fetch: "none",
    ...agentsFilter(agents),
    ...(retired.length === 0 ? {} : { retired: [...retired] }),
    ...(ctx.global.dryRun ? { preview } : {}),
  };
}

// Whether the destinations admit what an intent edit would install: the plan the edit's sync
// would make, drawn against the state and store writes as they would land, before any of them
// does. A collision, a cap or a byte budget the engine refuses stops here, so the one commit point
// keeps its promise that a refused install leaves the machine as it was.
export async function admitIntent(
  ctx: CommandContext,
  preview: SyncPreview,
  agents: readonly HarnessId[],
): Promise<void> {
  const options: SyncOptions = {
    ...committedSyncOptions(ctx, preview, agents),
    dryRun: true,
    json: false,
    preview,
  };
  await framed(ctx.io, (io) => ctx.engine.runSync(options, io));
}

// A live source registers no hook: a refresh would clobber an unpushed edit, so the wish is
// dropped for that variant however it was expressed. An `-o` folder is no harness's scope, so it
// has no hook list to record the wish in.
export function hookWanted(from: SourceFrom, destination: Destination, wanted: boolean): boolean {
  if (destination.scope === "out") return false;
  return wanted && !(from.type === "local" && from.live === true);
}

export async function parseAddRequest(args: Args, ctx: CommandContext): Promise<AddRequest> {
  const { io, config } = ctx;
  const sourceArg = args.positionals[0];
  if (sourceArg === undefined) throw usage(STRINGS.missingSource);
  const selector = parseSourceSelector(sourceArg, io.cwd, { ghHost: io.env.GH_HOST });
  const list = args.flag(FLAGS.list);
  if (args.flag(FLAGS.noFetch) && !list) {
    throw usage("--no-fetch on add previews the store copy; add --list", {
      hint: "an install always fetches; run sync --no-fetch for an offline apply",
    });
  }
  const pin = args.value(FLAGS.pin);
  const link = args.flag(FLAGS.link);
  const review = args.flag(FLAGS.review);
  let from = selector.from;
  if (from.type === "local") {
    if (pin !== undefined) throw usage("--pin applies to a GitHub or git source, not a directory");
    // The real path is the identity: state, the store entry and the project manifest then agree
    // on one location whether the user typed the directory or a symlink to it.
    const path = realLocal(from).path;
    from =
      link || sourceArg === "." ? { type: "local", path, live: true } : { type: "local", path };
    // A live directory is read in place at every sync, so there is no fetch to hold back.
    if (review && from.live === true) {
      throw usage("--review applies to a fetched source; a live directory is read in place");
    }
  } else {
    if (link) throw usage("--link applies to a local directory");
    // Only the ref that survives to storage is judged: a `/tree/<ref>` the state schema refuses is
    // a fine spelling when `--pin` replaces it.
    from = {
      ...from,
      ref: pin === undefined ? storable(GitRefSchema, from.ref, sourceArg) : gitRefOrUsage(pin),
    };
  }
  const explicitDestination = parseDestination(args, io.cwd, io.projectRoot);
  const destination: Destination =
    explicitDestination ??
    (io.projectRoot !== null && from.type !== "local"
      ? { scope: "project", root: io.projectRoot }
      : { scope: "global" });
  if (args.flag(FLAGS.share) && destination.scope !== "project") {
    throw usage("--share applies to a project install; drop -g or -o", {
      hint: "the project lock holds project-scope sources only",
    });
  }
  // A source the team's lock lists stays the team's: the mark is inherited, as `install` sets it.
  // A `--list` takes nothing over, so it reads no lock.
  const shared =
    destination.scope === "project" &&
    (args.flag(FLAGS.share) || (!list && (await listedInLock(destination.root, from))));
  if (shared && destination.scope === "project") assertShareable(from, destination.root);
  const explicitSelect = parseSelect(args);
  let select: Select = explicitSelect ?? "*";
  if (selector.memory !== null) {
    if (args.flag(FLAGS.all)) throw usage(STRINGS.allWithNames);
    select =
      explicitSelect === null || explicitSelect === "*"
        ? [selector.memory]
        : [...new Set([...explicitSelect, selector.memory])];
  }
  const configChanges = cooldownCapConfig(args, config);
  const paths = args.list(FLAGS.paths);
  return {
    key: canonicalSourceKey(from),
    from,
    destination,
    select,
    rename: parseRenames(args),
    rule: args.flag(FLAGS.rule) || config.rule === true,
    addHook: hookWanted(from, destination, args.flag(FLAGS.addHook) || config.addHook === true),
    shared,
    copy: args.flag(FLAGS.copy),
    memoryPath: args.value(FLAGS.from) ?? INTENT_DEFAULTS.memoryPath,
    fullDepth: args.flag(FLAGS.fullDepth),
    paths: paths.length === 0 ? undefined : paths,
    auth: args.flag(FLAGS.auth) || io.env.MAXIMS_AUTH === "1",
    agents: parseAgents(args, knownHarnessIds(io)),
    allowHidden: args.flag(FLAGS.allowHidden),
    strict: args.flag(FLAGS.strict),
    review,
    cap: configChanges?.ruleCap ?? config.ruleCap ?? DEFAULT_RULE_CAP,
    list,
    noFetch: args.flag(FLAGS.noFetch),
    verbose: ctx.global.verbose,
    configChanges,
  };
}

// A local source outside the checkout has no path a teammate's checkout can follow, so it cannot
// be shared; the refusal names the way out.
export function assertShareable(from: SourceFrom, projectRoot: string): void {
  if (from.type !== "local" || insideProject(projectRoot, from.path)) return;
  throw usage(`${from.path} lies outside the project, so a teammate's checkout cannot reach it`, {
    hint: "move it inside the project, or install it with -g",
  });
}

// The ref lands in a source key and from there in a rule-file marker, so the state schema's
// marker rules judge it here, where the refusal can name the flag.
function gitRefOrUsage(candidate: string): string {
  const parsed = GitRefSchema.safeParse(candidate);
  if (parsed.success) return parsed.data;
  throw usage(`--pin "${candidate}": ${flattenIssues(parsed.error.issues).join("; ")}`);
}

type FetchedFiles = { sha: string; memoryPath: string; files: TreeFile[] };
type FetchedTree = FetchedFiles | { kind: "store-empty" };

export type PreparedAdd = {
  request: AddRequest;
  tree: FetchedFiles;
  recorded: Memory[];
  chosen: Memory[];
  staged: State;
  rename: RenameMap;
  harnesses: HarnessChoice;
  names: MemoryName[];
  warnings: MemoryRiskWarning[];
};

export type PrepareOutcome =
  | { kind: "listed" }
  | { kind: "store-empty" }
  | { kind: "cancelled" }
  | { kind: "prepared"; prepared: PreparedAdd };

// A source after steps 1 and 2: fetched, scanned and filtered, nothing validated yet. `install`
// stages every manifest entry before planning any, so the entries validate against each other.
// `memories` are the ones the user can see; `recorded` every valid one, hidden internal memories
// included, because the fetch record is a fact about the source and a refresh writes it that way.
export type StagedAdd = {
  request: AddRequest;
  tree: FetchedFiles;
  memories: Memory[];
  recorded: Memory[];
  chosen: Memory[];
  state: State;
  // The local names the commit switches off at the project beside the ones state already holds:
  // the manifest's `disabled` list on a replay, nothing on a plain add.
  disabledByManifest: readonly MemoryName[];
};

export type StageOutcome = { kind: "store-empty" } | { kind: "staged"; staged: StagedAdd };

export async function stageAdd(
  requested: AddRequest,
  ctx: CommandContext,
  console: Console,
): Promise<StageOutcome> {
  const { io } = ctx;
  console.step(`Source: ${describeSource(requested.from)}`);
  const tree = await fetchTree(requested, io, console);
  if ("kind" in tree) return { kind: "store-empty" };
  const intent = requested.list
    ? await peekIntent(io.home)
    : await loadIntentFor(io.home, ctx.global.dryRun);
  for (const notice of intent.notices) console.warn(notice);
  const request = adoptRecordedKey(requested, intent.state, io);
  const scan = scanMemories(request, tree.files, io.env, console);
  console.step(found(scan.memories.length, scan.internalHidden));
  const chosen = filterSelection(request.select, scan.memories);
  if (chosen.length === 0) {
    throw new MaximsError(
      ExitCode.NothingResolved,
      "No valid memories found. Memories require frontmatter with name and description.",
    );
  }
  if (request.select !== "*") console.step(selected(chosen.map((memory) => memory.name)));
  return {
    kind: "staged",
    staged: {
      request,
      tree,
      memories: scan.memories,
      recorded: scan.recorded,
      chosen,
      state: intent.state,
      disabledByManifest: [],
    },
  };
}

// Steps 3 and 4: validate, show the plan and confirm. No intent and no destination is written, so
// a failure here (exit 3, 6, 7, 8) leaves the machine as it was, apart from a corrupt state file a
// real run's locking read has already moved aside. `--list` stops before validation: a preview
// exists so the user can see and narrow a source whose install would be refused. `siblings` are
// the other sources staged in the same run: their names satisfy wikilinks and take part in the
// collision walk as if they were already recorded. The risk warnings sit above the plan, so the
// reader judges the one-liners with the shapes named; `--strict` turns them into the refusal. A
// memory disabled at the destination lands in no rule file, so its description is not judged.
export async function planAdd(
  staged: StagedAdd,
  ctx: CommandContext,
  console: Console,
  siblings: readonly StagedAdd[],
): Promise<PrepareOutcome> {
  const { io } = ctx;
  const { request, tree, chosen } = staged;
  const existing = staged.state.sources[request.key];
  if (request.list) {
    console.gap();
    console.note("", STRINGS.availableMemories);
    showItems(console, chosen, request.rename, request.verbose);
    console.outro(STRINGS.runWithoutList);
    return { kind: "listed" };
  }
  const rename = await validate(request, chosen, staged.state, siblings, ctx, console);
  const harnesses = await chooseHarnesses(request, ctx, console);
  if (harnesses === null) {
    console.step(STRINGS.installationCancelled);
    return { kind: "cancelled" };
  }
  console.gap();
  if (existing !== undefined && !sameSelect(existing.intent.select, request.select)) {
    console.step(replacedSelection(showSelect(existing.intent.select), showSelect(request.select)));
  }
  const disabled = new Set([
    ...disabledNames(staged.state, request.destination.scope, io.projectRoot),
    ...staged.disabledByManifest,
  ]);
  const warnings = riskWarningsFor(
    chosen.filter((memory) => !disabled.has(renamed(rename, memory.name))),
  );
  showRiskWarnings(console, warnings);
  if (request.strict) refuseRisky(warnings);
  console.note(planBody(request, harnesses.ids, io), STRINGS.memoriesToInstall);
  if (
    request.from.type === "local" &&
    request.destination.scope === "project" &&
    io.projectRoot !== null
  ) {
    console.warn(privacyWarning(io.projectRoot));
  }
  for (const warning of harnesses.warnings) console.warn(warning);
  console.gap();
  showItems(console, chosen, rename, request.verbose);
  const proceed = await console.confirm(STRINGS.proceed, true);
  if (!proceed) {
    console.step(STRINGS.installationCancelled);
    return { kind: "cancelled" };
  }
  return {
    kind: "prepared",
    prepared: {
      request,
      tree,
      recorded: staged.recorded,
      chosen,
      staged: staged.state,
      rename,
      harnesses,
      names: chosen.map((memory) => renamed(rename, memory.name)).sort(),
      warnings,
    },
  };
}

// A harness that declares no hook shape has nothing to register; asking for one is not an error,
// it is a no-op that must not be reported as a registration.
function hookable(ids: readonly HarnessId[], io: CliIo): HarnessId[] {
  return ids.filter((id) => io.harnesses.some((def) => def.id === id && def.hook.kind !== "none"));
}

// GitHub names are case-insensitive and the state file refuses two spellings of one repository,
// so a re-add typed in another case continues the recorded entry under its recorded key. State
// holds one entry per source, so a source recorded for another project cannot be added here in
// any scope without taking that project's entry over, and one recorded at another scope cannot be
// moved by a re-add; both are refused with the way out named. A re-add under another `-o` folder
// stays a move of the same scope: the retired folder is swept by the sync that follows. A
// `--list` takes nothing over and previews the source wherever it is recorded.
function adoptRecordedKey(request: AddRequest, state: State, io: CliIo): AddRequest {
  const recorded = findSourceKey(state, request.key);
  if (recorded === null) return request;
  const entry = state.sources[recorded];
  if (entry === undefined) return request;
  const { destination } = entry.intent;
  if (!request.list && destination.scope === "project" && destination.root !== io.projectRoot) {
    throw new MaximsError(
      ExitCode.Usage,
      `${recorded} is installed for the project at ${destination.root}`,
      { hint: "remove it from that project first, or install it there" },
    );
  }
  if (!request.list && destination.scope !== request.destination.scope) {
    throw installedAtOtherScope(recorded, destination, request.destination);
  }
  if (recorded === request.key) return request;
  return { ...request, key: recorded, from: entry.intent.from };
}

// `harnesses` are the ones the sync after the commit must reach: every harness the recorded
// entries list now and listed before, so a re-add that drops one takes its files with it; empty
// means every harness, which a manifest's disabled names call for, since a name switched off may
// belong to any project source. `retired` are the previous entries a re-add moved to another
// destination, whose old folders the sync sweeps.
export type CommitOutcome = SyncPreview & {
  notices: string[];
  hooked: HarnessId[];
  harnesses: HarnessId[];
  retired: SourceEntry[];
};

// `install` passes `writeManifest: false` because the manifest is its input, not a projection of
// its result, and `disabledAtProject` because the names the manifest switches off land in the
// same state document as the sources, so a replay is one write and one sync.
export type CommitOptions = {
  writeManifest: boolean;
  disabledAtProject?: readonly MemoryName[];
};

// Steps 5 and 6: the one durable transition, for one or several prepared sources under one lock.
// The store entries, the manifest projection and the config file ride in the same plan as the
// state write; the caller runs the sync that writes destinations.
export async function commitAdd(
  prepared: readonly PreparedAdd[],
  ctx: CommandContext,
  options: CommitOptions,
): Promise<CommitOutcome> {
  const { io } = ctx;
  const now = io.now().toISOString();
  const hooked = new Set<HarnessId>();
  const reached = new Set<HarnessId>();
  const retired: SourceEntry[] = [];
  let everyHarness = false;
  let config: UserConfig = { ...ctx.config };
  const update = await updateIntent(
    io.home,
    ctx.global.dryRun,
    async (current) => {
      let state = current.state;
      const changes: Change[] = [];
      let touchesProject = false;
      let configChanged = false;
      for (const item of prepared) {
        const { request, harnesses } = item;
        const previous = state.sources[request.key];
        for (const id of [...(previous?.intent.harnesses ?? []), ...harnesses.ids]) reached.add(id);
        if (
          previous !== undefined &&
          !sameDestination(previous.intent.destination, request.destination)
        ) {
          retired.push(previous);
        }
        const entry = buildEntry(
          request,
          item.rename,
          harnesses.ids,
          item.tree,
          item.recorded,
          now,
          state,
        );
        state = { ...state, sources: { ...state.sources, [request.key]: entry } };
        if (request.addHook && request.destination.scope !== "out") {
          state = withHooks(state, request.destination, hookable(harnesses.ids, io));
        }
        changes.push(...storeEntryChanges(request.from, io.home, item.tree.files));
        if (
          previous?.intent.destination.scope === "project" ||
          request.destination.scope === "project"
        ) {
          touchesProject = true;
        }
        if (request.configChanges !== null) {
          config = { ...config, ...request.configChanges };
          configChanged = true;
        }
        if (harnesses.remember) {
          config.lastAgents = harnesses.ids;
          configChanged = true;
        }
        if (request.addHook) for (const id of hookable(harnesses.ids, io)) hooked.add(id);
      }
      state = prunedHooks(state);
      if (io.projectRoot !== null) {
        const at = { scope: "project", root: io.projectRoot } as const;
        for (const name of options.disabledAtProject ?? []) {
          const edit = withDisabled(state, at, name, true);
          state = edit.state;
          everyHarness ||= edit.changed;
        }
      }
      if (options.writeManifest && touchesProject && io.projectRoot !== null) {
        const lock = await projectLockChange(io.projectRoot, current.state, state, io);
        if (lock !== null) changes.push(lock);
      }
      if (configChanged) changes.push(configWrite(io.home, config));
      await admitIntent(ctx, { state, config, changes }, everyHarness ? [] : [...reached]);
      return { state, changes, notices: [...current.notices] };
    },
    (plan) => applyChanges(plan, { dryRun: ctx.global.dryRun }),
  );
  return {
    state: update.state,
    config,
    changes: update.changes,
    notices: update.notices,
    hooked: [...hooked],
    harnesses: everyHarness ? [] : [...reached],
    retired,
  };
}

function sameDestination(a: Destination, b: Destination): boolean {
  return a.scope === b.scope && (a.scope !== "out" || b.scope !== "out" || a.path === b.path);
}

// The store entry a fetched tree lands in: a local directory through the local materializer (a
// live one becomes a link), a remote through the same swap every refresh plans. A first install
// has no entry to replace, so no deletion of one is planned.
function storeEntryChanges(from: SourceFrom, home: string, files: readonly TreeFile[]): Change[] {
  if (from.type === "local") return withoutAbsentDeletes(materializeLocal(from, home, [...files]));
  return swapStoreEntry(storePathFor(home, from), [...files]);
}

export function describeSource(from: SourceFrom): string {
  switch (from.type) {
    case "github":
      return `https://${from.host ?? "github.com"}/${from.repo}.git`;
    case "git":
      return from.url;
    case "local":
      return from.path;
  }
}

// Where a remote source comes from, shown once, on the first install from an owner this machine
// holds nothing else from: the review gate for a source is the plan, and a plan from a stranger
// deserves the repository, the commit and the size named beside it. `pinned` is the ref a pin
// tracks, null when the source follows the default branch.
export type Provenance = {
  owner: string;
  url: string;
  sha: string;
  memories: number;
  pinned: string | null;
};

// The owner of a remote: the GitHub account under its host, or a git host and the first path
// segment (`git.example.com/team`), both lower-cased so a GitHub Enterprise repository spelled as
// a URL and as a shorthand is one owner (GitHub names are case-insensitive). A local directory
// has no owner to be new. A git URL the store cannot place is its own owner.
export function sourceOwner(from: SourceFrom): string | null {
  if (from.type === "github") {
    const [owner = ""] = from.repo.toLowerCase().split("/", 1);
    return `${from.host ?? "github.com"}/${owner}`;
  }
  if (from.type === "local") return null;
  const remote = parseRemote(from.url);
  const [first] = remote?.segments ?? [];
  if (remote === null || first === undefined) return from.url;
  return `${remote.host}/${first.toLowerCase()}`;
}

// A re-add of a recorded source is not a first install, so the recorded entry counts as known.
export function provenanceFor(staged: StagedAdd): Provenance | null {
  const { request, tree, memories, state } = staged;
  const owner = sourceOwner(request.from);
  if (owner === null || request.from.type === "local") return null;
  const known = Object.values(state.sources).some(
    (entry) => sourceOwner(entry.intent.from) === owner,
  );
  if (known) return null;
  return {
    owner,
    url: describeSource(request.from),
    sha: tree.sha,
    memories: memories.length,
    pinned: request.from.ref === DEFAULT_GIT_REF ? null : request.from.ref,
  };
}

export function showProvenance(console: Console, provenance: Provenance): void {
  const pin =
    provenance.pinned === null
      ? `not pinned (tracks ${DEFAULT_GIT_REF})`
      : `pinned to ${provenance.pinned}`;
  console.note(
    [
      provenance.url,
      `commit ${provenance.sha.slice(0, 7)}, ${pin}`,
      memories(provenance.memories),
    ].join("\n"),
    firstSourceFrom(provenance.owner),
  );
}

// A fetch lands in a temp directory removed on every path; a `--list --no-fetch` walks the store
// copy instead, the way the fetch walked the source, and never opens a socket, which is what keeps
// the benchmark's preview offline.
async function fetchTree(request: AddRequest, io: CliIo, console: Console): Promise<FetchedTree> {
  if (request.noFetch) {
    const tree = await storeTree(storePathFor(io.home, request.from), request);
    if (tree === null) return { kind: "store-empty" };
    return { sha: "store", memoryPath: request.memoryPath, files: tree.files };
  }
  const local = request.from.type === "local";
  const tempDir = mkdtempSync(join(tmpdir(), "maxims-add-"));
  const spinner = console.spinner(local ? STRINGS.readingDirectory : STRINGS.cloning);
  try {
    const resolver = io.resolvers(request.from);
    const result = await resolver.fetch(request.from, {
      memoryPath: request.memoryPath,
      fullDepth: request.fullDepth,
      tempDir,
      auth: request.auth,
    });
    spinner.stop(local ? STRINGS.directoryRead : STRINGS.cloned);
    return { sha: result.sha, memoryPath: result.memoryPath, files: result.files };
  } catch (error) {
    spinner.fail(local ? STRINGS.directoryUnreadable : STRINGS.cloneFailed);
    if (error instanceof MaximsError) throw error;
    const detail = error instanceof Error ? error.message : String(error);
    throw new MaximsError(
      ExitCode.SourceUnresolvable,
      `cannot fetch ${describeSource(request.from)}: ${detail}`,
      {
        cause: error,
      },
    );
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
}

type Scan = { memories: Memory[]; recorded: Memory[]; internalHidden: number };

// Every `.md` under the memory folder is parsed; a file that fails the contract is skipped with
// one warning naming the reason, never fatal. A memory marked internal is hidden unless it was
// named on the command line or MAXIMS_INSTALL_INTERNAL=1 asks for the internal set; it still
// enters the fetch record, which lists what the source ships.
function scanMemories(
  request: AddRequest,
  files: readonly TreeFile[],
  env: Record<string, string | undefined>,
  console: Console,
): Scan {
  const named = new Set<string>(request.select === "*" ? [] : request.select);
  const installInternal = env.MAXIMS_INSTALL_INTERNAL === "1";
  const memories: Memory[] = [];
  const recorded: Memory[] = [];
  let internalHidden = 0;
  for (const file of files) {
    if (!file.relPath.endsWith(".md")) continue;
    const parsed = parseMemory(file.relPath, file.text);
    if (!parsed.ok) {
      console.warn(notAMemory(basename(file.relPath), parsed.reason));
      continue;
    }
    if (parsed.warning !== undefined) console.warn(`${parsed.memory.name}: ${parsed.warning}`);
    recorded.push(parsed.memory);
    if (
      parsed.memory.metadata.internal === true &&
      !installInternal &&
      !named.has(parsed.memory.name)
    ) {
      internalHidden += 1;
      continue;
    }
    memories.push(parsed.memory);
  }
  const byName = (a: Memory, b: Memory) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
  return { memories: memories.sort(byName), recorded: recorded.sort(byName), internalHidden };
}

function filterSelection(select: Select, memories: readonly Memory[]): Memory[] {
  if (select === "*") return [...memories];
  const byName = new Map(memories.map((memory) => [memory.name, memory] as const));
  const missing = select.filter((name) => !byName.has(name));
  if (missing.length > 0) {
    const available = memories.map((memory) => `  - ${memory.name}`).join("\n");
    throw new MaximsError(
      ExitCode.NothingResolved,
      `No matching memories found for: ${missing.join(", ")}\nAvailable memories:\n${available}`,
    );
  }
  return select.flatMap((name) => {
    const memory = byName.get(name);
    return memory === undefined ? [] : [memory];
  });
}

// Step 3: the hidden-character gate, the wikilink check and the collision walk, in that order, all
// before anything is written. A collision is offered a rename when the console can ask; the
// answer is merged into the request's rename map and the walk runs again against it.
async function validate(
  request: AddRequest,
  chosen: readonly Memory[],
  state: State,
  siblings: readonly StagedAdd[],
  ctx: CommandContext,
  console: Console,
): Promise<RenameMap> {
  if (!request.allowHidden) {
    for (const memory of chosen) {
      const hidden = hiddenCharacters(memory.description);
      const first = hidden[0];
      if (first !== undefined) {
        throw new MaximsError(
          ExitCode.NothingResolved,
          hiddenCharacter(memory.name, describeHidden(first), first.index + 1),
          { hint: "pass --allow-hidden to install it anyway" },
        );
      }
    }
  }
  const installedNames = new Set<string>();
  for (const [key, entry] of sourcesHere(state, ctx.io)) {
    if (key === request.key || siblings.some((sibling) => sibling.request.key === key)) continue;
    for (const name of await effectiveNames(entry, ctx.io)) installedNames.add(name);
  }
  for (const sibling of siblings) {
    for (const memory of sibling.chosen) {
      installedNames.add(renamed(sibling.request.rename, memory.name));
    }
  }
  let rename: RenameMap = { ...request.rename };
  const unknownRenames = Object.keys(rename).filter(
    (name) => !chosen.some((memory) => memory.name === name),
  );
  if (unknownRenames.length > 0) {
    throw new MaximsError(
      ExitCode.NothingResolved,
      `--rename names memories the source lacks: ${unknownRenames.join(", ")}`,
    );
  }
  const { unmet } = resolveWikilinks([...chosen], installedNames, rename);
  const firstUnmet = unmet[0];
  if (firstUnmet !== undefined) {
    throw new MaximsError(ExitCode.UnmetDependency, linksTo(firstUnmet.memory, firstUnmet.link), {
      hint: `install a source providing ${firstUnmet.link} first`,
    });
  }
  const installed = [
    ...(await installedSources(state, ctx.io)).filter(
      (source) => !siblings.some((sibling) => sibling.request.key === source.key),
    ),
    ...siblings.map((sibling) => ({
      key: sibling.request.key,
      addedAt: ctx.io.now().toISOString(),
      intent: { select: sibling.request.select, rename: sibling.request.rename },
      names: sibling.memories.map((memory) => memory.name),
    })),
  ];
  for (;;) {
    const outcome = resolveIncoming({
      source: request.key,
      memories: chosen.map((memory) => ({
        name: memory.name,
        description: memory.description,
        contentHash: contentHashOf(memory.raw),
      })),
      select: "*",
      rename,
      rule: request.rule,
      cap: request.cap,
      installed,
    });
    if (outcome.ok) return rename;
    if (outcome.code === ExitCode.RuleCapExceeded) {
      throw new MaximsError(
        ExitCode.RuleCapExceeded,
        `${request.key} would publish ${outcome.count} rule lines, over the cap of ${outcome.cap}`,
        { hint: outcome.hint },
      );
    }
    const collisions: Collision[] = outcome.collisions;
    const taken = new Set<string>(installedNames);
    for (const memory of chosen) taken.add(renamed(rename, memory.name));
    const answer = await promptRenames(console, collisions, renameSuffix(request.from), taken);
    const first = collisions[0];
    if (answer.kind === "declined" || first === undefined) {
      const owner = first === undefined ? request.key : first.ownedBy;
      const name = first === undefined ? "" : first.name;
      throw new MaximsError(ExitCode.NameCollision, ownedBy(name, owner), {
        hint: renameHint(name),
      });
    }
    // The prompt answers per LOCAL name; the map is keyed by upstream name, so an answer for a
    // memory already renamed once replaces that memory's entry rather than adding a second hop.
    for (const [local, next] of Object.entries(answer.rename)) {
      const upstream = chosen.find((memory) => renamed(rename, memory.name) === local);
      if (upstream !== undefined) rename = { ...rename, [upstream.name]: next };
    }
  }
}

function renameSuffix(from: SourceFrom): string {
  const tail = sourceSlug(from).split("-").pop();
  return tail === undefined || tail === "" ? "renamed" : tail;
}

const HIDDEN_LABELS: Record<number, string> = {
  8203: "zero-width space",
  8204: "zero-width non-joiner",
  8205: "zero-width joiner",
  8288: "word joiner",
  65279: "byte order mark",
};

function describeHidden(hidden: HiddenCharacter): string {
  if (hidden.kind === "html-comment") return "an HTML comment";
  const hex = `U+${hidden.codePoint.toString(16).toUpperCase().padStart(4, "0")}`;
  const label = HIDDEN_LABELS[hidden.codePoint] ?? `${hidden.kind} character`;
  return `${hex} ${label}`;
}

type HarnessChoice = { ids: HarnessId[]; warnings: string[]; remember: boolean };

// Default `-a`: the harnesses detected on this machine, then `config.agents`, then the remembered
// last selection, then a prompt when the console can ask. A harness without a target at the
// destination's scope is dropped: with a warning when its id was named, detected or config-listed,
// silently under `--all` or `-a '*'`, and the prompt never offers it. Null means the user
// cancelled the prompt, which ends the run like a declined confirmation.
async function chooseHarnesses(
  request: AddRequest,
  ctx: CommandContext,
  console: Console,
): Promise<HarnessChoice | null> {
  const { io, config } = ctx;
  const scope = scopeOf(request.destination);
  const hasTarget = (def: HarnessDefinition): boolean =>
    request.destination.scope === "out" || def.targets[scope] !== null;
  // An id this machine has no definition for (a user-declared harness from a manifest) stays in
  // intent, where sync notices and skips it, rather than being dropped from what was asked.
  const withTarget = (ids: readonly HarnessId[], warnings: string[]): HarnessId[] =>
    ids.filter((id) => {
      const def = io.harnesses.find((candidate) => candidate.id === id);
      if (def === undefined) {
        warnings.push(notDefinedHere(id));
        return true;
      }
      if (hasTarget(def)) return true;
      warnings.push(noTargetAtScope(id, scope));
      return false;
    });
  const warnings: string[] = [];
  if (request.agents.kind === "ids") {
    return { ids: withTarget(request.agents.ids, warnings), warnings, remember: false };
  }
  if (request.agents.kind === "all") {
    return { ids: io.harnesses.filter(hasTarget).map((def) => def.id), warnings, remember: false };
  }
  const detected = detectedHarnesses(io);
  if (detected.length > 0)
    return { ids: withTarget(detected, warnings), warnings, remember: false };
  if (config.agents !== undefined && config.agents.length > 0) {
    return { ids: withTarget(config.agents, warnings), warnings, remember: false };
  }
  const ctxHarness = harnessContext(io);
  const options = io.harnesses.filter(hasTarget).map((def) => ({
    value: def.id,
    label: def.displayName,
    hint: tildify(
      targetPath(def, request.destination, ctxHarness, sourceSlug(request.from)) ?? "",
      io.userHome,
    ),
  }));
  const remembered = config.lastAgents ?? [];
  const answer = await console.multiselect(STRINGS.whichAgents, options, remembered);
  if (answer.kind === "cancelled") return null;
  const chosen =
    answer.kind === "silent"
      ? remembered
      : answer.values.flatMap((id) => io.harnesses.filter((d) => d.id === id).map((d) => d.id));
  if (chosen.length === 0) {
    throw usage("no harness detected on this machine", { hint: "pass -a <id> (or -a '*')" });
  }
  return { ids: withTarget(chosen, warnings), warnings, remember: answer.kind === "chosen" };
}

// One line per destination: two harnesses reading one file or folder are one place the memories go.
function planBody(request: AddRequest, ids: readonly HarnessId[], io: CliIo): string {
  const ctx = harnessContext(io);
  const slug = sourceSlug(request.from);
  const lines = ids.map((id) => {
    const def = io.harnesses.find((candidate) => candidate.id === id);
    if (def === undefined) return id;
    const destination = request.destination;
    const path =
      destination.scope === "out"
        ? destination.path
        : request.rule
          ? targetPath(def, destination, ctx, slug)
          : (def.bodiesDir(destination.scope, ctx) ?? targetPath(def, destination, ctx, slug));
    return `${sourceTitle(request.from)} -> ${tildify(path ?? "(no target)", io.userHome)}`;
  });
  return [...new Set(lines)].join("\n");
}

// `Vivswan/skills` reads as `Vivswan Skills` on the plan screen, as `skills` titles a source.
export function sourceTitle(from: SourceFrom): string {
  const raw =
    from.type === "github"
      ? from.repo.split("/")
      : from.type === "git"
        ? [
            from.url
              .replace(/\.git$/, "")
              .split(/[/:]/)
              .pop() ?? from.url,
          ]
        : [basename(from.path)];
  return raw
    .flatMap((part) => part.split(/[-_]+/))
    .filter((word) => word !== "")
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(" ");
}

// The plan screen lists EVERY incoming one-liner in plain mode and under --verbose: it is the
// review gate for what will sit in the agent's context, so a fold is allowed only on a TTY where
// the user can rerun with --verbose.
function showItems(
  console: Console,
  chosen: readonly Memory[],
  rename: RenameMap,
  verbose: boolean,
): void {
  const items = [...chosen].sort((a, b) =>
    renamed(rename, a.name) < renamed(rename, b.name) ? -1 : 1,
  );
  const fold = console.mode.tty && !verbose && items.length > 1;
  const shown = fold ? items.slice(0, 1) : items;
  for (const memory of shown) console.item(renamed(rename, memory.name), memory.description);
  if (fold) console.more(items.length - shown.length);
}

function renamed(rename: RenameMap, name: MemoryName): MemoryName {
  return Object.hasOwn(rename, name) ? rename[name] : name;
}

function sameSelect(a: Select, b: Select): boolean {
  if (a === "*" || b === "*") return a === b;
  return a.length === b.length && a.every((name, index) => name === b[index]);
}

function showSelect(select: Select): string {
  return select === "*" ? "*" : select.join(", ");
}

// Three entry shapes, one per source variant: a remote source records the sha its remote
// reported, a copied local directory records a content hash of its tree, and a live directory
// records no fetch at all. Each hash is parsed into its brand here, at the one place a resolver's
// answer becomes state.
function buildEntry(
  request: AddRequest,
  rename: RenameMap,
  harnesses: HarnessId[],
  tree: FetchedFiles,
  memories: readonly Memory[],
  now: string,
  state: State,
): SourceEntry {
  const addedAt = state.sources[request.key]?.addedAt ?? now;
  const base = {
    select: request.select,
    rename,
    rule: request.rule,
    destination: request.destination,
    copy: request.copy,
    auth: request.auth,
    harnesses,
    memoryPath: request.memoryPath,
    fullDepth: request.fullDepth,
    ...(request.paths === undefined ? {} : { paths: request.paths }),
    ...(request.allowHidden ? { allowHidden: true } : {}),
    ...(request.shared ? { shared: true as const } : {}),
    ...(request.review ? { review: true as const } : {}),
  };
  const from = request.from;
  const fetchedMemories = Object.fromEntries(
    memories.map((memory) => [
      memory.name,
      { content: contentHashOf(memory.raw), description: contentHashOf(memory.description) },
    ]),
  );
  if (from.type === "local") {
    if (from.live === true) return { intent: { from, ...base }, addedAt };
    const sha = parseContentHash(tree.sha);
    if (sha === null) throw badSha(request.key, tree.sha, "a sha256 content hash");
    const fetched = {
      at: now,
      sha,
      memoryPath: tree.memoryPath,
      memories: fetchedMemories,
      lastError: null,
    };
    return { intent: { from: { type: "local", path: from.path }, ...base }, fetched, addedAt };
  }
  const sha = parseGitSha(tree.sha);
  if (sha === null) throw badSha(request.key, tree.sha, "a 40-character commit sha");
  const fetched = {
    at: now,
    sha,
    memoryPath: tree.memoryPath,
    memories: fetchedMemories,
    lastError: null,
  };
  return { intent: { from, ...base }, fetched, addedAt };
}

function badSha(key: string, reported: string, expected: string): MaximsError {
  return new MaximsError(
    ExitCode.SourceUnresolvable,
    `${key}: the resolver reported "${reported}" where ${expected} was expected`,
  );
}
