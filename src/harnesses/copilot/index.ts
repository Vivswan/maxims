import { statSync } from "node:fs";
import { join, resolve } from "node:path";
import { stringify } from "yaml";
import {
  type HarnessContext,
  type HarnessDefinition,
  type Scope,
  scopeRoot,
  type Target,
} from "../contract.ts";

// Copilot CLI reads its user files from $COPILOT_HOME before falling back to ~/.copilot; the
// instructions directory and the hooks directory both move with it.
function copilotHome(ctx: HarnessContext): string {
  const override = ctx.env.COPILOT_HOME;
  return override !== undefined && override !== "" ? resolve(override) : join(ctx.home, ".copilot");
}

const roots = { globalRoot: copilotHome };

function hooksDir(scope: Scope, ctx: HarnessContext): string {
  const root = scopeRoot(roots, scope, ctx);
  return scope === "global" ? join(root, "hooks") : join(root, ".github", "hooks");
}

// Without `applyTo` an instructions file is path-scoped by Copilot's own matching and silently
// stops being always-loaded, so the frontmatter is never omitted; `**` matches every file. Copilot
// reads the key only from a `---`-delimited YAML block, so the delimiters are part of the render.
function instructionsTarget(dir: string) {
  return {
    kind: "rules-dir",
    dir,
    fileName: (sourceSlug: string) => `maxims-${sourceSlug}.instructions.md`,
    frontmatter: ({ paths }: { paths?: string[] }) =>
      `---\n${stringify({
        applyTo: paths === undefined || paths.length === 0 ? "**" : paths.join(","),
      })}---\n`,
  } satisfies Target;
}

export const copilot = {
  id: "copilot",
  displayName: "GitHub Copilot",
  tier: 1,
  targets: {
    project: instructionsTarget(join(".github", "instructions")),
    global: instructionsTarget("instructions"),
  },
  bodiesDir: (scope, ctx) =>
    scope === "project" ? join(scopeRoot(roots, scope, ctx), ".agents", "memories") : null,
  // Copilot picks `bash` on POSIX and `powershell` on Windows and never falls back between them,
  // so both carry the same command or the hook is silently inert on one platform.
  hook: {
    kind: "file",
    path: (scope, ctx) => join(hooksDir(scope, ctx), "maxims.json"),
    render: (spec) => {
      const command = [spec.command, ...spec.args].join(" ");
      return `${JSON.stringify(
        {
          version: 1,
          hooks: {
            sessionStart: [
              {
                type: "command",
                bash: command,
                powershell: command,
                timeoutSec: spec.timeoutSeconds,
              },
            ],
          },
        },
        null,
        2,
      )}\n`;
    },
    executable: false,
    stdout: "json:additionalContext",
  },
  markers: "counted",
  expands: [],
  detect: (ctx) => statSync(copilotHome(ctx), { throwIfNoEntry: false })?.isDirectory() ?? false,
  globalRoot: copilotHome,
  verifiedAgainst: {
    url: "https://docs.github.com/en/copilot/reference/hooks-configuration",
    date: "2026-09-20",
  },
  fixtures: { hookStdin: "hook-stdin.json" },
} satisfies HarnessDefinition;
