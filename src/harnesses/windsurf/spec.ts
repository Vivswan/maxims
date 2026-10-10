import { toDefinition } from "../from-spec.ts";
import type { HarnessSpec } from "../spec.ts";

// The earlier Cascade agent of Devin Desktop (formerly Windsurf). A rules file needs
// `trigger: always_on` in its frontmatter or it is not injected on every message; a path-scoped
// rule is `trigger: glob` with the patterns comma-joined under `globs`, documented for one only.
// `.devin/rules/` is preferred over `.windsurf/rules/`; a workspace rule is capped at 12,000
// characters and the global file, which takes no frontmatter, at 6,000 (byte caps below). With
// no session-start event the hook rides `pre_user_prompt` behind the shared debounce; it has no
// stdout protocol and no timeout field. A `powershell`-only entry is silently skipped on macOS
// and Linux, a `command`-only one runs on Windows via `powershell -Command`, so both keys are
// written and Windows skips the fallback. `.windsurf/hooks.json` is read only while the newer
// `.devin/hooks.json` is absent or holds no hooks. No `mcp`: its file is outside the global root.
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
