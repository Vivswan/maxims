// Guards the plugin file Amp loads: a default export taking the plugin API, a `session.start`
// listener, and the sync run through the API's shell inside a try so an offline npx never becomes
// a plugin error.
import { expect, test } from "bun:test";
import { amp } from "../../../src/harnesses/amp/spec.ts";
import { hookSpecFor } from "../../../src/harnesses/contract.ts";

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
});
