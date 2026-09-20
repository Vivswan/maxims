import { statSync } from "node:fs";
import { join } from "node:path";
import type { ContentHash } from "../memory/contract.ts";
import type { ExpansionSyntax, Markers } from "../rulefile/types.ts";
import type { Change } from "../util/change.ts";
import { ExitCode, MaximsError } from "../util/exit-codes.ts";
import { PACKAGE_ARGV } from "../util/package.ts";

export const HARNESS_IDS = [
  "claude-code",
  "codex",
  "gemini-cli",
  "copilot",
  "cursor",
  "cline",
  "opencode",
  "dsh",
  "devin",
  "windsurf",
  "zed",
  "amp",
  "warp",
  "pi",
] as const;

export type BuiltInHarnessId = (typeof HARNESS_IDS)[number];

export const HARNESS_ID_PATTERN = /^[a-z][a-z0-9]*(-[a-z0-9]+)*$/;

export function isBuiltInHarnessId(value: string): value is BuiltInHarnessId {
  return HARNESS_IDS.some((id) => id === value);
}

declare const userHarnessIdBrand: unique symbol;

// An id outside the built-in list: one declared in `$MAXIMS_HOME/harnesses.json`. State keeps
// such an id as intent even after the file stops defining it; sync notices and skips it rather
// than dropping it. `parseUserHarnessId` is the one place the brand is minted.
export type UserHarnessId = string & { readonly [userHarnessIdBrand]: true };

export type HarnessId = BuiltInHarnessId | UserHarnessId;

export function parseUserHarnessId(value: string): UserHarnessId | null {
  if (!HARNESS_ID_PATTERN.test(value) || isBuiltInHarnessId(value)) return null;
  return value as UserHarnessId;
}

export type Scope = "project" | "global";

export type HarnessContext = {
  home: string;
  projectRoot: string | null;
  env: Record<string, string | undefined>;
};

// Strategy A writes one whole file per source into a rules directory; strategy B writes a managed
// block into a file the user also owns. A harness only chooses; the two writers exist once.
// `dir` and `file` are RELATIVE to the scope root from `scopeRoot`; `HookShape.path`,
// `bodiesDir` and `tierCheck.path` return ABSOLUTE paths.
// `precedence` lists, in the harness's own order, the files of which it reads only the first
// that exists (Zed reads `.rules` and ignores `AGENTS.md` beside it); `file` is the one created
// when none exists and must appear in the list. `sharedBlockFile` is the one resolver.
export type Target =
  | {
      kind: "rules-dir";
      dir: string;
      fileName: (sourceSlug: string) => string;
      frontmatter?: (opts: { paths?: string[] }) => string;
    }
  | { kind: "shared-block"; file: string; precedence?: string[] };

export type SharedBlockTarget = Extract<Target, { kind: "shared-block" }>;

// A directory named in the list (Cline's `.clinerules/`) holds no block and is skipped.
export function sharedBlockFile(target: SharedBlockTarget, root: string): string {
  for (const name of target.precedence ?? []) {
    if (statSync(join(root, name), { throwIfNoEntry: false })?.isFile()) return name;
  }
  return target.file;
}

// The largest file the harness loads, in bytes. Windsurf caps a workspace rule at 12,000
// characters and its `global_rules.md` at 6,000, so a cap may differ per scope; the strategies
// read it only through `byteBudgetFor`.
export type ByteBudget =
  | number
  | { project: number; global?: number }
  | { project?: number; global: number };

export function byteBudgetFor(budget: ByteBudget | undefined, scope: Scope): number | undefined {
  return typeof budget === "number" ? budget : budget?.[scope];
}

export type HookSpec = {
  command: string;
  args: string[];
  async: boolean;
  timeoutSeconds: number;
};

// How a session-start hook may speak back to its harness; the `json:` variants name the path of
// the key the harness reads inside the one JSON object it accepts. Plain stdout becomes context on
// Claude Code and Codex. Two envelopes carry an `additionalContext`: Copilot reads it at the top
// level, `{"additionalContext": "..."}`; Claude Code, Gemini and Devin read it nested under
// `hookSpecificOutput` beside the event name. Cline and Cursor read their own keys. Sync renders
// the staleness notice per this field, so a harness that requires silence never sees stray text.
export type HookStdout =
  | "plain"
  | "json:additionalContext"
  | "json:hookSpecificOutput.additionalContext"
  | "json:contextModification"
  | "json:additional_context"
  | "none";

export type ConfigFormat = "json" | "toml";

// Where a harness keeps its MCP servers, for the bundled stub whose start runs sync: the config
// file per scope and the key path of the servers map inside it. `null` means that scope has no
// file the harness starts servers from.
export type McpRegistry = {
  path: (scope: Scope, ctx: HarnessContext) => string | null;
  serversPath: string[];
};

// A registry hook is declared, never special-cased: `eventPath`, `grouped`, `wrapper`, `handler`
// and `commandKey` carry every difference between the harnesses' registry files, so the one hook
// writer needs no per-harness branch. `tierCheck` is read-only detection: a config value whose
// presence demotes the harness to tier 2; nothing ever writes it.
export type RegistryHook = {
  kind: "registry";
  path: (scope: Scope, ctx: HarnessContext) => string;
  format: ConfigFormat;
  eventPath: string[];
  grouped: boolean;
  wrapper?: Record<string, unknown>;
  handler: (spec: HookSpec) => Record<string, unknown>;
  commandKey: string;
  stdout: HookStdout;
  async: boolean;
  debounceMs?: number;
  tierCheck?: {
    path: (scope: Scope, ctx: HarnessContext) => string;
    format: ConfigFormat;
    key: string;
    demotesWhen: unknown;
  };
};

export type HookShape =
  | { kind: "none" }
  | RegistryHook
  | {
      kind: "file";
      path: (scope: Scope, ctx: HarnessContext) => string;
      render: (spec: HookSpec) => string;
      executable: boolean;
      stdout: HookStdout;
    }
  | {
      kind: "custom";
      reconcile: (
        scope: Scope,
        ctx: HarnessContext,
        spec: HookSpec,
        wanted: boolean,
      ) => Promise<Change[]>;
    };

// The hook command carries no source string, no filter, and no version pin: intent supplies the
// first two, and the missing pin is what lets a fix reach hooked sessions without a re-add. Every
// registry is searched for the PREFIX so a later flag change still finds the entry it replaces.
const HOOK_PREFIX_ARGV = [...PACKAGE_ARGV, "sync"] as const;
const HOOK_ARGV = [...HOOK_PREFIX_ARGV, "--quiet"] as const;
/** @public */
export const HOOK_COMMAND = HOOK_ARGV.join(" ");
/** @public */
export const HOOK_COMMAND_PREFIX = HOOK_PREFIX_ARGV.join(" ");
export const HOOK_TIMEOUT_SECONDS = 20;

// Fixtures live at `src/harnesses/<id>/fixtures/`: `config.*` is a hand-formatted registry that
// must survive our entry byte-identically outside it, `hook-stdin.json` the harness's hook input.
export type HarnessFixtures = {
  config?: string;
  hookStdin?: string;
};

export interface HarnessDefinition {
  id: HarnessId;
  displayName: string;
  tier: 1 | 2;
  targets: Record<Scope, Target | null>;
  bodiesDir: (scope: Scope, ctx: HarnessContext) => string | null;
  hook: HookShape;
  markers: Markers;
  expands: ExpansionSyntax[];
  byteBudget?: ByteBudget;
  detect: (ctx: HarnessContext) => boolean;
  achievedTier?: (ctx: HarnessContext) => Promise<1 | 2>;
  scopeFrontmatter?: (globs: string[]) => string | null;
  verifiedAgainst: { url: string; date: string; contentHash?: ContentHash };
  fixtures?: HarnessFixtures;
  globalRoot?: (ctx: HarnessContext) => string;
  mcp?: McpRegistry;
  // Config edits a rules-dir target needs before the harness reads it (OpenCode's `instructions`
  // array entry), reconciled by sync like a hook: constructed from the spec, compared, written on a
  // difference, removed when `wanted` is false.
  configEdit?: (scope: Scope, ctx: HarnessContext, wanted: boolean) => Promise<Change[]>;
}

// The one place a scope becomes a directory: a harness whose global files honor an environment
// override (`$CODEX_HOME`, `$COPILOT_HOME`) declares `globalRoot`; everyone else gets the home.
export function scopeRoot(
  def: Pick<HarnessDefinition, "globalRoot">,
  scope: Scope,
  ctx: HarnessContext,
): string {
  if (scope === "global") return def.globalRoot?.(ctx) ?? ctx.home;
  if (ctx.projectRoot === null) {
    throw new MaximsError(ExitCode.Usage, "a project-scoped target needs a project root", {
      hint: "run inside a project, or pass -g for the global scope",
    });
  }
  return ctx.projectRoot;
}

/** @public */
export function hookSpecFor(def: Pick<HarnessDefinition, "hook">): HookSpec {
  const [command, ...args] = HOOK_ARGV;
  return {
    command,
    args: [...args],
    async: def.hook.kind === "registry" ? def.hook.async : false,
    timeoutSeconds: HOOK_TIMEOUT_SECONDS,
  };
}
