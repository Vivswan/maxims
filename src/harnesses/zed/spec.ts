import { toDefinition } from "../from-spec.ts";
import type { HarnessSpec } from "../spec.ts";

// Zed reads exactly one project instruction file, and only at the worktree root. Its paths.rs
// resolves the config directory through `$XDG_CONFIG_HOME` on Linux and FreeBSD and fixes it at
// `~/.config/zed` on macOS.
export const spec = {
  id: "zed",
  displayName: "Zed",
  tier: 2,
  verifiedAgainst: {
    date: "2026-10-07",
    sources: [
      {
        kind: "file",
        repo: "zed-industries/zed",
        ref: "main",
        path: "crates/prompt_store/src/prompts.rs",
        claims: [
          'RULES_FILE_NAMES: &[&str] = &[ ".rules", ".cursorrules", ".windsurfrules", ".clinerules", ".github/copilot-instructions.md", "AGENT.md", "AGENTS.md", "CLAUDE.md", "GEMINI.md", ];',
        ],
        note: "the rules file names and their order",
      },
      {
        kind: "file",
        repo: "zed-industries/zed",
        ref: "main",
        path: "crates/paths/src/paths.rs",
        claims: [
          'home_dir().join(".config").join(APP_NAME_LOWERCASE)',
          'dirs::config_dir().expect("failed to determine XDG_CONFIG_HOME directory")',
          'cfg!(any(target_os = "linux", target_os = "freebsd")) { if let Ok(flatpak_xdg_config) = std::env::var("FLATPAK_XDG_CONFIG_HOME")',
          "AGENTS.md",
          "settings.json",
        ],
        note: "XDG_CONFIG_HOME on Linux and FreeBSD, ~/.config/zed on macOS",
      },
      {
        kind: "file",
        repo: "zed-industries/zed",
        ref: "main",
        path: "crates/settings_content/src/project.rs",
        claims: ["context_servers"],
        note: "context_servers in settings.json",
      },
      {
        kind: "file",
        repo: "zed-industries/zed",
        ref: "main",
        path: "docs/src/configuring-zed.md",
        claims: [
          "~/.config/zed/settings.json",
          "$XDG_CONFIG_HOME/zed/settings.json",
          ".zed/settings.json",
        ],
        note: "settings.json under ~/.config/zed",
      },
      {
        kind: "file",
        repo: "zed-industries/zed",
        ref: "main",
        path: "docs/src/ai/instructions.md",
        claims: ["~/.config/zed/AGENTS.md"],
        note: "the global AGENTS.md",
      },
      {
        kind: "file",
        repo: "zed-industries/zed",
        ref: "main",
        path: "docs/src/ai/mcp.md",
        claims: ['"context_servers": {'],
        note: "the context_servers map",
      },
    ],
  },
  globalRoot: { default: ".config/zed", env: { name: "XDG_CONFIG_HOME", subdir: "zed" } },
  targets: {
    project: {
      kind: "shared-block",
      file: "AGENTS.md",
      precedence: [
        ".rules",
        ".cursorrules",
        ".windsurfrules",
        ".clinerules",
        ".github/copilot-instructions.md",
        "AGENT.md",
        "AGENTS.md",
        "CLAUDE.md",
        "GEMINI.md",
      ],
    },
    global: { kind: "shared-block", file: "AGENTS.md" },
  },
  bodiesDir: { project: ".agents/memories", global: null },
  markers: "counted",
  expands: [],
  detect: { dirs: ["."] },
  hook: { kind: "none" },
  mcp: {
    path: { project: ".zed/settings.json", global: "settings.json" },
    serversPath: ["context_servers"],
  },
  fixtures: { config: "settings.json" },
} satisfies HarnessSpec;

export const zed = toDefinition(spec);
