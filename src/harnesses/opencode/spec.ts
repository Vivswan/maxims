// The harness targets OpenCode 2.0 (`@opencode/cli` 2.x). A plugin is a module default-exporting
// `@opencode/plugin`'s `define` shape; a module of any other shape in the plugins directory is
// passed over without a word, so a 1.x-shaped file never runs, and the 1.x line is not targeted.
//   AGENTS.md         the only instruction files 2.0 loads: the project's, walked up from the
//                     working directory, and `~/.config/opencode/AGENTS.md`. An `instructions`
//                     entry in opencode.json passes its schema and is read by nothing, so both
//                     scopes are blocks and no config is edited.
//   plugins/          a `.ts` or `.js` file under `{plugin,plugins}/` of a config directory loads
//                     with no config entry; the `plugins` key takes packages and directories and
//                     refuses a file path, so the hook stays a file there.
//   session.created   reaches a plugin only for sessions created after it activated, and
//                     `opencode run` creates its session first, so the hook syncs at setup too.

import { toDefinition } from "../from-spec.ts";
import type { HarnessSpec } from "../spec.ts";

export const spec = {
  id: "opencode",
  displayName: "OpenCode",
  tier: 1,
  // The sources read `v2`, the 2.x release branch; `dev` carries what the next line will be.
  verifiedAgainst: {
    date: "2026-10-11",
    sources: [
      {
        kind: "file",
        repo: "anomalyco/opencode",
        ref: "v2",
        path: "packages/util/src/global-roots.ts",
        claims: [
          'process.env.XDG_CONFIG_HOME || (home ? path.join(home, ".config") : undefined)',
          "config: path.join(config!, app)",
        ],
        note: "the config root under XDG_CONFIG_HOME, else ~/.config",
      },
      {
        kind: "file",
        repo: "anomalyco/opencode",
        ref: "v2",
        path: "packages/util/src/global.ts",
        claims: [
          'const app = "opencode"',
          "const { data, cache, config, state, tmp } = roots(app)",
        ],
        note: "opencode as the directory under the config root",
      },
      {
        kind: "file",
        repo: "anomalyco/opencode",
        ref: "v2",
        path: "packages/core/src/config/plugin/instruction.ts",
        claims: ['join(global.config, "AGENTS.md")', 'targets: ["AGENTS.md"]'],
        note: "the global AGENTS.md and the project AGENTS.md walked up from the working directory, the only instruction files loaded",
      },
      {
        kind: "file",
        repo: "anomalyco/opencode",
        ref: "v2",
        path: "packages/core/src/config/discovery.ts",
        claims: ['path.basename(item) === ".opencode"'],
        note: "the .opencode directories found walking up from the working directory, config directories whose plugins are loaded",
      },
      {
        kind: "file",
        repo: "anomalyco/opencode",
        ref: "v2",
        path: "packages/core/src/plugin/source-directory.ts",
        claims: [
          'export const names = ["plugin", "plugins"] as const',
          'entry.target.endsWith(".ts") || entry.target.endsWith(".js")',
        ],
        note: "a .ts or .js file under a config directory's plugins/ as a plugin source",
      },
      {
        kind: "file",
        repo: "anomalyco/opencode",
        ref: "v2",
        path: "packages/core/src/config/plugin/source.ts",
        claims: [
          "PluginSourceDirectory.discover(fs, entry.path)",
          "if (yield* fs.isFile(operation.target)) {",
        ],
        note: "plugin sources discovered under every config directory with no config entry, and a file path under the plugins key refused",
      },
      {
        kind: "file",
        repo: "anomalyco/opencode",
        ref: "v2",
        path: "packages/core/src/plugin/module.ts",
        claims: [
          "const Module = Schema.Struct({",
          "setup: Schema.declare<",
          "? { server: pathToFileURL(operation.target).href }",
        ],
        note: "the default export a plugin file must carry, its setup function, and a plugin file loaded on its own as the server entrypoint",
      },
      {
        kind: "file",
        repo: "anomalyco/opencode",
        ref: "v2",
        path: "packages/plugin/package.json",
        claims: ['"name": "@opencode/plugin"', '".": "./src/promise/index.ts"'],
        note: "the package the hook imports and its promise entry",
      },
      {
        kind: "file",
        repo: "anomalyco/opencode",
        ref: "v2",
        path: "packages/plugin/src/promise/index.ts",
        claims: ['export * as Plugin from "./plugin.js"'],
        note: "the Plugin namespace the hook calls define on",
      },
      {
        kind: "file",
        repo: "anomalyco/opencode",
        ref: "v2",
        path: "packages/plugin/src/promise/plugin.ts",
        claims: [
          "readonly setup: (context: Context) => Promise<Cleanup | void> | Cleanup | void",
          "readonly event: EventDomain",
          "export function define(plugin: Plugin)",
        ],
        note: "define, the setup function, its cleanup, and the event domain the hook subscribes through",
      },
      {
        kind: "file",
        repo: "anomalyco/opencode",
        ref: "v2",
        path: "packages/plugin/src/promise/event.ts",
        claims: ['Pick<EventApi, "subscribe">'],
        note: "event.subscribe as the plugin's event stream",
      },
      {
        kind: "file",
        repo: "anomalyco/opencode",
        ref: "v2",
        path: "packages/plugin/src/promise/adapter.ts",
        claims: [
          "host.event.subscribe().pipe(",
          "Stream.toAsyncIterableWith(stream, context)",
          'options?.signal?.addEventListener("abort", abort, { once: true })',
        ],
        note: "the subscription as an async iterable over the host's events, ended by the signal the hook's cleanup aborts",
      },
      {
        kind: "file",
        repo: "anomalyco/opencode",
        ref: "v2",
        path: "packages/schema/src/location.ts",
        claims: [
          'export class Info extends Schema.Class<Info>("Location.Info")({',
          "directory: AbsolutePath,",
        ],
        note: "ctx.location.directory, the project the sync runs in",
      },
      {
        kind: "file",
        repo: "anomalyco/opencode",
        ref: "v2",
        path: "packages/schema/src/session-event.ts",
        claims: ['type: "session.created"'],
        note: "the session.created event",
      },
      {
        kind: "file",
        repo: "anomalyco/opencode",
        ref: "v2",
        path: "packages/plugin/src/runtime-modules.ts",
        claims: ['const runtimePackages = ["effect", "@opencode/plugin"] as const'],
        note: "the host serves @opencode/plugin to the plugin file, so nothing is installed for it",
      },
    ],
  },
  globalRoot: { default: ".config/opencode", env: { name: "XDG_CONFIG_HOME", subdir: "opencode" } },
  targets: {
    project: { kind: "shared-block", file: "AGENTS.md" },
    global: { kind: "shared-block", file: "AGENTS.md" },
  },
  bodiesDir: { project: ".agents/memories", global: null },
  markers: "counted",
  expands: ["none"],
  detect: { dirs: ["."] },
  // `setup` returns before the event loop starts, since OpenCode awaits it before serving the
  // prompt; the subscription is detached and the cleanup ends it. The sync runs in the plugin's
  // location, since a server hosts projects it was not started in, through the platform shell
  // with no pipes and unreferenced, so an offline npx is not a plugin error and a slow one never
  // holds the host.
  hook: {
    kind: "file",
    path: { project: ".opencode/plugins/maxims.ts", global: "plugins/maxims.ts" },
    contentTemplate: [
      "// Written by maxims. It runs the maxims sync when OpenCode activates this plugin and again",
      "// whenever a session is created, so the rule files stay current. maxims rewrites this file",
      "// on every sync while a source in its state still wants a hook for OpenCode; removing the",
      "// last such source deletes it.",
      'import { spawn } from "node:child_process";',
      'import { Plugin } from "@opencode/plugin";',
      "",
      "const sync = (cwd: string) =>",
      '  spawn("{{command}}", { cwd, shell: true, stdio: "ignore" })',
      '    .on("error", () => {})',
      "    .unref();",
      "",
      "export default Plugin.define({",
      '  id: "maxims",',
      "  setup: (ctx) => {",
      "    const stop = new AbortController();",
      "    const cwd = ctx.location.directory;",
      "    sync(cwd);",
      "    void (async () => {",
      "      for await (const event of ctx.event.subscribe({ signal: stop.signal })) {",
      '        if (event.type === "session.created") sync(cwd);',
      "      }",
      "    })().catch(() => {});",
      "    return () => stop.abort();",
      "  },",
      "});",
      "",
    ].join("\n"),
    executable: false,
    stdout: "none",
  },
} satisfies HarnessSpec;

export const opencode = toDefinition(spec);
