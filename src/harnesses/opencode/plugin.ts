import type { HookSpec } from "../contract.ts";

// OpenCode has no hook registry; a plugin file in its plugins directory is auto-discovered and
// `session.created` is the event that fires once per session. The sync runs through Bun's shell
// with `.nothrow().quiet()` so an offline npx can never surface as a plugin error in the session.
export function renderPlugin(spec: HookSpec): string {
  const command = [spec.command, ...spec.args].join(" ");
  if (/[`$\\{}]/.test(command)) {
    throw new Error(`hook command ${JSON.stringify(command)} cannot be embedded in a template`);
  }
  return [
    "// Written by maxims. It runs the maxims sync whenever an OpenCode session is created so the",
    "// rule files stay current. maxims rewrites this file on every sync while a source in its",
    "// state still wants a hook for OpenCode; removing the last such source deletes it.",
    'import type { Plugin } from "@opencode-ai/plugin";',
    "",
    "export const MaximsSync: Plugin = async ({ $ }) => ({",
    "  event: async ({ event }) => {",
    `    if (event.type === "session.created") await $\`${command}\`.nothrow().quiet();`,
    "  },",
    "});",
    "",
  ].join("\n");
}
