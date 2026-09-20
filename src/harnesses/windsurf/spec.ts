import type { HarnessSpec } from "../spec.ts";

// The legacy Cascade agent of Devin Desktop (formerly Windsurf). Its rules directory needs
// `trigger: always_on` in each file's frontmatter or the rule is not injected on every message;
// a path-scoped rule is `trigger: glob` with the pattern under `globs`, documented for one
// pattern only, so several are joined with commas. `.devin/rules/` is the location Cascade
// prefers over `.windsurf/rules/`. A workspace rule is capped at 12,000 characters and the single
// global file, which takes no frontmatter, at 6,000; the byte caps below are the conservative
// reading of those. Cascade has no session-start event, so the hook rides `pre_user_prompt`
// behind the shared debounce; the hook has no stdout protocol and no timeout field, runs
// `command` through bash and `powershell` on Windows, and silently skips an entry that names only
// one of them on the other platform.
export const spec = {
  id: "windsurf",
  displayName: "Windsurf Cascade",
  tier: 1,
  verifiedAgainst: { url: "https://docs.devin.ai/desktop/cascade/hooks", date: "2026-09-20" },
  globalRoot: { default: ".codeium/windsurf" },
  targets: {
    project: {
      kind: "rules-dir",
      dir: ".devin/rules",
      fileName: "maxims-{{slug}}.md",
      frontmatter: {
        always: { trigger: "always_on" },
        scoped: { fields: { trigger: "glob" }, pathsKey: "globs", pathsAs: "comma-list" },
      },
    },
    global: { kind: "shared-block", file: "memories/global_rules.md" },
  },
  bodiesDir: { project: ".agents/memories", global: null },
  markers: "counted",
  expands: [],
  byteBudget: { project: 12_000, global: 6000 },
  detect: { dirs: ["."] },
  hook: {
    kind: "registry",
    path: { project: ".windsurf/hooks.json", global: "hooks.json" },
    format: "json",
    eventPath: ["hooks", "pre_user_prompt"],
    grouped: false,
    handlerTemplate: { command: "{{command}}", powershell: "{{command}}", show_output: false },
    commandKey: "command",
    stdout: "none",
    async: false,
    debounceMs: 60_000,
  },
  mcp: { path: { project: null, global: "mcp_config.json" }, serversPath: ["mcpServers"] },
  fixtures: { config: "hooks.json", hookStdin: "hook-stdin.json" },
} satisfies HarnessSpec;
