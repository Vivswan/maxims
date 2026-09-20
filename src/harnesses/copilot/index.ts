import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { stringify } from "yaml";
import { ExitCode, MaximsError } from "../../util/exit-codes.ts";
import type { HarnessContext, HarnessDefinition, Scope, Target } from "../contract.ts";

// Copilot CLI reads its user files from $COPILOT_HOME before falling back to ~/.copilot.
function copilotHome(ctx: HarnessContext): string {
  const override = ctx.env.COPILOT_HOME;
  return override !== undefined && override !== "" ? resolve(override) : join(ctx.home, ".copilot");
}

function projectRoot(ctx: HarnessContext): string {
  if (ctx.projectRoot === null) {
    throw new MaximsError(ExitCode.Usage, "a project-scope Copilot path needs a project root");
  }
  return ctx.projectRoot;
}

function hooksDir(scope: Scope, ctx: HarnessContext): string {
  return scope === "global"
    ? join(copilotHome(ctx), "hooks")
    : join(projectRoot(ctx), ".github", "hooks");
}

// Without `applyTo` an instructions file is path-scoped by Copilot's own matching and silently
// stops being always-loaded, so the frontmatter is never omitted; `**` matches every file.
function instructionsTarget(dir: string) {
  return {
    kind: "rules-dir",
    dir,
    fileName: (sourceSlug: string) => `maxims-${sourceSlug}.instructions.md`,
    frontmatter: ({ paths }: { paths?: string[] }) =>
      stringify({ applyTo: paths === undefined || paths.length === 0 ? "**" : paths.join(",") }),
  } satisfies Target;
}

export const copilot = {
  id: "copilot",
  displayName: "GitHub Copilot",
  tier: 1,
  targets: {
    project: instructionsTarget(".github/instructions"),
    global: instructionsTarget(".copilot/instructions"),
  },
  bodiesDir: (scope, ctx) =>
    scope === "project" ? join(projectRoot(ctx), ".agents", "memories") : null,
  // `bash` is the key both the CLI and the cloud agent honor; a `powershell` sibling would be
  // needed for Windows sessions and is not written, so the hook is inert there.
  hook: {
    kind: "file",
    path: (scope, ctx) => join(hooksDir(scope, ctx), "maxims.json"),
    render: (spec) =>
      `${JSON.stringify(
        {
          version: 1,
          hooks: {
            sessionStart: [
              {
                type: "command",
                bash: [spec.command, ...spec.args].join(" "),
                timeoutSec: spec.timeoutSeconds,
              },
            ],
          },
        },
        null,
        2,
      )}\n`,
    executable: false,
  },
  markers: "counted",
  expands: [],
  detect: (ctx) => ctx.env.COPILOT_HOME !== undefined || existsSync(join(ctx.home, ".copilot")),
  verifiedAgainst: {
    url: "https://docs.github.com/en/copilot/reference/hooks-configuration",
    date: "2026-09-20",
  },
  fixtures: { hookStdin: "hook-stdin.json" },
} satisfies HarnessDefinition;
