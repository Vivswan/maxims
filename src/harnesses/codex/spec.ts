import { toDefinition } from "../from-spec.ts";
import type { HarnessSpec } from "../spec.ts";

// Codex resolves its home from $CODEX_HOME before falling back to ~/.codex; every user-level file
// (AGENTS.md, hooks.json, config.toml) moves with it. Its two instruction loaders differ on a blank
// file: in that home it reads the first of AGENTS.override.md and AGENTS.md whose trimmed content
// is not empty, so a blank override is passed over there; in a project directory it takes the
// first of the two that exists and drops a blank one without falling back to AGENTS.md, so there
// the block belongs in the override even when blank. Hooks are on unless `[features] hooks =
// false` is set; Codex layers a `.codex/config.toml` from the project root down to the directory
// it runs in over the user config.toml, the nearest deciding, so every one of them is read for
// that flag and never written. A project layer applies only where the user config.toml marks its
// directory, or the project root, `projects.<path>.trust_level = "trusted"`; an untrusted one is
// skipped whole, broken or not. Codex refuses to start on a user or trusted project config.toml it
// cannot parse or type, so such a layer anywhere is hooks off. hooks.json goes through serde_json,
// which takes strict JSON: a comment or a trailing comma is a file Codex warns about and skips.
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
        path: "codex-rs/config/src/loader/mod.rs",
        claims: [
          "toml::from_str(&contents).map_err(|err| {",
          "io_error_from_config_error(io::ErrorKind::InvalidData, config_error, Some(err))",
          "typed_first_layer_config_error_from_entries::<ConfigToml>(layers, CONFIG_TOML_FILE)",
        ],
        note: "a config.toml that does not parse, or does not fit ConfigToml, is an error the loader returns for the user layer and a trusted project layer, not one it skips",
      },
      {
        kind: "file",
        repo: "openai/codex",
        ref: "main",
        path: "codex-rs/config/src/loader/mod.rs",
        claims: [
          "let mut dirs = cwd",
          ".scan(false, |done, a| {",
          "if &a == project_root {",
          "dirs.reverse();",
          'let dot_codex_abs = dir.join(".codex");',
        ],
        note: "the project layers are the .codex/config.toml of every directory from the session's cwd up to the project root, loaded root first so the nearest wins",
      },
      {
        kind: "file",
        repo: "openai/codex",
        ref: "main",
        path: "codex-rs/config/src/loader/mod.rs",
        claims: [
          "let decision = trust_context.decision_for_dir(&dir);",
          "for dir_key in normalized_project_trust_keys(dir.as_path()) {",
          "for project_root_key in &self.project_root_lookup_keys {",
          "matches!(self.trust_level, Some(TrustLevel::Trusted))",
          "ConfigLayerEntry::new_disabled(source, config, reason)",
          "if decision.is_trusted() {",
          "config: TomlValue::Table(toml::map::Map::new()),",
        ],
        note: "a project layer is trusted by its own directory's entry in the user config's projects table, else the project root's, and only a trusted one applies; an untrusted layer that does not parse becomes an empty disabled layer where a trusted one is the error above",
      },
      {
        kind: "file",
        repo: "openai/codex",
        ref: "main",
        path: "codex-rs/protocol/src/config_types.rs",
        claims: [
          '#[serde(rename_all = "lowercase")]',
          "pub enum TrustLevel {",
          "Trusted,",
          "Untrusted,",
        ],
        note: "the two marks a projects entry's trust_level takes; any other fails to deserialize and Codex does not start",
      },
      {
        kind: "page",
        url: "https://learn.chatgpt.com/docs/config-file/config-reference.md",
        claims: [
          "Codex loads project-scoped config files only when you trust the project.",
          "projects.<path>.trust_level",
          "Untrusted projects skip project-scoped `.codex/` layers, including project-local config, hooks, and rules.",
        ],
        why: "the trust key's spelling and the skip of untrusted layers are stated together only on the page; the loader source above carries the lookup order",
        note: "projects.<path>.trust_level in the user config.toml gates every project-scoped layer",
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
        claims: [
          'join("hooks.json")',
          "let parsed: HooksFile = match serde_json::from_str(&contents) {",
          '"failed to parse hooks config {}: {err}",',
        ],
        note: "hooks.json discovery, parsed as strict JSON by serde_json and skipped with a warning when it does not parse",
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
      layers: {
        project: [{ kind: "root-to-cwd", file: ".codex/config.toml" }],
        global: ["config.toml"],
      },
      format: "toml",
      key: "features.hooks",
      demotesWhen: false,
      unreadable: "refuses-to-start",
      projectTrust: {
        table: "projects",
        key: "trust_level",
        trusted: "trusted",
        accepted: ["trusted", "untrusted"],
      },
    },
  },
  fixtures: { config: "hooks.json", hookStdin: "hook-stdin.json" },
} satisfies HarnessSpec;

export const codex = toDefinition(spec);
