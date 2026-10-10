import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { HarnessId } from "../contracts/harness-id.ts";
import type { ExpansionSyntax, Markers } from "../rulefile/types.ts";
import type { Change } from "../util/change.ts";
import { ExitCode, MaximsError } from "../util/exit-codes.ts";
import { PACKAGE_ARGV } from "../util/package.ts";
import { statOrAbsent } from "./detect.ts";

export type Scope = "project" | "global";

export type HarnessContext = {
  home: string;
  projectRoot: string | null;
  // The directory the session runs in: a hook's start directory, else the process cwd. A harness
  // that layers its config per directory reads from `projectRoot` down to it.
  cwd: string;
  env: Record<string, string | undefined>;
};

// What a tier probe read on this machine. A config the probe could not read is not one that
// leaves hooks on: the harness is taken at tier 2 and `unreadable` says why, with no harness
// named in it, so the surface that prints it (a sync notice, a doctor finding, a list note) can
// put the harness where its own layout wants it.
export type AchievedTier = { tier: 1 | 2; unreadable: null } | { tier: 2; unreadable: string };

// Strategy A writes one whole file per source into a rules directory; strategy B writes a managed
// block into a file the user also owns. A harness only chooses; the two writers exist once.
// `dir` and `file` are RELATIVE to the scope root from `scopeRoot`; `HookShape.path`,
// `bodiesDir` and `tierCheck.layers` return ABSOLUTE paths.
// `precedence` lists, in the harness's own order, the files of which it reads only the first
// that exists (Zed reads `.rules` and ignores `AGENTS.md` beside it); `file` is the one created
// when none exists and must appear in the list. `skipsEmpty` marks a harness that passes over a
// file in that list whose trimmed content is empty (Codex's home loader), so the block never fills
// a blank file whose filling would silence the next one. `sharedBlockFile` is the one resolver.
export type Target =
  | {
      kind: "rules-dir";
      dir: string;
      fileName: (sourceSlug: SourceSlug) => string;
      frontmatter?: (opts: { paths?: string[] }) => string;
    }
  | { kind: "shared-block"; file: string; precedence?: string[]; skipsEmpty?: true };

export type SharedBlockTarget = Extract<Target, { kind: "shared-block" }>;

declare const sourceSlugBrand: unique symbol;

// The file-name form of a source, built by `sourceSlug` in src/commands/shared/slug.ts and parsed
// here before it is trusted: one path segment with nothing a path builder could misread, so a
// rules-dir file name made from it and a template the spec admits is one segment by construction.
export type SourceSlug = string & { readonly [sourceSlugBrand]: true };

export const SOURCE_SLUG_PATTERN = /^[a-z0-9-]+$/;

export function parseSourceSlug(candidate: string): SourceSlug | null {
  return SOURCE_SLUG_PATTERN.test(candidate) ? (candidate as SourceSlug) : null;
}

// Blank as Codex judges it: Rust's `str::trim` strips the Unicode White_Space set, which differs
// from JavaScript's `trim` on two characters. A byte order mark (U+FEFF) is whitespace only to
// JavaScript, so a BOM-only file is a file Codex reads; U+0085 is whitespace only to Rust.
const WHITE_SPACE_ONLY = /^\p{White_Space}*$/u;

// A directory named in the list (Cline's `.clinerules/`) holds no block and is skipped.
export function sharedBlockFile(target: SharedBlockTarget, root: string): string {
  for (const name of target.precedence ?? []) {
    const path = join(root, name);
    if (!statOrAbsent(path)?.isFile()) continue;
    if (target.skipsEmpty === undefined || !WHITE_SPACE_ONLY.test(readFileSync(path, "utf8")))
      return name;
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

// What one config layer says about a tier check's key. `absent` and `unset` defer to the next
// layer; `value` is the key as the harness would read it, of `demotesWhen`'s own JSON type; and
// `unreadable` covers a file that cannot be read or parsed as well as a key path or value of
// another type, because what the harness makes of a config its own schema rejects is not for
// another layer to answer.
export type ConfigLayer =
  | { kind: "absent" }
  | { kind: "unset" }
  | { kind: "value"; value: unknown }
  | { kind: "unreadable"; reason: string };

// What the harness does with a config layer it cannot parse or its schema rejects. One that skips
// the file keeps its other layers in effect, so only the file the hook is registered in bears on
// the tier; one that refuses to start runs no hook from any layer.
export type UnreadableLayer = "skips-the-file" | "refuses-to-start";

// A registry hook is declared, never special-cased: `eventPath`, `grouped`, `wrapper`, `handler`
// and `commandKey` carry every difference between the harnesses' registry files, so the one hook
// writer needs no per-harness branch. `tierCheck` is read-only detection over the harness's own
// config layers, `layers` giving them in the harness's precedence order (project over global, a
// local override before the file it overrides): the first that sets the key decides whether it
// holds `demotesWhen`, and `unreadable` says which broken layer is the reading instead. Nothing
// ever writes them.
export type RegistryHook = {
  kind: "registry";
  path: (scope: Scope, ctx: HarnessContext) => string;
  format: "json";
  eventPath: string[];
  grouped: boolean;
  wrapper?: Record<string, unknown>;
  handler: (spec: HookSpec) => Record<string, unknown>;
  commandKey: string;
  stdout: HookStdout;
  async: boolean;
  debounceMs?: number;
  tierCheck?: {
    layers: (ctx: HarnessContext) => string[];
    format: ConfigFormat;
    key: string;
    demotesWhen: unknown;
    unreadable: UnreadableLayer;
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

// The vendor sources the definition's facts were read from, each with the record the nightly
// drift check re-reads: JSON pointers that must resolve in a published schema (to a given
// primitive where one is named), or literal claims that must appear in a repository file or a documentation
// page. A page is the last resort, and `why` says what programmatic source was looked for. One
// source rarely states every fact (Pi's context-file order is in its resource loader, not its
// extensions page), so `note` names the fact each one justifies.
export type PointerCheck = string | { pointer: string; equals: string | number | boolean | null };
export type VerifiedSource =
  | {
      kind: "schema";
      url: string;
      paths: readonly [PointerCheck, ...PointerCheck[]];
      note?: string;
    }
  | {
      kind: "file";
      repo: string;
      ref: string;
      path: string;
      claims: readonly [string, ...string[]];
      note?: string;
    }
  | {
      kind: "page";
      url: string;
      claims: readonly [string, ...string[]];
      why: string;
      note?: string;
    };
export type VerifiedAgainst = {
  date: string;
  sources: readonly [VerifiedSource, ...VerifiedSource[]];
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
  achievedTier?: (ctx: HarnessContext) => Promise<AchievedTier>;
  scopeFrontmatter?: (globs: string[]) => string | null;
  verifiedAgainst: VerifiedAgainst;
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
