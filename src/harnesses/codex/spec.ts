import { contentHashLiteral } from "../../memory/contract.ts";
import type { HarnessSpec } from "../spec.ts";

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
    date: "2026-09-21",
    pages: [
      {
        url: "https://learn.chatgpt.com/docs/hooks",
        contentHash: contentHashLiteral(
          "sha256:66f02af8596752fcac908982eab4e3cd81f14d29a10e546ec5bb1803185a8afd",
        ),
      },
      {
        url: "https://developers.openai.com/codex/config-reference",
        contentHash: contentHashLiteral(
          "sha256:f0ffeca46e4ac7948a7479d6f94969565764661963465c582b88968c318b0a5e",
        ),
        note: "CODEX_HOME and features.hooks",
      },
      {
        url: "https://learn.chatgpt.com/docs/agent-configuration/agents-md",
        contentHash: contentHashLiteral(
          "sha256:d7fb656879e972b2161881c93cb3404e5b5419c563e4fae377e15d4fecb2d7cd",
        ),
        note: "AGENTS.override.md over AGENTS.md in each project directory and in the Codex home, blank files skipped",
      },
      {
        url: "https://raw.githubusercontent.com/openai/codex/main/codex-rs/codex-home/src/instructions/mod.rs",
        contentHash: contentHashLiteral(
          "sha256:a99376754b06f6aba8c14280a02c67074ef8a5502994e9c29cb95ca6f53766ee",
        ),
        note: "home loader: first of the two whose trimmed content is not empty",
      },
      {
        url: "https://raw.githubusercontent.com/openai/codex/main/codex-rs/core/src/agents_md.rs",
        contentHash: contentHashLiteral(
          "sha256:aeaaa10c1c07f04b1f9b93fa1941ae2ff5994d90b04ca2be606d0693378c8685",
        ),
        note: "project loader: first that exists per directory, a blank one dropped with no fallback",
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
