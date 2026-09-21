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
    date: "2026-09-21",
    pages: [
      {
        url: "https://docs.devin.ai/cli/extensibility/hooks/overview",
        contentHash: contentHashLiteral(
          "sha256:ddcc12d78830e91999967374782f31b25a4a7c1866aca086225fa6cd8fa612ec",
        ),
      },
      {
        url: "https://docs.devin.ai/cli/extensibility/rules",
        contentHash: contentHashLiteral(
          "sha256:757858529c25c01a178b57794a2baeb38c50d419027fac51e2424e851e5d8226",
        ),
        note: "AGENTS.md in the project and under ~/.config/devin",
      },
      {
        url: "https://docs.devin.ai/cli/reference/configuration/global-vs-local",
        contentHash: contentHashLiteral(
          "sha256:6f412dc6f129072e8c26d01aa22c48e1338f7acb3bd922265757332b849e447f",
        ),
        note: "config.json and mcp_config.json per scope",
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
