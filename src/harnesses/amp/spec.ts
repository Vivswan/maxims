import { toDefinition } from "../from-spec.ts";
import type { HarnessSpec } from "../spec.ts";

// Amp reads AGENTS.md from the working directory upward, then every user and system guidance
// file that exists, side by side. Only a project directory with no AGENTS.md falls back to
// AGENT.md or CLAUDE.md, so creating one beside those would stop Amp reading the user's file.
//
//   ~/.config/amp/AGENTS.md  -> the global target: Amp's own file
//   ~/.config/AGENTS.md      -> shared with other tools and read beside it, so no precedence
//   /etc/ampcode/AGENTS.md   -> outside HOME, where maxims never writes
//
// Amp expands `@path` mentions inside the file. It has no hook registry: a plugin file in its
// plugins directory receives `session.start` and runs the sync through the plugin API's shell.
// Its docs give `~/.config/amp` for AGENTS.md and settings without an XDG override, so the root
// stays fixed even though the plugins page honours `XDG_CONFIG_HOME`.
export const spec = {
  id: "amp",
  displayName: "Amp",
  tier: 1,
  verifiedAgainst: {
    date: "2026-10-10",
    sources: [
      {
        kind: "schema",
        url: "https://ampcode.com/cli-settings.schema.json",
        paths: [{ pointer: "/properties/amp.mcpServers/type", equals: "object" }, "/$id"],
        note: "amp.mcpServers in settings.json",
      },
      {
        kind: "page",
        url: "https://ampcode.com/docs/markdown/customize/agents-md",
        claims: [
          "`AGENTS.md` files in the current working directory",
          "System-wide guidance files, as well as both `$HOME/.config/amp/AGENTS.md` and `$HOME/.config/AGENTS.md`, are always included if they exist.",
          "/etc/ampcode/AGENTS.md",
          "If no `AGENTS.md` exists in a directory, but a file named `AGENT.md` (without an `S`) or `CLAUDE.md` does exist, that file will be included.",
          "AMP_IGNORE_GUIDANCE_FILES",
        ],
        why: "Amp is closed source and its settings schema covers settings keys only, not file discovery; this is the page's markdown rendition",
        note: "AGENTS.md discovery, the user and system files read side by side, and the AGENT.md and CLAUDE.md fallback",
      },
      {
        kind: "page",
        url: "https://ampcode.com/docs/markdown/customize/plugins",
        claims: [
          ".amp/plugins/",
          "$XDG_CONFIG_HOME/amp/plugins/",
          "~/.config/amp/plugins/",
          "session.start",
        ],
        why: "Amp is closed source and its settings schema covers settings keys only, not the plugin directories; this is the page's markdown rendition",
        note: "the plugin directories and the session.start event",
      },
      {
        kind: "page",
        url: "https://ampcode.com/docs/markdown/cli/settings",
        claims: ["~/.config/amp/settings.json", ".amp/settings.json"],
        why: "Amp is closed source and its settings schema names no file location; this is the page's markdown rendition",
        note: "settings.json per scope",
      },
    ],
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

export const amp = toDefinition(spec);
