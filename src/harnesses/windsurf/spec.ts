import { toDefinition } from "../from-spec.ts";
import type { HarnessSpec } from "../spec.ts";

// The earlier Cascade agent of Devin Desktop (formerly Windsurf). It has no session-start event, so
// the hook rides `pre_user_prompt` and the `sync --quiet` stamp debounces the rest to one sync a
// minute.
//   .devin/rules        preferred over `.windsurf/rules/`
//   .devin/hooks.json   `.windsurf/hooks.json` is read only while this file is absent or holds no
//                       hooks
//   both command keys   a `powershell`-only entry is silently skipped on macOS and Linux, and a
//                       `command`-only one runs on Windows via `powershell -Command`
export const spec = {
  id: "windsurf",
  displayName: "Windsurf Cascade",
  tier: 1,
  verifiedAgainst: {
    date: "2026-10-07",
    sources: [
      {
        kind: "page",
        url: "https://docs.devin.ai/desktop/cascade/hooks.md",
        claims: [
          "~/.codeium/windsurf/hooks.json",
          ".devin/hooks.json",
          ".windsurf/hooks.json",
          '"pre_user_prompt"',
          "show_output",
        ],
        why: "Windsurf is closed source and publishes no schema; this is the page's markdown rendition",
        note: "pre_user_prompt in hooks.json per scope",
      },
      {
        kind: "page",
        url: "https://docs.devin.ai/desktop/cascade/memories.md",
        claims: [
          "global_rules.md",
          "The global rules file is limited to 6,000 characters.",
          "Workspace rule files are limited to 12,000 characters each.",
          "trigger:",
          "always_on",
          "globs:",
        ],
        why: "Windsurf is closed source and publishes no schema; this is the page's markdown rendition",
        note: "rules directories, triggers, the 12,000 and 6,000 character caps, global_rules.md",
      },
      {
        kind: "page",
        url: "https://docs.devin.ai/desktop/cascade/mcp.md",
        claims: [
          "~/.config/devin/mcp_config.json",
          "$XDG_CONFIG_HOME/devin/mcp_config.json",
          "mcpServers",
        ],
        why: "Windsurf is closed source and publishes no schema; this is the page's markdown rendition",
        note: "mcp_config.json is ~/.config/devin/mcp_config.json on macOS and Linux (under $XDG_CONFIG_HOME/devin when set) and %APPDATA%\\devin\\mcp_config.json on Windows, outside the global root ~/.codeium/windsurf, so no mcp registry is declared",
      },
    ],
  },
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
    path: { project: ".devin/hooks.json", global: "hooks.json" },
    format: "json",
    eventPath: ["hooks", "pre_user_prompt"],
    grouped: false,
    handlerTemplate: { command: "{{command}}", powershell: "{{command}}", show_output: false },
    commandKey: "command",
    stdout: "none",
    async: false,
    debounceMs: 60_000,
  },
  fixtures: { config: "hooks.json", hookStdin: "hook-stdin.json" },
} satisfies HarnessSpec;

export const windsurf = toDefinition(spec);
