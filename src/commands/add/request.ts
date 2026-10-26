import { STRINGS } from "../../console/strings.ts";
import { GitRefSchema, isLiveLocal, type SourceFrom } from "../../contracts/source.ts";
import { insideProject } from "../../engine/project-lock-read.ts";
import type { CliIo } from "../../engine/types.ts";
import type { MemoryName } from "../../memory/contract.ts";
import { DEFAULT_RULE_CAP } from "../../rulefile/budget.ts";
import type { UserConfig } from "../../state/config.ts";
import {
  canonicalSourceKey,
  type Destination,
  type RenameMap,
  type Select,
} from "../../state/schema.ts";
import { flattenIssues } from "../../util/zod-issues.ts";
import { cooldownCapConfig } from "../frame/cli-context.ts";
import { knownHarnessIds, realLocal } from "../frame/lookup.ts";
import {
  type AgentSelection,
  type Args,
  type CommandContext,
  FLAGS,
  INTENT_DEFAULTS,
  parseAgents,
  parseDestination,
  parseRenames,
  parseSelect,
  usage,
} from "../frame/options.ts";
import { listedInLock } from "../frame/project-lock-io.ts";
import { parseSourceSelector, storable } from "../frame/source-argument.ts";

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

// A live source registers no hook: a refresh would clobber an unpushed edit, so the wish is
// dropped for that variant however it was expressed. An `-o` folder is no harness's scope, so it
// has no hook list to record the wish in.
export function hookWanted(from: SourceFrom, destination: Destination, wanted: boolean): boolean {
  if (destination.scope === "out") return false;
  return wanted && !isLiveLocal(from);
}

type FromFlags = { pin: string | undefined; link: boolean; review: boolean };

function resolveFrom(from: SourceFrom, flags: FromFlags, sourceArg: string): SourceFrom {
  if (from.type !== "local") {
    if (flags.link) throw usage("--link applies to a local directory");
    // Only the ref that survives to storage is judged: a `/tree/<ref>` the state schema refuses is
    // a fine spelling when `--pin` replaces it.
    const ref =
      flags.pin === undefined
        ? storable(GitRefSchema, from.ref, sourceArg)
        : gitRefOrUsage(flags.pin);
    return { ...from, ref };
  }
  if (flags.pin !== undefined) {
    throw usage("--pin applies to a GitHub or git source, not a directory");
  }
  // The real path is the identity: state, the store entry and the project manifest then agree
  // on one location whether the user typed the directory or a symlink to it.
  const path = realLocal(from).path;
  const live = flags.link || from.live === true;
  const resolved: SourceFrom = live ? { type: "local", path, live: true } : { type: "local", path };
  // A live directory is read in place at every sync, so there is no fetch to hold back.
  if (flags.review && isLiveLocal(resolved)) {
    throw usage("--review applies to a fetched source; a live directory is read in place");
  }
  return resolved;
}

// Without -g, -p or -o, a fetched source lands at the project the command runs in and a directory
// at the user scope.
function addDestination(args: Args, io: CliIo, from: SourceFrom): Destination {
  const explicit = parseDestination(args, io.cwd, io.projectRoot);
  if (explicit !== null) return explicit;
  if (io.projectRoot !== null && from.type !== "local") {
    return { scope: "project", root: io.projectRoot };
  }
  return { scope: "global" };
}

// A source the team's lock lists stays the team's: the mark is inherited, as `install` sets it.
// A `--list` takes nothing over, so it reads no lock.
async function sharedMark(
  args: Args,
  destination: Destination,
  from: SourceFrom,
  list: boolean,
): Promise<boolean> {
  if (destination.scope !== "project") return false;
  const shared = args.flag(FLAGS.share) || (!list && (await listedInLock(destination.root, from)));
  if (shared) assertShareable(from, destination.root);
  return shared;
}

// `@owner/repo@name` adds that one memory to the selection; `--all` contradicts it.
function addSelect(args: Args, memory: MemoryName | null): Select {
  const explicit = parseSelect(args);
  if (memory === null) return explicit ?? "*";
  if (args.flag(FLAGS.all)) throw usage(STRINGS.allWithNames);
  if (explicit === null || explicit === "*") return [memory];
  return [...new Set([...explicit, memory])];
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
  const review = args.flag(FLAGS.review);
  const flags: FromFlags = { pin: args.value(FLAGS.pin), link: args.flag(FLAGS.link), review };
  const from = resolveFrom(selector.from, flags, sourceArg);
  const destination = addDestination(args, io, from);
  if (args.flag(FLAGS.share) && destination.scope !== "project") {
    throw usage("--share applies to a project install; drop -g or -o", {
      hint: "the project lock holds project-scope sources only",
    });
  }
  const shared = await sharedMark(args, destination, from, list);
  const select = addSelect(args, selector.memory);
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

// A local source outside the checkout has no path a teammate's checkout can follow.
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
