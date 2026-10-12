// Guards the one OpenCode artifact that would drift silently: the plugin file's bytes. OpenCode
// 2.0 loads a plugin only as a default export of `@opencode/plugin`'s `define` shape with an id
// and a `setup`, and ignores any other module in its plugins directory without a word, so the
// 1.x `event` hook shape (the regression that motivated the rewrite) never ran the sync.
import { expect, test } from "bun:test";
import { hasHook, planFileHookWrite } from "../../../src/harnesses/hook-writer.ts";
import { opencode } from "../../../src/harnesses/opencode/spec.ts";
import { assertInsideRoot } from "../../../src/util/fs.ts";
import { exampleContext as ctx } from "../context.ts";

// `setup` returns before the event loop starts, since OpenCode awaits it before it serves the
// prompt; the subscription is detached and the cleanup ends it. The sync child runs in the
// plugin's location, not the host's working directory, through the platform shell with no pipes
// and unreferenced, so an offline npx is not a plugin error and a slow one never holds the host.
test("the plugin file is written byte for byte as OpenCode 2.0 loads it", () => {
  if (!hasHook(opencode, "file")) throw new Error("OpenCode writes a plugin file");
  const [written] = planFileHookWrite({
    def: opencode,
    scope: "project",
    ctx,
    wanted: true,
    current: null,
  }).changes;
  expect(written).toEqual({
    kind: "write",
    path: assertInsideRoot("/home/user/project", "/home/user/project/.opencode/plugins/maxims.ts"),
    content: [
      "// Written by maxims. It runs the maxims sync when OpenCode activates this plugin and again",
      "// whenever a session is created, so the rule files stay current. maxims rewrites this file",
      "// on every sync while a source in its state still wants a hook for OpenCode; removing the",
      "// last such source deletes it.",
      'import { spawn } from "node:child_process";',
      'import { Plugin } from "@opencode/plugin";',
      "",
      "const sync = (cwd: string) =>",
      '  spawn("npx -y @vivswan/maxims sync --quiet", { cwd, shell: true, stdio: "ignore" })',
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
  });
});
