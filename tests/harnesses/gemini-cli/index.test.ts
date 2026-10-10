// Guards the unit Gemini CLI reads `timeout` in: milliseconds, unlike every other registry. A
// handler that copied the shared seconds value through would give sync 20ms before Gemini killed
// it, and the only symptom would be rules that never refresh. Pinned as the bytes a fresh
// settings.json receives.
import { expect, test } from "bun:test";
import type { Scope } from "../../../src/harnesses/contract.ts";
import { geminiCli } from "../../../src/harnesses/gemini-cli/spec.ts";
import { hasHook, planHookRegistryWrite } from "../../../src/harnesses/hook-writer.ts";
import { assertInsideRoot } from "../../../src/util/fs.ts";
import { exampleContext as ctx } from "../context.ts";

const registries: [Scope, string, string][] = [
  ["project", "/home/user/project", "/home/user/project/.gemini/settings.json"],
  ["global", "/home/user", "/home/user/.gemini/settings.json"],
];

test.each(registries)(
  "a fresh %s settings.json receives the handler with the timeout in milliseconds and no async field",
  (scope, root, path) => {
    if (!hasHook(geminiCli, "registry")) throw new Error("the hook is a registry entry");
    const plan = planHookRegistryWrite({
      def: geminiCli,
      scope,
      ctx,
      wanted: true,
      currentText: null,
    });
    expect(plan.changes).toEqual([
      {
        kind: "write",
        path: assertInsideRoot(root, path),
        content: [
          "{",
          '  "hooks": {',
          '    "SessionStart": [',
          "      {",
          '        "hooks": [',
          "          {",
          '            "name": "maxims-sync",',
          '            "type": "command",',
          '            "command": "npx -y @vivswan/maxims sync --quiet",',
          '            "timeout": 20000',
          "          }",
          "        ]",
          "      }",
          "    ]",
          "  }",
          "}",
          "",
        ].join("\n"),
      },
    ]);
  },
);
