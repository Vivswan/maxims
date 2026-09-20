import { join } from "node:path";
import { stringify } from "yaml";
import {
  type HarnessContext,
  type HarnessDefinition,
  type HookSpec,
  type Scope,
  scopeRoot,
  type Target,
} from "../contract.ts";
import { configDirExists } from "../detect.ts";

// `.claude/rules/**/*.md` loads at launch with no frontmatter, so the always-on file needs none;
// only a path-scoped install adds the `paths:` preamble.
const rulesDir: Target = {
  kind: "rules-dir",
  dir: join(".claude", "rules"),
  fileName: (sourceSlug) => `maxims-${sourceSlug}.md`,
};

// The whole command line goes in `command`: the registry is searched by that key's prefix, and
// the constant carries no user input, so the shell form costs nothing.
function sessionStartHandler(spec: HookSpec): Record<string, unknown> {
  return {
    type: "command",
    command: [spec.command, ...spec.args].join(" "),
    async: spec.async,
    timeout: spec.timeoutSeconds,
    statusMessage: "Syncing maxims",
  };
}

// One settings file per scope carries both the hook and `disableAllHooks`, the switch that
// silences every hook, ours included, and so demotes to tier 2.
function settingsPath(scope: Scope, ctx: HarnessContext): string {
  return join(scopeRoot(claudeCode, scope, ctx), ".claude", "settings.json");
}

export const claudeCode: HarnessDefinition = {
  id: "claude-code",
  displayName: "Claude Code",
  tier: 1,
  targets: { project: rulesDir, global: rulesDir },
  bodiesDir: (scope, ctx) =>
    scope === "project" && ctx.projectRoot !== null
      ? join(ctx.projectRoot, ".agents", "memories")
      : null,
  hook: {
    kind: "registry",
    path: settingsPath,
    format: "json",
    eventPath: ["hooks", "SessionStart"],
    grouped: true,
    handler: sessionStartHandler,
    commandKey: "command",
    stdout: "plain",
    async: true,
    tierCheck: { path: settingsPath, format: "json", key: "disableAllHooks", demotesWhen: true },
  },
  markers: "stripped",
  expands: ["at-import"],
  byteBudget: 4 * 1024 * 1024,
  detect: (ctx) =>
    ctx.env.CLAUDECODE !== undefined ||
    ctx.env.CLAUDE_CODE_ENTRYPOINT !== undefined ||
    configDirExists(join(ctx.home, ".claude")),
  scopeFrontmatter: (globs) =>
    globs.length === 0 ? null : `---\n${stringify({ paths: globs })}---\n`,
  verifiedAgainst: { url: "https://code.claude.com/docs/en/memory", date: "2026-09-20" },
  fixtures: { config: "settings.json", hookStdin: "hook-stdin.json" },
};
