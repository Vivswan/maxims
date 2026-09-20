import { contentHashLiteral } from "../../memory/contract.ts";
import type { HarnessSpec } from "../spec.ts";

// Amp always includes AGENTS.md from the working directory upward and `~/.config/amp/AGENTS.md`;
// where a directory has no AGENTS.md it includes AGENT.md or CLAUDE.md instead, so creating one
// beside those would stop Amp reading the user's file. Amp expands `@path` mentions inside the
// file. It has no hook registry: a plugin file in its plugins directory receives `session.start`
// and runs the sync through the plugin API's shell. Its docs give `~/.config/amp` for AGENTS.md
// and settings without an XDG override, so the root stays fixed even though the plugins page
// honours `XDG_CONFIG_HOME`.
export const spec = {
  id: "amp",
  displayName: "Amp",
  tier: 1,
  verifiedAgainst: {
    url: "https://ampcode.com/docs/customize/plugins",
    date: "2026-09-20",
    contentHash: contentHashLiteral(
      "sha256:67415871477a22d245a96221fc4d01bfe40526443ad60dd0428a9b1c0dda1491",
    ),
  },
  globalRoot: { default: ".config/amp" },
  targets: {
    project: {
      kind: "shared-block",
      file: "AGENTS.md",
      precedence: ["AGENTS.md", "AGENT.md", "CLAUDE.md"],
    },
    global: { kind: "shared-block", file: "AGENTS.md" },
  },
  bodiesDir: { project: ".agents/memories", global: null },
  markers: "counted",
  expands: ["at-import"],
  detect: { dirs: ["."] },
  hook: {
    kind: "file",
    path: { project: ".amp/plugins/maxims.ts", global: "plugins/maxims.ts" },
    contentTemplate: [
      "// Written by maxims. It runs the maxims sync whenever an Amp session starts so the rule",
      "// files stay current. maxims rewrites this file on every sync while a source in its state",
      "// still wants a hook for Amp; removing the last such source deletes it.",
      'import type { PluginAPI } from "@ampcode/plugin";',
      "",
      "export default function (amp: PluginAPI) {",
      '  amp.on("session.start", async () => {',
      "    try {",
      "      await amp.$`{{command}}`;",
      "    } catch {",
      "      // An offline npx is not a plugin error; the rules keep their last synced state.",
      "    }",
      "  });",
      "}",
      "",
    ].join("\n"),
    executable: false,
    stdout: "none",
  },
  mcp: {
    path: { project: ".amp/settings.json", global: "settings.json" },
    serversPath: ["amp.mcpServers"],
  },
  fixtures: { config: "settings.json" },
} satisfies HarnessSpec;
