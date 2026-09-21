import { contentHashLiteral } from "../../memory/contract.ts";
import type { HarnessSpec } from "../spec.ts";

// Pi loads `~/.pi/agent/AGENTS.md` and every AGENTS.md from the parents down to the working
// directory, and a directory's `AGENTS.override.md` replaces its AGENTS.md outright. The config
// directory moves with `PI_CODING_AGENT_DIR`. Pi has no hook registry and no MCP: an extension file
// in its extensions directory receives `session_start` and runs the sync through `pi.exec`, which
// takes an argv rather than a shell string and a timeout in milliseconds.
export const spec = {
  id: "pi",
  displayName: "Pi",
  tier: 1,
  verifiedAgainst: {
    url: "https://raw.githubusercontent.com/earendil-works/pi/refs/heads/main/packages/coding-agent/docs/extensions.md",
    date: "2026-09-21",
    contentHash: contentHashLiteral(
      "sha256:c5e45089edb276477447ebeedfe6c3c23bfb4f2c32ccbec4de76bfb51d0eabf8",
    ),
  },
  globalRoot: { default: ".pi/agent", env: { name: "PI_CODING_AGENT_DIR" } },
  targets: {
    project: {
      kind: "shared-block",
      file: "AGENTS.md",
      precedence: ["AGENTS.override.md", "AGENTS.md"],
    },
    global: {
      kind: "shared-block",
      file: "AGENTS.md",
      precedence: ["AGENTS.override.md", "AGENTS.md"],
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
} satisfies HarnessSpec;
