import { parseContentHash } from "../../memory/contract.ts";
import type { HarnessSpec } from "../spec.ts";

// `.claude/rules/**/*.md` loads at launch with no frontmatter, so the always-on file needs none;
// only a path-scoped install adds the `paths:` preamble. One settings file per scope carries both
// the hook and `disableAllHooks`, the switch that silences every hook, ours included, and so
// demotes to tier 2. Claude Code strips HTML comments before injection and expands `@path`
// imports; a rule file may grow to its 4 MiB memory cap.
export const spec = {
  id: "claude-code",
  displayName: "Claude Code",
  tier: 1,
  verifiedAgainst: {
    url: "https://code.claude.com/docs/en/memory",
    date: "2026-09-20",
    contentHash:
      parseContentHash("sha256:8b0293c0b433c082cee1712f624b34c32980f7888a1702a56d631ddf9e0b1046") ??
      undefined,
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
