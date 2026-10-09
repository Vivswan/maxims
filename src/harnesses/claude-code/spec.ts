import { contentHashLiteral } from "../../memory/contract.ts";
import type { HarnessSpec } from "../spec.ts";

// `.claude/rules/**/*.md` loads at launch with no frontmatter, so the always-on file needs none;
// only a path-scoped install adds the `paths:` preamble. `disableAllHooks` silences every hook,
// ours included, and is read after settings precedence applies, so quirks.ts probes the layers
// rather than the one file `tierCheck` names. Claude Code strips HTML comments before injection
// and expands `@path` imports; a rule file may grow to its 4 MiB memory cap.
export const spec = {
  id: "claude-code",
  displayName: "Claude Code",
  tier: 1,
  verifiedAgainst: {
    date: "2026-10-09",
    pages: [
      {
        url: "https://code.claude.com/docs/en/memory",
        contentHash: contentHashLiteral(
          "sha256:8aaf96f66d38bcb008138715ae004932c129dc80a7e61790894cae13a620b3f3",
        ),
      },
      {
        url: "https://code.claude.com/docs/en/hooks",
        contentHash: contentHashLiteral(
          "sha256:c813bc9437054fd41e83dd9d8065230339b2977204ca3868bec4688d3bf6adb7",
        ),
        note: "SessionStart hook fields and disableAllHooks after settings precedence",
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
      path: { project: ".claude/settings.json", global: ".claude/settings.json" },
      format: "json",
      key: "disableAllHooks",
      demotesWhen: true,
    },
  },
  scopeFrontmatter: { fields: {}, pathsKey: "paths", pathsAs: "list" },
  fixtures: { config: "settings.json", hookStdin: "hook-stdin.json" },
} satisfies HarnessSpec;
