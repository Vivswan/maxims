// Guards the plugin file Amp loads: a default export taking the plugin API, a `session.start`
// listener, and the sync run through the API's shell inside a try so an offline npx never becomes
// a plugin error. Also guards that a directory holding only AGENT.md or CLAUDE.md gets the block
// there, since Amp reads those only while no AGENTS.md exists and creating one would drop the
// user's file from Amp's context.
import { expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { withTempDir } from "../../../tests/shared/temp_dir.ts";
import { hookSpecFor, sharedBlockFile } from "../contract.ts";
import { amp } from "./index.ts";

test("the plugin file is written byte for byte as Amp loads it", () => {
  if (amp.hook.kind !== "file") throw new Error("expected a file hook");
  expect(amp.hook.render(hookSpecFor(amp))).toBe(
    [
      "// Written by maxims. It runs the maxims sync whenever an Amp session starts so the rule",
      "// files stay current. maxims rewrites this file on every sync while a source in its state",
      "// still wants a hook for Amp; removing the last such source deletes it.",
      'import type { PluginAPI } from "@ampcode/plugin";',
      "",
      "export default function (amp: PluginAPI) {",
      '  amp.on("session.start", async () => {',
      "    try {",
      "      await amp.$`npx -y @vivswan/maxims sync --quiet`;",
      "    } catch {",
      "      // An offline npx is not a plugin error; the rules keep their last synced state.",
      "    }",
      "  });",
      "}",
      "",
    ].join("\n"),
  );
  const ctx = { home: resolve("/home/user"), projectRoot: resolve("/home/user/project"), env: {} };
  expect(amp.hook.path("global", ctx)).toBe(resolve("/home/user/.config/amp/plugins/maxims.ts"));
  expect(amp.hook.path("project", ctx)).toBe(resolve("/home/user/project/.amp/plugins/maxims.ts"));
  expect(amp.mcp?.path("global", ctx)).toBe(resolve("/home/user/.config/amp/settings.json"));
});

test("a project with only a fallback instructions file keeps it as the block's home", async () => {
  const target = amp.targets.project;
  if (target?.kind !== "shared-block") throw new Error("expected a shared block");
  await withTempDir((repo) => {
    expect(sharedBlockFile(target, repo)).toBe("AGENTS.md");
    writeFileSync(join(repo, "CLAUDE.md"), "");
    expect(sharedBlockFile(target, repo)).toBe("CLAUDE.md");
    writeFileSync(join(repo, "AGENT.md"), "");
    expect(sharedBlockFile(target, repo)).toBe("AGENT.md");
    writeFileSync(join(repo, "AGENTS.md"), "");
    expect(sharedBlockFile(target, repo)).toBe("AGENTS.md");
  });
});
