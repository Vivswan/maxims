import { contentHashLiteral } from "../../memory/contract.ts";
import type { HarnessSpec } from "../spec.ts";

// Pi loads one context file per directory, from `~/.pi/agent` and from the parents down to the
// working directory: AGENTS.override.md, else AGENTS.md or AGENTS.MD, else CLAUDE.md or CLAUDE.MD,
// so a block written into AGENTS.md beside AGENTS.override.md would never load and creating
// AGENTS.md beside a lone CLAUDE.md would stop Pi reading the user's file. The config directory
// moves with `PI_CODING_AGENT_DIR`. Pi has no hook registry and no MCP: an extension file in its
// extensions directory receives `session_start` and runs the sync through `pi.exec`, which takes
// an argv rather than a shell string and a timeout in milliseconds.
export const spec = {
  id: "pi",
  displayName: "Pi",
  tier: 1,
  verifiedAgainst: {
    date: "2026-09-21",
    pages: [
      {
        url: "https://raw.githubusercontent.com/earendil-works/pi/refs/heads/main/packages/coding-agent/docs/extensions.md",
        contentHash: contentHashLiteral(
          "sha256:ce5720e9742e4fae7fb926aa09ca485caadd7be063b732f998c7b471373d39f8",
        ),
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
} satisfies HarnessSpec;
