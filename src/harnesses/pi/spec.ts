import { contentHashLiteral } from "../../memory/contract.ts";
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
    pages: [
      {
        url: "https://raw.githubusercontent.com/earendil-works/pi/refs/heads/main/packages/coding-agent/docs/extensions.md",
        contentHash: contentHashLiteral(
          "sha256:37064e6b9f44d2aa699dfc5ca3cfcfc2ba76de63d231abad8fdffeeec0ce78b1",
        ),
      },
      {
        url: "https://raw.githubusercontent.com/earendil-works/pi/refs/heads/main/packages/coding-agent/docs/configuration.md",
        contentHash: contentHashLiteral(
          "sha256:e75ac4732847833b53b9a2e9223443e460df42b3da035a9f1071f8ab1f9b33f2",
        ),
        note: "PI_CODING_AGENT_DIR, AGENTS.override.md and the extensions directories",
      },
      {
        url: "https://raw.githubusercontent.com/earendil-works/pi/refs/heads/main/packages/coding-agent/src/core/resource-loader.ts",
        contentHash: contentHashLiteral(
          "sha256:194fac4a6276180ed109f3ca77f40abbb25acd4a28ae55ba98232cfde6ad69db",
        ),
        note: "context-file order",
      },
      {
        url: "https://raw.githubusercontent.com/earendil-works/pi/refs/heads/main/packages/coding-agent/src/core/exec.ts",
        contentHash: contentHashLiteral(
          "sha256:ecc0ba197ae2a9f1f2dcea9c7ccf9bff46b319eb70c1200e06d0c95540737a36",
        ),
        note: "pi.exec takes an argv with no shell and a timeout in milliseconds",
      },
      {
        url: "https://raw.githubusercontent.com/earendil-works/pi/refs/heads/main/packages/coding-agent/docs/mcp.md",
        contentHash: contentHashLiteral(
          "sha256:981d9cad82507437b0d873c2d854b841f2dfa0c01596f8abaf79f92068a278c5",
        ),
        note: "mcpServers in ~/.pi/agent/mcp.json and .pi/mcp.json, connected at session start",
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
