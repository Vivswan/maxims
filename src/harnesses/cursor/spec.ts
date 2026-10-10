import { toDefinition } from "../from-spec.ts";
import type { HarnessSpec } from "../spec.ts";

// Cursor ignores a plain `.md` in `.cursor/rules` and loads an `.mdc` only when its frontmatter
// says so: without `alwaysApply: true` the rule is offered to the agent by description instead
// of being injected every session. Scoped rules swap that flag for `globs`, listed before it.
// User rules live in Cursor's settings UI, not in a file, so there is no global target.
// `sessionStart` is fire-and-forget on Cursor's side, so the harness never waits on the sync;
// `debounceMs` keeps a burst of new conversations from paying the npx cost each time. Rule text
// reaches the agent as written: an `@file` mention is not inlined, the agent reads the file with
// its tools when it wants the content.
export const spec = {
  id: "cursor",
  displayName: "Cursor",
  tier: 1,
  verifiedAgainst: {
    date: "2026-10-09",
    sources: [
      {
        kind: "page",
        url: "https://cursor.com/docs/hooks.md",
        claims: [
          "`.cursor/hooks.json`",
          "`~/.cursor/hooks.json`",
          '"version": 1',
          "sessionStart",
          "additional_context",
          "fire-and-forget",
        ],
        why: "Cursor is closed source and cursor.com/schemas/hooks.schema.json answers with an HTML page, not a schema; this is the page's markdown rendition",
        note: "sessionStart in hooks.json and additional_context",
      },
      {
        kind: "page",
        url: "https://cursor.com/docs/rules.md",
        claims: [".mdc", ".cursor/rules", "alwaysApply: true", "globs", "User Rules"],
        why: "Cursor is closed source and publishes no rules schema; this is the page's markdown rendition",
        note: ".mdc rules with alwaysApply and globs",
      },
    ],
  },
  targets: {
    project: {
      kind: "rules-dir",
      dir: ".cursor/rules",
      fileName: "maxims-{{slug}}.mdc",
      frontmatter: {
        always: { description: "Rule memories installed by maxims", alwaysApply: true },
        scoped: {
          fields: {
            description: "Rule memories installed by maxims",
            globs: null,
            alwaysApply: false,
          },
          pathsKey: "globs",
          pathsAs: "list",
        },
      },
    },
    global: null,
  },
  bodiesDir: { project: ".agents/memories", global: null },
  markers: "counted",
  expands: ["none"],
  detect: { dirs: [".cursor"] },
  hook: {
    kind: "registry",
    path: { project: ".cursor/hooks.json", global: ".cursor/hooks.json" },
    format: "json",
    eventPath: ["hooks", "sessionStart"],
    grouped: false,
    wrapper: { version: 1 },
    handlerTemplate: { type: "command", command: "{{command}}", timeout: "{{timeoutSeconds}}" },
    commandKey: "command",
    stdout: "json:additional_context",
    async: false,
    debounceMs: 60_000,
  },
  fixtures: { config: "config.json", hookStdin: "hook-stdin.json" },
} satisfies HarnessSpec;

export const cursor = toDefinition(spec);
