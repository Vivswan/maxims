import type { HarnessContext, HarnessDefinition, HarnessId, Scope } from "../harnesses/contract.ts";
import type { ContentHash, MemoryName } from "../memory/contract.ts";
import type { ResolverFor } from "../sources/contract.ts";
import type { UserConfig } from "../state/config.ts";
import type {
  Destination,
  LastError,
  RenameMap,
  Select,
  SourceFrom,
  SourceIntent,
  State,
} from "../state/schema.ts";
import type { Change, Plan } from "../util/change.ts";
import type { ExitCode } from "../util/exit-codes.ts";

export type CommonOptions = {
  quiet: boolean;
  dryRun: boolean;
  json: boolean;
};

// What a verb would have written had this not been a dry run: the state and config to plan
// against instead of the files, and the writes (store entries, manifest, config) whose content
// the engine reads as if they had landed.
export type SyncPreview = {
  state: State;
  config: UserConfig;
  changes: Change[];
};

// The harnesses a run is restricted to. Absent means every harness; the list is never empty, so
// "restrict to nothing" has no spelling.
export type HarnessFilter = readonly [HarnessId, ...HarnessId[]];

export type SyncOptions = CommonOptions & {
  noFetch: boolean;
  agents?: HarnessFilter;
  force: boolean;
};

// `failed` lists the sources this run could not bring current, in key order: a refresh that
// failed, or a live source whose directory could not be read (its read is its refresh). Each
// carries the failure's class so a caller tells an unreachable source from one with nothing valid
// to install, from the report rather than from state, which a dry run leaves unchanged.
export type SyncReport = {
  sources: number;
  memories: number;
  rules: number;
  tokens: number;
  fetched: string[];
  failed: { key: string; message: string; kind: LastError["kind"] }[];
  changed: string[];
  notices: string[];
  plan: Plan;
};

// `targets` are sources or bare memory names as typed; `agents` turns the removal into dropping
// those harnesses from each named source instead of the source itself. `confirmed` is `-y` or
// `--all`; without it a removal that would change anything is refused.
export type RemoveOptions = CommonOptions & {
  targets: string[];
  all: boolean;
  agents?: HarnessFilter;
  confirmed: boolean;
};

// What `remove` is asked to take out of intent. A source key with `memories` narrows that
// source's selection instead of dropping the entry; `agents` drops only those harnesses' artifacts
// and keeps the entry while other harnesses still use it.
export type RemoveTarget =
  | { kind: "all"; agents: HarnessId[] | null }
  | { kind: "source"; key: string; memories: MemoryName[] | null; agents: HarnessId[] | null }
  | {
      kind: "memory";
      source: string;
      name: MemoryName;
      agents: HarnessId[] | null;
      destination: Destination | null;
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

export type ListedSource = {
  key: string;
  scope: "project" | "global" | "out";
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

export type Sink = {
  write(chunk: string): unknown;
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
  stdin: NodeJS.ReadableStream;
  stdout: Sink;
  stderr: Sink;
};

export type EngineBundle = {
  engine: Engine;
  harnesses: readonly HarnessDefinition[];
  resolvers: ResolverFor;
};

export type TreeFile = { relPath: string; text: string };

export type IncomingMemory = {
  name: MemoryName;
  description: string;
  contentHash: ContentHash;
};

export type InstalledSource = {
  key: string;
  addedAt: string;
  intent: Pick<SourceIntent, "select" | "rename">;
  names: readonly MemoryName[];
};

export type ResolveIncomingInput = {
  source: string;
  memories: readonly IncomingMemory[];
  select: Select;
  rename: RenameMap;
  cap: number;
  installed: readonly InstalledSource[];
};

export type ResolveIncomingOutcome =
  | { ok: true; names: MemoryName[] }
  | { ok: false; code: ExitCode.NameCollision; collisions: { name: MemoryName; ownedBy: string }[] }
  | { ok: false; code: ExitCode.RuleCapExceeded; count: number; cap: number; hint: string };

export type HookPlanInput = {
  def: HarnessDefinition;
  scope: Scope;
  ctx: HarnessContext;
  wanted: boolean;
};

export type HookPlan = {
  changes: Change[];
  notice?: string;
};

// `base` is the state to edit instead of the file: a dry run whose earlier edits were never
// written hands the engine the state they would have produced.
export type DisabledEdit = {
  scope: Scope;
  name: MemoryName;
  disabled: boolean;
  dryRun: boolean;
  base?: State;
};

// The engine's answer to a disabled-list edit: whether the list changed, the state as written (or
// as it would be under --dry-run), and the writes that carried it (the state file, a manifest).
export type DisabledOutcome = {
  changed: boolean;
  state: State;
  changes: Change[];
};

// A managed block as the rule-file parser reads it back: the source it belongs to and the local
// names of the rule lines it carries.
export type RuleBlock = {
  source: string;
  names: MemoryName[];
};

export type McpStubOptions = {
  runSync: () => Promise<unknown>;
  input: NodeJS.ReadableStream;
  output: Sink;
  stderr: Sink;
};

// The engine as the command line sees it. Every mutating verb ends in `runSync`; the other members
// are the derivations the verbs need before that call and have no home of their own in the CLI:
// `planStoreEntry` lays a fetched tree (or a live symlink) into the store, `resolveIncoming` is
// the dedupe walk plus the cap check over a source about to be recorded, `planHookWrite` and
// `achievedTier` and `parseRuleFile` are what `doctor` compares disk against, `editDisabled` is
// the one intent field the CLI does not write itself, and `serveMcpStub` is the hidden
// `mcp-serve` verb's body.
export type Engine = {
  runSync(options: SyncOptions, io: EngineIo): Promise<SyncReport>;
  runRemove(options: RemoveOptions, io: EngineIo): Promise<SyncReport>;
  runList(options: ListOptions, io: EngineIo): Promise<ListReport>;
  planStoreEntry(from: SourceFrom, home: string, files: readonly TreeFile[]): Change[];
  resolveIncoming(input: ResolveIncomingInput): ResolveIncomingOutcome;
  planHookWrite(input: HookPlanInput): Promise<HookPlan>;
  achievedTier(def: HarnessDefinition, scope: Scope, ctx: HarnessContext): Promise<1 | 2>;
  parseRuleFile(text: string): RuleBlock[];
  editDisabled(edit: DisabledEdit, io: EngineIo): Promise<DisabledOutcome>;
  serveMcpStub(options: McpStubOptions): Promise<void>;
};
