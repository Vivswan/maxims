import type { HarnessSpec } from "../spec.ts";

// OpenCode resolves its global directory through the XDG base directories, so an override of
// `XDG_CONFIG_HOME` moves the config file, the plugins directory and AGENTS.md with it. The
// project target is a rules directory OpenCode does not read on its own: the configEdit quirk
// lists it in `opencode.json`. The global scope is a block in the one file OpenCode always reads,
// so it needs no such entry. OpenCode has no hook registry; a plugin file in its plugins directory
// is auto-discovered and `session.created` fires once per session. The sync runs through Bun's
// shell with `.nothrow().quiet()`, so an offline npx can never surface as a plugin error and there
// is no stdout channel for the staleness notice. Documented: "opencode doesn't automatically parse
// file references in AGENTS.md".
export const spec = {
  id: "opencode",
  displayName: "OpenCode",
  tier: 1,
  verifiedAgainst: {
    date: "2026-09-21",
    sources: [
      {
        kind: "schema",
        url: "https://opencode.ai/config.json",
        paths: [
          { pointer: "/$defs/Config/properties/instructions/type", equals: "array" },
          "/$defs/Config/properties/plugin",
        ],
        note: "the instructions and plugin keys of opencode.json",
      },
      {
        kind: "file",
        repo: "anomalyco/opencode",
        ref: "dev",
        path: "packages/core/src/global.ts",
        claims: ["path.join(xdgConfig!, app)", 'const app = "opencode"', "OPENCODE_CONFIG_DIR"],
        note: "~/.config/opencode as the global root",
      },
      {
        kind: "file",
        repo: "anomalyco/opencode",
        ref: "dev",
        path: "packages/opencode/src/session/instruction.ts",
        claims: ['path.join(global.config, "AGENTS.md")'],
        note: "AGENTS.md and ~/.config/opencode/AGENTS.md",
      },
      {
        kind: "file",
        repo: "anomalyco/opencode",
        ref: "dev",
        path: "packages/opencode/src/config/config.ts",
        claims: ['"opencode.json", "opencode.jsonc"', "merged.instructions"],
        note: "opencode.json locations and the instructions key",
      },
      {
        kind: "file",
        repo: "anomalyco/opencode",
        ref: "dev",
        path: "packages/opencode/src/config/plugin.ts",
        claims: ["{plugin,plugins}/*.{ts,js}"],
        note: "the plugins directory",
      },
      {
        kind: "file",
        repo: "anomalyco/opencode",
        ref: "dev",
        path: "packages/sdk/js/src/gen/types.gen.ts",
        claims: ['"session.created"'],
        note: "the session.created event",
      },
      {
        kind: "file",
        repo: "anomalyco/opencode",
        ref: "dev",
        path: "packages/plugin/src/index.ts",
        claims: ["event?:", "$: BunShell"],
        note: "the plugin's event hook and shell",
      },
      {
        kind: "file",
        repo: "anomalyco/opencode",
        ref: "dev",
        path: "packages/web/src/content/docs/rules.mdx",
        claims: ["doesn't automatically parse file references in `AGENTS.md`"],
        note: "unparsed file references",
      },
      {
        kind: "file",
        repo: "anomalyco/opencode",
        ref: "dev",
        path: "packages/web/src/content/docs/config.mdx",
        claims: ["~/.config/opencode/opencode.json"],
        note: "the global opencode.json",
      },
      {
        kind: "file",
        repo: "anomalyco/opencode",
        ref: "dev",
        path: "packages/web/src/content/docs/plugins.mdx",
        claims: [".opencode/plugins/", "~/.config/opencode/plugins/"],
        note: "the plugin directories",
      },
    ],
  },
  globalRoot: { default: ".config/opencode", env: { name: "XDG_CONFIG_HOME", subdir: "opencode" } },
  targets: {
    project: { kind: "rules-dir", dir: ".opencode/memories", fileName: "maxims-{{slug}}.md" },
    global: { kind: "shared-block", file: "AGENTS.md" },
  },
  bodiesDir: { project: ".agents/memories", global: null },
  markers: "counted",
  expands: ["none"],
  detect: { dirs: ["."] },
  hook: {
    kind: "file",
    path: { project: ".opencode/plugins/maxims.ts", global: "plugins/maxims.ts" },
    contentTemplate: [
      "// Written by maxims. It runs the maxims sync whenever an OpenCode session is created so the",
      "// rule files stay current. maxims rewrites this file on every sync while a source in its",
      "// state still wants a hook for OpenCode; removing the last such source deletes it.",
      'import type { Plugin } from "@opencode-ai/plugin";',
      "",
      "export const MaximsSync: Plugin = async ({ $ }) => ({",
      "  event: async ({ event }) => {",
      '    if (event.type === "session.created") await $`{{command}}`.nothrow().quiet();',
      "  },",
      "});",
      "",
    ].join("\n"),
    executable: false,
    stdout: "none",
  },
  fixtures: { config: "config.jsonc" },
} satisfies HarnessSpec;
