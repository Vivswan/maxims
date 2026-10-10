import { toDefinition } from "../from-spec.ts";
import type { HarnessSpec } from "../spec.ts";
import { layeredHooksProbe } from "./quirks.ts";

// Codex resolves its home from $CODEX_HOME before falling back to ~/.codex; every user-level file
// (AGENTS.md, hooks.json, config.toml) moves with it. Its two instruction loaders differ on a blank
// file: in that home it reads the first of AGENTS.override.md and AGENTS.md whose trimmed content
// is not empty, so a blank override is passed over there; in a project directory it takes the
// first of the two that exists and drops a blank one without falling back to AGENTS.md, so there
// the block belongs in the override even when blank. Hooks are on unless `[features] hooks =
// false` is set, so `config.toml` is read for that flag and never written.
export const spec = {
  id: "codex",
  displayName: "Codex",
  tier: 1,
  verifiedAgainst: {
    date: "2026-10-10",
    sources: [
      {
        kind: "schema",
        url: "https://raw.githubusercontent.com/openai/codex/main/codex-rs/core/config.schema.json",
        paths: ["/properties/features/properties/hooks"],
        note: "features.hooks in config.toml",
      },
      {
        kind: "file",
        repo: "openai/codex",
        ref: "main",
        path: "codex-rs/config/src/hook_config.rs",
        claims: [
          'rename = "SessionStart"',
          'rename = "timeout"',
          'rename = "statusMessage"',
          "timeout_sec",
          "r#async",
        ],
        note: "the SessionStart event and the handler fields as hooks.json spells them, async included",
      },
      {
        kind: "file",
        repo: "openai/codex",
        ref: "main",
        path: "codex-rs/features/src/lib.rs",
        claims: [
          'id: Feature::CodexHooks, key: "hooks", stage: Stage::Stable, default_enabled: true',
        ],
        note: "hooks on by default under [features]",
      },
      {
        kind: "file",
        repo: "openai/codex",
        ref: "main",
        path: "codex-rs/hooks/src/engine/discovery.rs",
        claims: ['join("hooks.json")'],
        note: "hooks.json discovery",
      },
      {
        kind: "file",
        repo: "openai/codex",
        ref: "main",
        path: "codex-rs/utils/home-dir/src/lib.rs",
        claims: ["CODEX_HOME", 'push(".codex")'],
        note: "CODEX_HOME and ~/.codex",
      },
      {
        kind: "schema",
        url: "https://raw.githubusercontent.com/openai/codex/main/codex-rs/hooks/schema/generated/session-start.command.input.schema.json",
        paths: [{ pointer: "/properties/hook_event_name/const", equals: "SessionStart" }],
        note: "the SessionStart hook's stdin",
      },
      {
        kind: "file",
        repo: "openai/codex",
        ref: "main",
        path: "codex-rs/codex-home/src/instructions/mod.rs",
        claims: [
          "for candidate in [LOCAL_AGENTS_MD_FILENAME, DEFAULT_AGENTS_MD_FILENAME]",
          'LOCAL_AGENTS_MD_FILENAME: &str = "AGENTS.override.md"',
          'DEFAULT_AGENTS_MD_FILENAME: &str = "AGENTS.md"',
          "contents.trim()",
          "!trimmed.is_empty()",
        ],
        note: "home loader: first of the two whose trimmed content is not empty",
      },
      {
        kind: "file",
        repo: "openai/codex",
        ref: "main",
        path: "codex-rs/core/src/agents_md.rs",
        claims: [
          'LOCAL_AGENTS_MD_FILENAME: &str = "AGENTS.override.md"',
          "names.push(LOCAL_AGENTS_MD_FILENAME); names.push(DEFAULT_AGENTS_MD_FILENAME);",
          'DEFAULT_AGENTS_MD_FILENAME: &str = "AGENTS.md"',
          "if metadata.is_file => return Ok(Some(candidate))",
          "(!loaded.is_empty()).then_some(loaded)",
        ],
        note: "project loader: first that exists per directory, a blank one dropped with no fallback",
      },
      {
        kind: "file",
        repo: "openai/codex",
        ref: "main",
        path: "codex-rs/config/src/config_toml.rs",
        claims: ["DEFAULT_PROJECT_DOC_MAX_BYTES: usize = 32 * 1024;"],
        note: "the 32 KiB project-doc default",
      },
      {
        kind: "page",
        url: "https://learn.chatgpt.com/docs/agent-configuration/agents-md.md",
        claims: [
          "it checks for `AGENTS.override.md`, then `AGENTS.md`",
          "only the first non-empty file",
          "project_doc_max_bytes",
        ],
        why: "the AGENTS.md precedence is prose with no single source constant beyond the two loaders; this is the page's markdown rendition",
        note: "AGENTS.override.md over AGENTS.md in each project directory and in the Codex home, blank files skipped",
      },
    ],
  },
  globalRoot: { default: ".codex", env: { name: "CODEX_HOME" } },
  targets: {
    project: {
      kind: "shared-block",
      file: "AGENTS.md",
      precedence: ["AGENTS.override.md", "AGENTS.md"],
    },
    global: {
      kind: "shared-block",
      file: "AGENTS.md",
      precedence: ["AGENTS.override.md", "AGENTS.md"],
      skipsEmpty: true,
    },
  },
  bodiesDir: { project: ".agents/memories", global: null },
  markers: "counted",
  expands: [],
  detect: { dirs: ["."] },
  hook: {
    kind: "registry",
    path: { project: ".codex/hooks.json", global: "hooks.json" },
    format: "json",
    eventPath: ["hooks", "SessionStart"],
    grouped: true,
    handlerTemplate: {
      type: "command",
      command: "{{command}}",
      timeout: "{{timeoutSeconds}}",
      async: "{{async}}",
      statusMessage: "Syncing maxims",
    },
    commandKey: "command",
    stdout: "plain",
    async: true,
    tierCheck: {
      path: { project: ".codex/config.toml", global: "config.toml" },
      format: "toml",
      key: "features.hooks",
      demotesWhen: false,
    },
  },
  fixtures: { config: "hooks.json", hookStdin: "hook-stdin.json" },
} satisfies HarnessSpec;

export const codex = toDefinition(spec, (declared) => ({
  achievedTier: layeredHooksProbe(declared, spec.hook.tierCheck.path),
}));
