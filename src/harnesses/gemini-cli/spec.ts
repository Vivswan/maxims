import { toDefinition } from "../from-spec.ts";
import type { HarnessSpec } from "../spec.ts";

// Gemini reads `timeout` in milliseconds and runs every hook synchronously; there is no async
// field to set, so the session waits for sync and a seconds value would kill it at 20ms. The
// matcher group stays matcher-less: Gemini compares a lifecycle matcher with `===` against the
// source, so `startup|resume|clear` would match nothing and no matcher matches every start.
// settings.json is read through strip-json-comments and then `JSON.parse`, so a comment is fine
// and a trailing comma is a file Gemini reports and skips.
export const spec = {
  id: "gemini-cli",
  displayName: "Gemini CLI",
  tier: 1,
  verifiedAgainst: {
    date: "2026-10-10",
    sources: [
      {
        kind: "file",
        repo: "google-gemini/gemini-cli",
        ref: "main",
        path: "packages/cli/src/config/settings.ts",
        claims: ["JSON.parse(stripJsonComments(content))"],
        note: "settings.json takes comments and nothing else beyond strict JSON",
      },
      {
        kind: "schema",
        url: "https://raw.githubusercontent.com/google-gemini/gemini-cli/main/schemas/settings.schema.json",
        paths: [
          "/properties/hooks/properties/SessionStart",
          "/$defs/HookDefinitionArray",
          {
            pointer:
              "/$defs/HookDefinitionArray/items/properties/hooks/items/properties/timeout/description",
            equals: "Timeout in milliseconds for hook execution.",
          },
          "/properties/context/properties/fileName",
        ],
        note: "the SessionStart hook list, the millisecond timeout and the context file name setting",
      },
      {
        kind: "file",
        repo: "google-gemini/gemini-cli",
        ref: "main",
        path: "packages/core/src/hooks/hookPlanner.ts",
        claims: ["matcher === trigger"],
        note: "matcher selection",
      },
      {
        kind: "file",
        repo: "google-gemini/gemini-cli",
        ref: "main",
        path: "packages/core/src/hooks/types.ts",
        claims: [
          "hookEventName: 'SessionStart'; additionalContext?: string;",
          "SessionStart = 'SessionStart'",
        ],
        note: "the SessionStart event and the additionalContext output",
      },
      {
        kind: "file",
        repo: "google-gemini/gemini-cli",
        ref: "main",
        path: "packages/core/src/tools/memoryTool.ts",
        claims: ["DEFAULT_CONTEXT_FILENAME = 'GEMINI.md'"],
        note: "GEMINI.md as the context file",
      },
      {
        kind: "file",
        repo: "google-gemini/gemini-cli",
        ref: "main",
        path: "packages/core/src/utils/paths.ts",
        claims: ["GEMINI_DIR = '.gemini'"],
        note: "~/.gemini as the global root",
      },
      {
        kind: "file",
        repo: "google-gemini/gemini-cli",
        ref: "main",
        path: "packages/core/src/utils/memoryImportProcessor.ts",
        claims: ["@path/to/file"],
        note: "@file imports",
      },
      {
        kind: "file",
        repo: "google-gemini/gemini-cli",
        ref: "main",
        path: "docs/hooks/reference.md",
        claims: ["hookSpecificOutput"],
        note: "the hookSpecificOutput envelope the hook prints",
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
    format: "json-with-comments",
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

export const geminiCli = toDefinition(spec);
