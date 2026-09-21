import type { Readable } from "node:stream";
import type { Sink } from "../console/contract.ts";
import type { HarnessId } from "../contracts/harness-id.ts";
import type { LastError } from "../contracts/last-error.ts";
import type {
  AchievedTier,
  HarnessContext,
  HarnessDefinition,
  Scope,
} from "../harnesses/contract.ts";
import type { HookPlan } from "../harnesses/hook-writer.ts";
import type { MemoryName } from "../memory/contract.ts";
import type { ResolverFor } from "../sources/contract.ts";
import type { UserConfig } from "../state/config.ts";
import type { Pending, SourceEntry, State } from "../state/schema.ts";
import type { Change, Plan } from "../util/change.ts";

export type CommonOptions = {
  quiet: boolean;
  dryRun: boolean;
  json: boolean;
};

// What a verb would have written had this not been a dry run: the state and config to plan
// against instead of the files, and the writes whose content the engine reads as if they had
// landed (a store entry's files stand in for the copy on disk).
export type SyncPreview = {
  state: State;
  config: UserConfig;
  changes: Change[];
};

// The harnesses a run is restricted to. Absent means every harness; the list is never empty, so
// "restrict to nothing" has no spelling and a verb whose chosen list came out empty syncs all.
export type HarnessFilter = readonly [HarnessId, ...HarnessId[]];

// Whether this run may ask a source's remote: `due` refreshes what the cooldown says is due,
// `force` refreshes every fetched source (`update`), `none` never opens a socket. A `due` run
// limited to some harnesses fetches nothing, since a refresh reaches every harness's rule file;
// a forced run fetches whatever the filter, and a source it refreshed is then written for every
// harness, so no rule file outside the filter points at a body the store swap removed.
export type FetchIntent = "due" | "force" | "none";

// `only` limits the refresh to the named source keys; every other source is left as it is.
// `preview` is set only under `dryRun`, by a verb that would have written something first.
// `retired` are the entries the caller replaced under another destination: their old `-o`
// folders are swept and their bodies told from the user's own files, as after a removal.
export type SyncOptions = CommonOptions & {
  fetch: FetchIntent;
  agents?: HarnessFilter;
  only?: string[];
  preview?: SyncPreview;
  retired?: SourceEntry[];
};

// `failed` lists the sources this run could not bring current, in key order: a refresh that
// failed, or a live source whose directory could not be read (its read is its refresh). Each
// carries the failure's class so a caller tells an unreachable source from one with nothing valid
// to install, from the report rather than from state, which a dry run leaves unchanged.
// `upstreamChanges` holds, per refreshed or held key, the memories the revision adds (`+ name`),
// removes (`- name`) or changes (`~ name (old -> new)`). `held` lists the reviewed sources with a
// revision held for review at the end of this run, made now or earlier, in key order; they are
// not in `fetched`. `changed` lists the paths this run wrote, deleted or relinked, never one a
// planned change found already in its final state; under `--dry-run` it lists every path the
// plan names.
export type SyncReport = {
  sources: number;
  memories: number;
  rules: number;
  tokens: number;
  fetched: string[];
  held: string[];
  // Shared files this run left as they were because a removal in them would pair stray markers.
  heldFiles: string[];
  // Sources whose stale line this run rendered; the run is not up to date while one stands.
  stale: string[];
  upstreamChanges: Record<string, string[]>;
  failed: { key: string; message: string; kind: LastError["kind"] }[];
  changed: string[];
  notices: string[];
  plan: Plan;
};

// A removal target as typed: a source key or a bare memory name in one string, or one memory of
// one source, spelled apart so a memory can never be read as a source that happens to share its
// spelling.
export type RemoveTargetSpec = string | { source: string; memory: MemoryName };

// `agents` turns the removal into dropping those harnesses from each named source instead of the
// source itself. `confirmed` is `-y` or `--all`; without it a removal that would change anything
// is refused.
export type RemoveOptions = CommonOptions & {
  targets: RemoveTargetSpec[];
  all: boolean;
  agents?: HarnessFilter;
  confirmed: boolean;
};

export type ListOptions = CommonOptions;

export type SymlinkSupport = { ok: true } | { ok: false; reason: string };

// Everything the engine takes from the process, so a test can run it against fixture resolvers
// and definitions in a temp home. `readStdin` yields the hook payload text, or null when stdin is
// a terminal or nothing arrives in time; `symlinkSupport` is probed once per run before bodies
// are linked, and a negative answer turns every link into a copy.
export type EngineIo = {
  stdout: (text: string) => void;
  stderr: (text: string) => void;
  resolvers: ResolverFor;
  harnesses: readonly HarnessDefinition[];
  now: () => Date;
  env: Record<string, string | undefined>;
  cwd: string;
  readStdin: () => Promise<string | null>;
  symlinkSupport: () => Promise<SymlinkSupport>;
};

export type ListedMemory = {
  upstreamName: string;
  localName: string;
  shortHash: string | null;
  disabled: boolean;
};

export type ListedHarness = {
  id: HarnessId;
  tier: 1 | 2;
  tierNote: string | null;
  hook: "ok" | "absent" | "not-wanted";
  rulesFile: string | null;
  rulesPresent: boolean;
  skipped: string | null;
};

export type ListedRename = {
  upstreamName: string;
  localName: string;
  verdict: "resolves" | "unneeded";
  against: string | null;
};

// `project` is set for a project-scope entry: the root it was added in, whether that is the
// project this run is in (`here`), and whether the folder still exists at all; `shared` says the
// entry is in that project's lock. `review` says upstream changes wait for `accept`, and `held`
// is the revision waiting right now, if any.
export type ListedSource = {
  key: string;
  scope: "project" | "global" | "out";
  project: { root: string; here: boolean; rootMissing: boolean } | null;
  shared: boolean;
  review: boolean;
  held: Pending | null;
  live: boolean;
  outDir: string | null;
  sha: string | null;
  fetchedAt: string | null;
  lastError: LastError | null;
  stale: { since: string; kind: LastError["kind"] | "age"; days: number } | null;
  memories: ListedMemory[];
  harnesses: ListedHarness[];
  renames: ListedRename[];
  rule: boolean;
  tokens: { path: string; tokens: number }[];
};

export type ListReport = {
  sources: ListedSource[];
  lockOnly: string[];
  defaults: { agents: HarnessId[] | null; rule: boolean; cooldownDays: number; ruleCap: number };
  notices: string[];
};

// Everything a command reads from the machine, injected once so a test can run the whole CLI
// against a temp home and captured streams without touching the real ones.
export type MachineIo = {
  env: Record<string, string | undefined>;
  cwd: string;
  home: string;
  userHome: string;
  projectRoot: string | null;
  now: () => Date;
  stdin: Readable;
  stdout: Sink;
  stderr: Sink;
};

// The machine plus the two registries a verb dispatches on: the harness definitions and the
// source resolvers, fixtures in a test and the real ones in the bin. The engine's own `EngineIo`
// is derived from this in one place, `engineIo`.
export type CliIo = MachineIo & {
  harnesses: readonly HarnessDefinition[];
  resolvers: ResolverFor;
};

export type EngineBundle = {
  engine: Engine;
  harnesses: readonly HarnessDefinition[];
  resolvers: ResolverFor;
};

// What `remove` is asked to take out of intent, parsed once so the shape cannot hold what the
// engine refuses: a harness drop applies to a whole source, never to a memory or a narrowed
// selection.
export type RemoveTarget =
  | { kind: "all"; agents: HarnessId[] | null }
  | { kind: "source"; key: string; agents: HarnessId[] | null }
  | { kind: "memories"; source: string; names: MemoryName[] };

// The stub speaks its protocol on `output`; the sync it starts writes nowhere a client reads.
export type McpStubOptions = {
  runSync: () => Promise<unknown>;
  input: Readable;
  output: Sink;
  stderr: Sink;
};

// The engine as the command line sees it, loaded only once a verb runs. The three runners are the
// engine's verbs; `planHookAlone` and `achievedTier` are what `doctor` and `list` compare disk
// against; `serveMcpStub` is the hidden `mcp-serve` verb's body. Everything else a verb derives
// (a store entry's changes, the dedupe walk, a rule file's blocks) is a module function.
export type Engine = {
  runSync(options: SyncOptions, io: EngineIo): Promise<SyncReport>;
  runRemove(options: RemoveOptions, io: EngineIo): Promise<SyncReport>;
  runList(options: ListOptions, io: EngineIo): Promise<ListReport>;
  planHookAlone(
    def: HarnessDefinition,
    scope: Scope,
    ctx: HarnessContext,
    wanted: boolean,
  ): Promise<HookPlan>;
  achievedTier(def: HarnessDefinition, scope: Scope, ctx: HarnessContext): Promise<AchievedTier>;
  serveMcpStub(options: McpStubOptions): Promise<void>;
};
