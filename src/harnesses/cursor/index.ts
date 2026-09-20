import { join } from "node:path";
import { stringify } from "yaml";
import { ExitCode, MaximsError } from "../../util/exit-codes.ts";
import type { HarnessContext, HarnessDefinition, Scope } from "../contract.ts";

// Cursor ignores a plain `.md` in `.cursor/rules` and loads an `.mdc` only when its frontmatter
// says so: without `alwaysApply: true` the rule is offered to the agent by description instead
// of being injected every session. Scoped rules swap that flag for `globs`.
function frontmatter(paths?: string[]): string {
  const fields =
    paths === undefined || paths.length === 0
      ? { description: "Rule memories installed by maxims", alwaysApply: true }
      : { description: "Rule memories installed by maxims", globs: paths, alwaysApply: false };
  return `---\n${stringify(fields)}---\n`;
}

function scopeRoot(scope: Scope, ctx: HarnessContext): string {
  if (scope === "global") return ctx.home;
  if (ctx.projectRoot === null) {
    throw new MaximsError(ExitCode.Usage, "a project-scoped Cursor hook needs a project root");
  }
  return ctx.projectRoot;
}

export const cursor: HarnessDefinition = {
  id: "cursor",
  displayName: "Cursor",
  tier: 1,
  targets: {
    project: {
      kind: "rules-dir",
      dir: ".cursor/rules",
      fileName: (sourceSlug) => `maxims-${sourceSlug}.mdc`,
      frontmatter: ({ paths }) => frontmatter(paths),
    },
    // User rules live in Cursor's settings UI, not in a file.
    global: null,
  },
  bodiesDir: (scope) => (scope === "project" ? ".agents/memories" : null),
  // `sessionStart` is fire-and-forget on Cursor's side, so the harness never waits on the sync;
  // `debounceMs` keeps a burst of new conversations from paying the npx cost each time.
  hook: {
    kind: "registry",
    path: (scope, ctx) => join(scopeRoot(scope, ctx), ".cursor", "hooks.json"),
    format: "json",
    eventPath: ["hooks", "sessionStart"],
    grouped: false,
    wrapper: { version: 1 },
    handler: (spec) => ({
      type: "command",
      command: [spec.command, ...spec.args].join(" "),
      timeout: spec.timeoutSeconds,
    }),
    commandKey: "command",
    stdout: "json:additional_context",
    async: false,
    debounceMs: 60_000,
  },
  markers: "counted",
  // `@file` attaches a file to the rule's context and its literal-escaping is undocumented.
  expands: ["at-import"],
  scopeFrontmatter: (globs) => frontmatter(globs),
  detect: (ctx) => Boolean(ctx.env.CURSOR_TRACE_ID) || Boolean(ctx.env.CURSOR_AGENT),
  verifiedAgainst: { url: "https://cursor.com/docs/context/rules", date: "2026-09-20" },
  fixtures: { config: "config.json", hookStdin: "hook-stdin.json" },
};
