import { statSync } from "node:fs";
import { join } from "node:path";
import { type HarnessDefinition, scopeRoot } from "../contract.ts";

const roots = {};

export const geminiCli = {
  id: "gemini-cli",
  displayName: "Gemini CLI",
  tier: 1,
  targets: {
    project: { kind: "shared-block", file: "GEMINI.md" },
    global: { kind: "shared-block", file: join(".gemini", "GEMINI.md") },
  },
  bodiesDir: (scope, ctx) =>
    scope === "project" ? join(scopeRoot(roots, scope, ctx), ".agents", "memories") : null,
  // Gemini reads `timeout` in milliseconds and runs every hook synchronously; there is no async
  // field to set, so the session waits for sync and a seconds value would kill it at 20ms. The
  // matcher group stays matcher-less: Gemini compares a lifecycle matcher with `===` against the
  // source, so `startup|resume|clear` would match nothing and no matcher matches every start.
  hook: {
    kind: "registry",
    path: (scope, ctx) => join(scopeRoot(roots, scope, ctx), ".gemini", "settings.json"),
    format: "json",
    eventPath: ["hooks", "SessionStart"],
    grouped: true,
    handler: (spec) => ({
      name: "maxims-sync",
      type: "command",
      command: [spec.command, ...spec.args].join(" "),
      timeout: spec.timeoutSeconds * 1000,
    }),
    commandKey: "command",
    stdout: "json:hookSpecificOutput.additionalContext",
    async: false,
  },
  markers: "counted",
  expands: ["at-import"],
  detect: (ctx) =>
    statSync(join(ctx.home, ".gemini"), { throwIfNoEntry: false })?.isDirectory() ?? false,
  verifiedAgainst: {
    url: "https://raw.githubusercontent.com/google-gemini/gemini-cli/main/docs/hooks/reference.md",
    date: "2026-09-20",
  },
  fixtures: { config: "settings.json", hookStdin: "hook-stdin.json" },
} satisfies HarnessDefinition;
