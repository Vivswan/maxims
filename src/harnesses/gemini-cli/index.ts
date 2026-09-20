import { existsSync } from "node:fs";
import { join } from "node:path";
import { ExitCode, MaximsError } from "../../util/exit-codes.ts";
import type { HarnessContext, HarnessDefinition, Scope } from "../contract.ts";

function projectRoot(ctx: HarnessContext): string {
  if (ctx.projectRoot === null) {
    throw new MaximsError(ExitCode.Usage, "a project-scope Gemini CLI path needs a project root");
  }
  return ctx.projectRoot;
}

function configDir(scope: Scope, ctx: HarnessContext): string {
  return join(scope === "global" ? ctx.home : projectRoot(ctx), ".gemini");
}

export const geminiCli = {
  id: "gemini-cli",
  displayName: "Gemini CLI",
  tier: 1,
  targets: {
    project: { kind: "shared-block", file: "GEMINI.md" },
    global: { kind: "shared-block", file: ".gemini/GEMINI.md" },
  },
  bodiesDir: (scope, ctx) =>
    scope === "project" ? join(projectRoot(ctx), ".agents", "memories") : null,
  // Gemini reads `timeout` in milliseconds and runs every hook synchronously; there is no async
  // field to set, so the session waits for sync and a seconds value would kill it at 20ms.
  hook: {
    kind: "registry",
    path: (scope, ctx) => join(configDir(scope, ctx), "settings.json"),
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
    stdout: "json:additionalContext",
    async: false,
  },
  markers: "counted",
  expands: ["at-import"],
  detect: (ctx) => existsSync(join(ctx.home, ".gemini")),
  verifiedAgainst: {
    url: "https://raw.githubusercontent.com/google-gemini/gemini-cli/main/docs/hooks/reference.md",
    date: "2026-09-20",
  },
  fixtures: { config: "settings.json", hookStdin: "hook-stdin.json" },
} satisfies HarnessDefinition;
