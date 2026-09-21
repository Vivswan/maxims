import { join } from "node:path";
import {
  type HarnessContext,
  type HarnessDefinition,
  type Scope,
  scopeRoot,
  type VerifiedAgainst,
} from "../../src/harnesses/contract.ts";

// Three hand-written harness shapes the CLI tests run against: a rules-dir harness with both
// scopes and a registry hook, a shared-block harness with its own home override, and a
// project-only rules-dir harness that requires frontmatter and has no hook. Detection reads the
// FIXTURE_DETECT env list so a test names what "this machine" has installed.
function detects(id: string): (ctx: HarnessContext) => boolean {
  return (ctx) => (ctx.env.FIXTURE_DETECT ?? "").split(",").includes(id);
}

const verifiedAgainst: VerifiedAgainst = {
  date: "2026-09-20",
  pages: [{ url: "https://example.com/docs" }],
};

function registryHook(dir: (scope: Scope, ctx: HarnessContext) => string) {
  return {
    kind: "registry" as const,
    path: (scope: Scope, ctx: HarnessContext) => join(dir(scope, ctx), "settings.json"),
    format: "json" as const,
    eventPath: ["hooks", "SessionStart"],
    grouped: true,
    handler: (spec: { command: string; args: string[] }) => ({
      type: "command",
      command: [spec.command, ...spec.args].join(" "),
    }),
    commandKey: "command",
    stdout: "plain" as const,
    async: false,
  };
}

const claudeDir = (scope: Scope, ctx: HarnessContext) => join(scopeRoot({}, scope, ctx), ".claude");

export const fixtureClaudeCode: HarnessDefinition = {
  id: "claude-code",
  displayName: "Claude Code",
  tier: 1,
  targets: {
    global: { kind: "rules-dir", dir: ".claude/rules", fileName: (slug) => `maxims-${slug}.md` },
    project: { kind: "rules-dir", dir: ".claude/rules", fileName: (slug) => `maxims-${slug}.md` },
  },
  bodiesDir: (scope, ctx) => join(scopeRoot({}, scope, ctx), ".agents", "memories"),
  hook: registryHook(claudeDir),
  markers: "stripped",
  expands: ["at-import"],
  detect: detects("claude-code"),
  verifiedAgainst,
};

const codexRoots = {
  globalRoot: (ctx: HarnessContext) => ctx.env.CODEX_HOME ?? join(ctx.home, ".codex"),
};

export const fixtureCodex: HarnessDefinition = {
  id: "codex",
  displayName: "Codex",
  tier: 1,
  targets: {
    global: { kind: "shared-block", file: "AGENTS.md" },
    project: { kind: "shared-block", file: "AGENTS.md" },
  },
  bodiesDir: (scope, ctx) =>
    scope === "project" ? join(scopeRoot(codexRoots, scope, ctx), ".agents", "memories") : null,
  hook: registryHook((scope, ctx) =>
    scope === "global"
      ? scopeRoot(codexRoots, scope, ctx)
      : join(scopeRoot(codexRoots, scope, ctx), ".codex"),
  ),
  markers: "counted",
  expands: [],
  detect: detects("codex"),
  globalRoot: codexRoots.globalRoot,
  verifiedAgainst,
};

// The whole preamble the target declares, fences included, as the real definitions return it.
export const CURSOR_FRONTMATTER = "---\nalwaysApply: true\n---\n";

export const fixtureCursor: HarnessDefinition = {
  id: "cursor",
  displayName: "Cursor",
  tier: 2,
  targets: {
    global: null,
    project: {
      kind: "rules-dir",
      dir: ".cursor/rules",
      fileName: (slug) => `maxims-${slug}.mdc`,
      frontmatter: () => CURSOR_FRONTMATTER,
    },
  },
  bodiesDir: (scope, ctx) =>
    scope === "project" ? join(scopeRoot({}, scope, ctx), ".agents", "memories") : null,
  hook: { kind: "none" },
  markers: "counted",
  expands: [],
  detect: detects("cursor"),
  verifiedAgainst,
};

export const FIXTURE_HARNESSES: readonly HarnessDefinition[] = [
  fixtureClaudeCode,
  fixtureCodex,
  fixtureCursor,
];
