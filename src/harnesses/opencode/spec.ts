import { toDefinition } from "../from-spec.ts";
import type { HarnessSpec } from "../spec.ts";
import { configEdit, RULE_FILE_NAME, RULES_DIR } from "./quirks.ts";

// OpenCode reads no rules directory on its own, so the configEdit quirk lists the project target in
// `opencode.json`; the global scope is a block in the one file OpenCode always reads and needs no
// entry. `session.created` fires once per session, and the plugin swallows the sync's exit and
// output, so an offline npx can never surface as a plugin error and there is no stdout channel for
// the staleness notice.
export const spec = {
  id: "opencode",
  displayName: "OpenCode",
  tier: 1,
  verifiedAgainst: {
    date: "2026-10-10",
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
        claims: [
          'const instructionFiles = [ "AGENTS.md",',
          'path.join(global.config, "AGENTS.md")',
          "globUp(instruction, ctx.directory, ctx.worktree)",
        ],
        note: "AGENTS.md, ~/.config/opencode/AGENTS.md, and a relative instructions entry globbed up from the working directory",
      },
      {
        kind: "file",
        repo: "anomalyco/opencode",
        ref: "dev",
        path: "packages/opencode/src/config/config.ts",
        claims: [
          'ConfigPaths.files("opencode", ctx.directory, ctx.worktree)',
          "merged.instructions",
        ],
        note: "the project opencode.json found walking up from the working directory, and the instructions merge",
      },
      {
        kind: "file",
        repo: "anomalyco/opencode",
        ref: "dev",
        path: "packages/opencode/src/config/paths.ts",
        claims: [`targets: [\`\${name}.jsonc\`, \`\${name}.json\`]`],
        note: "opencode.jsonc and opencode.json as the two project config names",
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
    project: { kind: "rules-dir", dir: RULES_DIR, fileName: RULE_FILE_NAME },
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

export const opencode = toDefinition(spec, { configEdit });
