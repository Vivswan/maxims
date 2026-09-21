import { contentHashLiteral } from "../../memory/contract.ts";
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
    url: "https://opencode.ai/docs/plugins/",
    date: "2026-09-21",
    contentHash: contentHashLiteral(
      "sha256:5bdc6b9addfd210421c5773eb60319a5470430012471f24003b7041e88099baa",
    ),
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
