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
    url: "https://raw.githubusercontent.com/google-gemini/gemini-cli/main/docs/hooks/reference.md",
    date: "2026-09-20",
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
