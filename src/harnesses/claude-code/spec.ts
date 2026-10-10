import { toDefinition } from "../from-spec.ts";
import type { HarnessSpec } from "../spec.ts";

// A `.claude/rules` file loads at launch with no frontmatter, so only a path-scoped install carries
// a preamble. `disableAllHooks` is read after settings precedence applies; managed settings and
// `--settings` outrank every file here and are not read.
export const spec = {
  id: "claude-code",
  displayName: "Claude Code",
  tier: 1,
  verifiedAgainst: {
    date: "2026-10-10",
    sources: [
      {
        kind: "schema",
        url: "https://www.schemastore.org/claude-code-settings.json",
        paths: [
          "/properties/hooks/properties/SessionStart",
          "/$defs/hookCommand",
          "/properties/disableAllHooks",
        ],
        note: "SessionStart hook fields and disableAllHooks, in the community-maintained settings schema on SchemaStore",
      },
      {
        kind: "page",
        url: "https://code.claude.com/docs/en/memory.md",
        claims: [
          "`.claude/rules/`",
          "`~/.claude/rules/`",
          "paths:",
          "Claude Code loads a CLAUDE.md file of up to 4 MiB in full and skips a larger file.",
          "@path/to/import",
        ],
        why: "Claude Code is closed source and the SchemaStore schema covers settings keys, not the rules directories; this is the page's markdown rendition",
        note: "the rules directories, the paths frontmatter, the 4 MiB cap and @imports",
      },
      {
        kind: "page",
        url: "https://code.claude.com/docs/en/hooks.md",
        claims: [
          "SessionStart",
          "hook_event_name",
          "disableAllHooks",
          "statusMessage",
          "`.claude/settings.json`",
          "`~/.claude/settings.json`",
        ],
        why: "Claude Code is closed source and the hook's stdin and stdout fields are stated only on the page; this is its markdown rendition",
        note: "SessionStart hook fields and disableAllHooks after settings precedence",
      },
      {
        kind: "page",
        url: "https://code.claude.com/docs/en/settings.md",
        claims: [
          "Fix a broken settings file",
          "Claude Code skips the broken file or values and continues with the rest",
          "Settings files are strict JSON: a `//` comment or a trailing comma is a syntax error",
        ],
        why: "Claude Code is closed source and what it does with a settings file it cannot parse is stated only on the page; this is its markdown rendition",
        note: "a broken settings file, a comment or a trailing comma included, is skipped and the other layers stay in effect",
      },
    ],
  },
  targets: {
    project: { kind: "rules-dir", dir: ".claude/rules", fileName: "maxims-{{slug}}.md" },
    global: { kind: "rules-dir", dir: ".claude/rules", fileName: "maxims-{{slug}}.md" },
  },
  bodiesDir: { project: ".agents/memories", global: null },
  markers: "stripped",
  expands: ["at-import"],
  byteBudget: 4 * 1024 * 1024,
  detect: { dirs: [".claude"], env: ["CLAUDECODE", "CLAUDE_CODE_ENTRYPOINT"] },
  hook: {
    kind: "registry",
    path: { project: ".claude/settings.json", global: ".claude/settings.json" },
    format: "json",
    eventPath: ["hooks", "SessionStart"],
    grouped: true,
    handlerTemplate: {
      type: "command",
      command: "{{command}}",
      async: "{{async}}",
      timeout: "{{timeoutSeconds}}",
      statusMessage: "Syncing maxims",
    },
    commandKey: "command",
    stdout: "plain",
    async: true,
    tierCheck: {
      layers: {
        project: [".claude/settings.local.json", ".claude/settings.json"],
        global: [".claude/settings.json"],
      },
      format: "json",
      key: "disableAllHooks",
      demotesWhen: true,
      unreadable: "skips-the-file",
    },
  },
  scopeFrontmatter: { fields: {}, pathsKey: "paths", pathsAs: "list" },
  fixtures: { config: "settings.json", hookStdin: "hook-stdin.json" },
} satisfies HarnessSpec;

export const claudeCode = toDefinition(spec);
