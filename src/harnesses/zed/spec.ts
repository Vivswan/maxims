import { toDefinition } from "../from-spec.ts";
import type { HarnessSpec } from "../spec.ts";

// Zed reads exactly one project instruction file, and only at the worktree root. On Windows it
// asks for the RoamingAppData known folder, which maxims cannot look up, so `%APPDATA%` stands in
// and a re-pointed `APPDATA` moves maxims's root alone. A set `FLATPAK_XDG_CONFIG_HOME` is taken
// as it is; only `XDG_CONFIG_HOME` passes through the dirs crate, which drops a relative value.
export const spec = {
  id: "zed",
  displayName: "Zed",
  tier: 2,
  verifiedAgainst: {
    date: "2026-10-11",
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
          '.expect("failed to determine RoamingAppData directory")',
          'cfg!(any(target_os = "linux", target_os = "freebsd")) { if let Ok(flatpak_xdg_config) = std::env::var("FLATPAK_XDG_CONFIG_HOME") { flatpak_xdg_config.into() } else {',
          "AGENTS.md",
          "settings.json",
        ],
        note: "FLATPAK_XDG_CONFIG_HOME then XDG_CONFIG_HOME on Linux and FreeBSD, RoamingAppData on Windows, ~/.config/zed on macOS",
      },
      {
        kind: "file",
        repo: "dirs-dev/dirs-rs",
        ref: "main",
        path: "src/lin.rs",
        claims: ['env::var_os("XDG_CONFIG_HOME").and_then(dirs_sys::is_absolute_path)'],
        note: "a relative $XDG_CONFIG_HOME is dropped, as the XDG Base Directory spec requires",
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
          "- macOS: `~/.config/zed/settings.json`",
          "- Linux: `~/.config/zed/settings.json` (or `$XDG_CONFIG_HOME/zed/settings.json`)",
          "- Windows: `%APPDATA%\\Zed\\settings.json`",
          ".zed/settings.json",
          "The syntax is JSON with support for `//` comments.",
        ],
        note: "settings.json under ~/.config/zed, $XDG_CONFIG_HOME/zed on Linux, %APPDATA%\\Zed on Windows, read as JSON with comments",
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
  globalRoot: {
    default: ".config/zed",
    env: [
      {
        name: [
          { name: "FLATPAK_XDG_CONFIG_HOME" },
          { name: "XDG_CONFIG_HOME", absoluteOnly: true },
        ],
        subdir: "zed",
        platforms: ["linux", "freebsd"],
      },
      { name: "APPDATA", subdir: "Zed", platforms: ["win32"], absoluteOnly: true },
    ],
  },
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
    format: "jsonc",
  },
  fixtures: { config: "settings.json" },
} satisfies HarnessSpec;

export const zed = toDefinition(spec);
