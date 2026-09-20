import type { ExpansionSyntax, Markers } from "../rulefile/types.ts";
import type { Change } from "../util/change.ts";
import { ExitCode, MaximsError } from "../util/exit-codes.ts";

export const HARNESS_IDS = [
  "claude-code",
  "codex",
  "gemini-cli",
  "copilot",
  "cursor",
  "cline",
  "opencode",
  "dsh",
] as const;

export type HarnessId = (typeof HARNESS_IDS)[number];

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
export type Target =
  | {
      kind: "rules-dir";
      dir: string;
      fileName: (sourceSlug: string) => string;
      frontmatter?: (opts: { paths?: string[] }) => string;
    }
  | { kind: "shared-block"; file: string };

export type HookSpec = {
  command: string;
  args: string[];
  async: boolean;
  timeoutSeconds: number;
};

// How a session-start hook may speak back to its harness; the `json:` variants name the key the
// harness reads. Plain stdout becomes context on Claude Code and Codex; Gemini and Copilot accept
// only one JSON object; Cline and Cursor read their own keys. Sync renders the staleness notice
// per this field, so a harness that requires silence never sees stray text.
export type HookStdout =
  | "plain"
  | "json:additionalContext"
  | "json:contextModification"
  | "json:additional_context"
  | "none";

export type ConfigFormat = "json" | "toml";

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
      reconcile: (ctx: HarnessContext, spec: HookSpec, wanted: boolean) => Promise<Change[]>;
    };

// The hook command carries no source string, no filter, and no version pin: intent supplies the
// first two, and the missing pin is what lets a fix reach hooked sessions without a re-add. Every
// registry is searched for the PREFIX so a later flag change still finds the entry it replaces.
const HOOK_PREFIX_ARGV = ["npx", "-y", "maxims", "sync"] as const;
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
  byteBudget?: number;
  detect: (ctx: HarnessContext) => boolean;
  achievedTier?: (ctx: HarnessContext) => Promise<1 | 2>;
  scopeFrontmatter?: (globs: string[]) => string | null;
  verifiedAgainst: { url: string; date: string; contentHash?: string };
  fixtures?: HarnessFixtures;
  globalRoot?: (ctx: HarnessContext) => string;
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
