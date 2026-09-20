import { join } from "node:path";
import { ExitCode, MaximsError } from "../../util/exit-codes.ts";
import type { HarnessContext, HarnessDefinition, Scope } from "../contract.ts";
import { renderPlugin } from "./plugin.ts";

// OpenCode resolves its global directory through the XDG base directories, so an override of
// `XDG_CONFIG_HOME` moves the plugins directory with it.
function scopeRoot(scope: Scope, ctx: HarnessContext): string {
  if (scope === "global") {
    const xdg = ctx.env.XDG_CONFIG_HOME;
    return join(xdg === undefined || xdg === "" ? join(ctx.home, ".config") : xdg, "opencode");
  }
  if (ctx.projectRoot === null) {
    throw new MaximsError(ExitCode.Usage, "a project-scoped OpenCode plugin needs a project root");
  }
  return join(ctx.projectRoot, ".opencode");
}

// The project target is a rules directory that OpenCode does not read on its own: sync also
// lists it in `opencode.json` through `reconcileInstructions` in ./instructions.ts.
export const opencode: HarnessDefinition = {
  id: "opencode",
  displayName: "OpenCode",
  tier: 1,
  targets: {
    project: {
      kind: "rules-dir",
      dir: ".opencode/memories",
      fileName: (sourceSlug) => `maxims-${sourceSlug}.md`,
    },
    global: { kind: "shared-block", file: ".config/opencode/AGENTS.md" },
  },
  bodiesDir: (scope) => (scope === "project" ? ".agents/memories" : null),
  hook: {
    kind: "file",
    path: (scope, ctx) => join(scopeRoot(scope, ctx), "plugins", "maxims.ts"),
    render: renderPlugin,
    executable: false,
  },
  markers: "counted",
  // Documented: "opencode doesn't automatically parse file references in AGENTS.md".
  expands: ["none"],
  detect: (ctx) => Boolean(ctx.env.OPENCODE_CLIENT),
  verifiedAgainst: { url: "https://opencode.ai/docs/plugins/", date: "2026-09-20" },
  fixtures: { config: "config.jsonc" },
};
