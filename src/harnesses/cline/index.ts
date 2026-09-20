import { existsSync } from "node:fs";
import { join } from "node:path";
import { ExitCode, MaximsError } from "../../util/exit-codes.ts";
import type { HarnessContext, HarnessDefinition, HookSpec, Scope, Target } from "../contract.ts";

function projectRoot(ctx: HarnessContext): string {
  if (ctx.projectRoot === null) {
    throw new MaximsError(ExitCode.Usage, "a project-scope Cline path needs a project root");
  }
  return ctx.projectRoot;
}

const GLOBAL_DIR = join("Documents", "Cline");

function hooksDir(scope: Scope, ctx: HarnessContext): string {
  return scope === "global"
    ? join(ctx.home, GLOBAL_DIR, "Hooks")
    : join(projectRoot(ctx), ".clinerules", "hooks");
}

// Cline rules without frontmatter are always active, so the file is the block and nothing more.
function rulesTarget(dir: string): Target {
  return { kind: "rules-dir", dir, fileName: (sourceSlug) => `maxims-${sourceSlug}.md` };
}

// Cline reads the hook's stdout as one JSON object, so sync's own output is discarded and the
// script answers for it; stdin carries task metadata sync never needs, and closing it keeps a
// session start from hanging on a reader.
function renderTaskStart(spec: HookSpec): string {
  const command = [spec.command, ...spec.args].join(" ");
  return [
    "#!/usr/bin/env sh",
    "# Written by maxims. Remove it with `maxims remove` or delete this file; edits are overwritten.",
    `${command} </dev/null >/dev/null 2>&1`,
    `printf '%s\\n' '{"cancel": false}'`,
    "",
  ].join("\n");
}

export const cline = {
  id: "cline",
  displayName: "Cline",
  tier: 1,
  targets: {
    project: rulesTarget(".clinerules"),
    global: rulesTarget(join(GLOBAL_DIR, "Rules")),
  },
  bodiesDir: (scope, ctx) =>
    scope === "project" ? join(projectRoot(ctx), ".agents", "memories") : null,
  // The hook only runs once the user turns on "Enable Hooks" in Cline's feature settings, which
  // live in the editor's own storage: no file on disk reveals the switch, so the tier stays 1.
  hook: {
    kind: "file",
    path: (scope, ctx) => join(hooksDir(scope, ctx), "TaskStart"),
    render: renderTaskStart,
    executable: true,
  },
  markers: "counted",
  expands: [],
  detect: (ctx) => existsSync(join(ctx.home, GLOBAL_DIR)) || existsSync(join(ctx.home, ".cline")),
  verifiedAgainst: {
    url: "https://raw.githubusercontent.com/cline/cline/main/.clinerules/hooks/README.md",
    date: "2026-09-20",
  },
  fixtures: { hookStdin: "hook-stdin.json" },
} satisfies HarnessDefinition;
