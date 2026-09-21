import { contentHashLiteral } from "../../memory/contract.ts";
import type { HarnessSpec } from "../spec.ts";

// Gemini reads `timeout` in milliseconds and runs every hook synchronously; there is no async
// field to set, so the session waits for sync and a seconds value would kill it at 20ms. The
// matcher group stays matcher-less: Gemini compares a lifecycle matcher with `===` against the
// source, so `startup|resume|clear` would match nothing and no matcher matches every start.
export const spec = {
  id: "gemini-cli",
  displayName: "Gemini CLI",
  tier: 1,
  verifiedAgainst: {
    date: "2026-09-21",
    pages: [
      {
        url: "https://raw.githubusercontent.com/google-gemini/gemini-cli/main/docs/hooks/reference.md",
        contentHash: contentHashLiteral(
          "sha256:a7489955249081d1b6064eab80f46e9d736c93cb1404c400411e76453ef7a2d3",
        ),
      },
      {
        url: "https://raw.githubusercontent.com/google-gemini/gemini-cli/main/docs/cli/gemini-md.md",
        contentHash: contentHashLiteral(
          "sha256:3563c86c9aa7345c88a339c00af6bc17b12a62d95e36d2b54963fdaf07fcade3",
        ),
        note: "GEMINI.md locations and @file imports",
      },
    ],
  },
  targets: {
    project: { kind: "shared-block", file: "GEMINI.md" },
    global: { kind: "shared-block", file: ".gemini/GEMINI.md" },
  },
  bodiesDir: { project: ".agents/memories", global: null },
  markers: "counted",
  expands: ["at-import"],
  detect: { dirs: [".gemini"] },
  hook: {
    kind: "registry",
    path: { project: ".gemini/settings.json", global: ".gemini/settings.json" },
    format: "json",
    eventPath: ["hooks", "SessionStart"],
    grouped: true,
    handlerTemplate: {
      name: "maxims-sync",
      type: "command",
      command: "{{command}}",
      timeout: "{{timeoutMs}}",
    },
    commandKey: "command",
    stdout: "json:hookSpecificOutput.additionalContext",
    async: false,
  },
  fixtures: { config: "settings.json", hookStdin: "hook-stdin.json" },
} satisfies HarnessSpec;
