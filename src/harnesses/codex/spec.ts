import { contentHashLiteral } from "../../memory/contract.ts";
import type { HarnessSpec } from "../spec.ts";

// Codex resolves its home from $CODEX_HOME before falling back to ~/.codex; every user-level file
// (AGENTS.md, hooks.json, config.toml) moves with it. Hooks are on unless `[features] hooks =
// false` is set, so `config.toml` is read for that flag and never written.
export const spec = {
  id: "codex",
  displayName: "Codex",
  tier: 1,
  verifiedAgainst: {
    url: "https://learn.chatgpt.com/docs/hooks",
    date: "2026-09-21",
    contentHash: contentHashLiteral(
      "sha256:66f02af8596752fcac908982eab4e3cd81f14d29a10e546ec5bb1803185a8afd",
    ),
  },
  globalRoot: { default: ".codex", env: { name: "CODEX_HOME" } },
  targets: {
    project: { kind: "shared-block", file: "AGENTS.md" },
    global: { kind: "shared-block", file: "AGENTS.md" },
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
