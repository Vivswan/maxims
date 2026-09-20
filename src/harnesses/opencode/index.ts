import { existsSync } from "node:fs";
import { join } from "node:path";
import { type HarnessContext, type HarnessDefinition, type Scope, scopeRoot } from "../contract.ts";
import { reconcileInstructions } from "./instructions.ts";
import { renderPlugin } from "./plugin.ts";

// OpenCode resolves its global directory through the XDG base directories, so an override of
// `XDG_CONFIG_HOME` moves the config file, the plugins directory and AGENTS.md with it.
function globalRoot(ctx: HarnessContext): string {
  const xdg = ctx.env.XDG_CONFIG_HOME;
  return join(xdg === undefined || xdg === "" ? join(ctx.home, ".config") : xdg, "opencode");
}

function pluginsDir(scope: Scope, ctx: HarnessContext): string {
  const root = scopeRoot({ globalRoot }, scope, ctx);
  return scope === "global" ? join(root, "plugins") : join(root, ".opencode", "plugins");
}

// The project target is a rules directory that OpenCode does not read on its own: `configEdit`
// lists it in `opencode.json` through ./instructions.ts. The global scope is a block in the one
// file OpenCode always reads, so it needs no such entry.
export const opencode: HarnessDefinition = {
  id: "opencode",
  displayName: "OpenCode",
  tier: 1,
  targets: {
    project: {
      kind: "rules-dir",
      dir: join(".opencode", "memories"),
      fileName: (sourceSlug) => `maxims-${sourceSlug}.md`,
    },
    global: { kind: "shared-block", file: "AGENTS.md" },
  },
  bodiesDir: (scope, ctx) =>
    scope === "project" ? join(scopeRoot({ globalRoot }, scope, ctx), ".agents", "memories") : null,
  // The plugin's own shell call is `.quiet()`, and OpenCode reads nothing back from a plugin, so
  // there is no stdout channel for the staleness notice to use.
  hook: {
    kind: "file",
    path: (scope, ctx) => join(pluginsDir(scope, ctx), "maxims.ts"),
    render: renderPlugin,
    executable: false,
    stdout: "none",
  },
  markers: "counted",
  // Documented: "opencode doesn't automatically parse file references in AGENTS.md".
  expands: ["none"],
  detect: (ctx) => existsSync(globalRoot(ctx)),
  verifiedAgainst: { url: "https://opencode.ai/docs/plugins/", date: "2026-09-20" },
  fixtures: { config: "config.jsonc" },
  globalRoot,
  configEdit: (scope, ctx, wanted) =>
    scope === "project"
      ? reconcileInstructions(scopeRoot({ globalRoot }, scope, ctx), wanted)
      : Promise.resolve([]),
};
