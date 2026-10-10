import type { HarnessSpec } from "../spec.ts";

// Devin Local is the agent new Devin Desktop (formerly Windsurf) tabs start with, and it shares
// its rule, hook and MCP files with the Devin CLI; the earlier Cascade agent is the `windsurf`
// harness. Hooks go under the `hooks` key of `config.json` in both scopes because the standalone
// `.devin/hooks.v1.json` has no user-level twin. SessionStart takes `timeout` in seconds, has no
// async field, and reads context back only as `hookSpecificOutput.additionalContext`.
export const spec = {
  id: "devin",
  displayName: "Devin Local",
  tier: 1,
  verifiedAgainst: {
    date: "2026-10-07",
    sources: [
      {
        kind: "page",
        url: "https://docs.devin.ai/cli/extensibility/hooks/overview.md",
        claims: [
          "for `UserPromptSubmit`, `SessionStart`, `PostToolUse`",
          '"timeout"',
          "hookSpecificOutput.additionalContext",
          ".devin/config.json",
          "~/.config/devin/config.json",
        ],
        why: "Devin is closed source and publishes no schema; this is the page's markdown rendition",
        note: "SessionStart hook fields",
      },
      {
        kind: "page",
        url: "https://docs.devin.ai/cli/extensibility/rules.md",
        claims: [
          "`AGENTS.md` file at your project root",
          "~/.config/devin/AGENTS.md",
          "AGENTS.local.md",
        ],
        why: "Devin is closed source and publishes no schema; this is the page's markdown rendition",
        note: "AGENTS.md in the project and under ~/.config/devin",
      },
      {
        kind: "page",
        url: "https://docs.devin.ai/cli/reference/configuration/global-vs-local.md",
        claims: [
          ".devin/config.json",
          "~/.config/devin/mcp_config.json",
          ".devin/mcp_config.json",
          '"mcpServers"',
        ],
        why: "Devin is closed source and publishes no schema; this is the page's markdown rendition",
        note: "the project config.json and mcp_config.json per scope",
      },
    ],
  },
  globalRoot: { default: ".config/devin" },
  targets: {
    project: { kind: "shared-block", file: "AGENTS.md" },
    global: { kind: "shared-block", file: "AGENTS.md" },
  },
  bodiesDir: { project: ".agents/memories", global: null },
  markers: "counted",
  expands: [],
  detect: { dirs: ["."] },
  hook: {
    kind: "registry",
    path: { project: ".devin/config.json", global: "config.json" },
    format: "json",
    eventPath: ["hooks", "SessionStart"],
    grouped: true,
    handlerTemplate: { type: "command", command: "{{command}}", timeout: "{{timeoutSeconds}}" },
    commandKey: "command",
    stdout: "json:hookSpecificOutput.additionalContext",
    async: false,
  },
  mcp: {
    path: { project: ".devin/mcp_config.json", global: "mcp_config.json" },
    serversPath: ["mcpServers"],
  },
  fixtures: { config: "config.json", hookStdin: "hook-stdin.json" },
} satisfies HarnessSpec;
