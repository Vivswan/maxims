import { contentHashLiteral } from "../../memory/contract.ts";
import type { HarnessSpec } from "../spec.ts";

// Devin Local is the agent new Devin Desktop (formerly Windsurf) tabs start with, and it shares
// its rule, hook and MCP files with the Devin CLI; the legacy Cascade agent is the `windsurf`
// harness. Hooks go under the `hooks` key of `config.json` in both scopes because the standalone
// `.devin/hooks.v1.json` has no user-level twin. SessionStart takes `timeout` in seconds, has no
// async field, and reads context back only as `hookSpecificOutput.additionalContext`.
export const spec = {
  id: "devin",
  displayName: "Devin Local",
  tier: 1,
  verifiedAgainst: {
    url: "https://docs.devin.ai/cli/extensibility/hooks/overview",
    date: "2026-09-20",
    contentHash: contentHashLiteral(
      "sha256:5f7c187da8dfcfa870f7309a9ab7585356a972dcc890d6e9f2aadecf390f6d1f",
    ),
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
