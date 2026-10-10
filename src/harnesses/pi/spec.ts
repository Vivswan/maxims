import { toDefinition } from "../from-spec.ts";
import type { HarnessSpec } from "../spec.ts";

// Pi loads one context file per directory, from `~/.pi/agent` and from the parents down to the
// working directory: AGENTS.override.md, else AGENTS.md or AGENTS.MD, else CLAUDE.md or CLAUDE.MD,
// so a block written into AGENTS.md beside AGENTS.override.md would never load and creating
// AGENTS.md beside a lone CLAUDE.md would stop Pi reading the user's file. The config directory
// moves with `PI_CODING_AGENT_DIR`. Pi has no hook registry: an extension file in its extensions
// directory receives `session_start` and runs the sync through `pi.exec`, which takes an argv
// rather than a shell string and a timeout in milliseconds. Its MCP servers live under
// `mcpServers` in `mcp.json` beside the extensions; the project file is read once the project is
// trusted, and every enabled server connects when a session starts.
export const spec = {
  id: "pi",
  displayName: "Pi",
  tier: 1,
  verifiedAgainst: {
    date: "2026-10-07",
    sources: [
      {
        kind: "file",
        repo: "earendil-works/pi",
        ref: "main",
        path: "packages/coding-agent/src/core/resource-loader.ts",
        claims: [
          'candidates = ["AGENTS.override.md", "AGENTS.md", "AGENTS.MD", "CLAUDE.md", "CLAUDE.MD"]',
        ],
        note: "context-file order",
      },
      {
        kind: "file",
        repo: "earendil-works/pi",
        ref: "main",
        path: "packages/coding-agent/src/config.ts",
        claims: [
          'APP_NAME: string = piConfigName || "pi"',
          "toUpperCase()}_CODING_AGENT_DIR",
          '".pi"',
          '"agent"',
        ],
        note: "PI_CODING_AGENT_DIR and the ~/.pi/agent root",
      },
      {
        kind: "file",
        repo: "earendil-works/pi",
        ref: "main",
        path: "packages/coding-agent/src/core/extensions/loader.ts",
        claims: [
          'path.join(resolvedAgentDir, "extensions")',
          'path.join(resolvedCwd, CONFIG_DIR_NAME, "extensions")',
        ],
        note: "the extensions directories",
      },
      {
        kind: "file",
        repo: "earendil-works/pi",
        ref: "main",
        path: "packages/coding-agent/src/core/extensions/types.ts",
        claims: ['"session_start"', "exec(command: string, args: string[]"],
        note: "the session_start event and pi.exec's argv",
      },
      {
        kind: "file",
        repo: "earendil-works/pi",
        ref: "main",
        path: "packages/coding-agent/src/core/exec.ts",
        claims: ["shell: false", "Timeout in milliseconds"],
        note: "pi.exec takes an argv with no shell and a timeout in milliseconds",
      },
      {
        kind: "file",
        repo: "earendil-works/pi",
        ref: "main",
        path: "packages/coding-agent/src/extensions/mcp/config.ts",
        claims: ["mcpServers", "mcp.json"],
        note: "mcpServers in ~/.pi/agent/mcp.json and .pi/mcp.json",
      },
      {
        kind: "schema",
        url: "https://raw.githubusercontent.com/earendil-works/pi/main/packages/coding-agent/schemas/settings.schema.json",
        paths: ["/properties/extensions"],
        note: "the extensions setting",
      },
    ],
  },
  globalRoot: { default: ".pi/agent", env: { name: "PI_CODING_AGENT_DIR" } },
  targets: {
    project: {
      kind: "shared-block",
      file: "AGENTS.md",
      precedence: ["AGENTS.override.md", "AGENTS.md", "AGENTS.MD", "CLAUDE.md", "CLAUDE.MD"],
    },
    global: {
      kind: "shared-block",
      file: "AGENTS.md",
      precedence: ["AGENTS.override.md", "AGENTS.md", "AGENTS.MD", "CLAUDE.md", "CLAUDE.MD"],
    },
  },
  bodiesDir: { project: ".agents/memories", global: null },
  markers: "counted",
  expands: [],
  detect: { dirs: ["."] },
  hook: {
    kind: "file",
    path: { project: ".pi/extensions/maxims.ts", global: "extensions/maxims.ts" },
    contentTemplate: [
      "// Written by maxims. It runs the maxims sync whenever a Pi session starts so the rule files",
      "// stay current. maxims rewrites this file on every sync while a source in its state still",
      "// wants a hook for Pi; removing the last such source deletes it.",
      'import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";',
      "",
      "export default function (pi: ExtensionAPI) {",
      '  pi.on("session_start", async () => {',
      "    const [command, ...args] = {{argv}};",
      "    try {",
      "      await pi.exec(command, args, { timeout: {{timeoutMs}} });",
      "    } catch {",
      "      // An offline npx is not an extension error; the rules keep their last synced state.",
      "    }",
      "  });",
      "}",
      "",
    ].join("\n"),
    executable: false,
    stdout: "none",
  },
  mcp: { path: { project: ".pi/mcp.json", global: "mcp.json" }, serversPath: ["mcpServers"] },
} satisfies HarnessSpec;

export const pi = toDefinition(spec);
