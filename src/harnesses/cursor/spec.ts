import { contentHashLiteral } from "../../memory/contract.ts";
import type { HarnessSpec } from "../spec.ts";

// Cursor ignores a plain `.md` in `.cursor/rules` and loads an `.mdc` only when its frontmatter
// says so: without `alwaysApply: true` the rule is offered to the agent by description instead
// of being injected every session. Scoped rules swap that flag for `globs`, listed before it.
// User rules live in Cursor's settings UI, not in a file, so there is no global target.
// `sessionStart` is fire-and-forget on Cursor's side, so the harness never waits on the sync;
// `debounceMs` keeps a burst of new conversations from paying the npx cost each time. `@file`
// attaches a file to the rule's context and its literal-escaping is undocumented.
export const spec = {
  id: "cursor",
  displayName: "Cursor",
  tier: 1,
  verifiedAgainst: {
    url: "https://cursor.com/docs/context/rules",
    date: "2026-09-20",
    contentHash: contentHashLiteral(
      "sha256:2c400ceca96de581fc42d269a8f3fd3b145ca949a31e2550a510f04d19adf486",
    ),
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
  expands: ["at-import"],
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
