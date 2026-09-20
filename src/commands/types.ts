import type { HarnessDefinition, HarnessId } from "../harnesses/contract.ts";
import type { ResolverFor } from "../sources/contract.ts";
import type { LastError } from "../state/schema.ts";
import type { Plan } from "../util/change.ts";

export type CommonOptions = {
  quiet: boolean;
  dryRun: boolean;
  json: boolean;
};

export type SyncOptions = CommonOptions & {
  noFetch: boolean;
  agents?: HarnessId[];
  force: boolean;
};

export type SyncReport = {
  sources: number;
  memories: number;
  rules: number;
  tokens: number;
  fetched: string[];
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
  agents?: HarnessId[];
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
