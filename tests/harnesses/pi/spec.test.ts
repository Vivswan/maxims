// Guards the extension file Pi loads: the default export takes the extension API, and
// `session_start` runs the sync through `pi.exec` with an argv (not a shell string) and a
// millisecond timeout inside a try, so an offline npx never becomes an extension error.
import { expect, test } from "bun:test";
import { hookSpecFor } from "../../../src/harnesses/contract.ts";
import { pi } from "../../../src/harnesses/pi/spec.ts";

test("the extension file is written byte for byte as Pi loads it", () => {
  if (pi.hook.kind !== "file") throw new Error("expected a file hook");
  expect(pi.hook.render(hookSpecFor(pi))).toBe(
    [
      "// Written by maxims. It runs the maxims sync whenever a Pi session starts so the rule files",
      "// stay current. maxims rewrites this file on every sync while a source in its state still",
      "// wants a hook for Pi; removing the last such source deletes it.",
      'import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";',
      "",
      "export default function (pi: ExtensionAPI) {",
      '  pi.on("session_start", async () => {',
      '    const [command, ...args] = ["npx","-y","@vivswan/maxims","sync","--quiet"];',
      "    try {",
      "      await pi.exec(command, args, { timeout: 20000 });",
      "    } catch {",
      "      // An offline npx is not an extension error; the rules keep their last synced state.",
      "    }",
      "  });",
      "}",
      "",
    ].join("\n"),
  );
});
