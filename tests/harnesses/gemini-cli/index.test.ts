// Guards the unit Gemini CLI reads `timeout` in: milliseconds, unlike every other registry. A
// handler that copied the shared seconds value through would give sync 20ms before Gemini killed
// it, and the only symptom would be rules that never refresh. Pinned as the bytes a fresh
// settings.json receives.
import { expect, test } from "bun:test";
import type { Scope } from "../../../src/harnesses/contract.ts";
import { geminiCli } from "../../../src/harnesses/gemini-cli/spec.ts";
import { hasHook, planHookRegistryWrite } from "../../../src/harnesses/hook-writer.ts";
import { ExitCode } from "../../../src/util/exit-codes.ts";
import { assertInsideRoot } from "../../../src/util/fs.ts";
import { outcome } from "../../shared/outcome.ts";
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

// Gemini CLI strips comments from settings.json before `JSON.parse`, so a commented file loads and
// a hook goes into it with the comment kept, while a trailing comma is a file Gemini reports and
// skips, so it is refused: a judgment copied from Claude Code's strict JSON would refuse the
// commented file a Gemini user legitimately keeps.
test("a commented settings.json receives the hook and a trailing comma is refused as Gemini reads it", () => {
  const def = geminiCli;
  if (!hasHook(def, "registry")) throw new Error("the hook is a registry entry");
  const commented = '{\n  // mine\n  "theme": "dark"\n}\n';
  const [change] = planHookRegistryWrite({
    def,
    scope: "project",
    ctx,
    wanted: true,
    currentText: commented,
  }).changes;
  if (change?.kind !== "write") throw new Error("expected a write");
  expect(change.content).toContain("  // mine\n");
  expect(change.content).toContain('"command": "npx -y @vivswan/maxims sync --quiet"');
  const verdict = outcome(() =>
    planHookRegistryWrite({
      def,
      scope: "project",
      ctx,
      wanted: true,
      currentText: '{\n  "theme": "dark",\n}\n',
    }),
  );
  expect(verdict).toMatchObject({
    kind: "threw",
    error: {
      name: "MaximsError",
      code: ExitCode.DestinationWriteFailed,
      message: `cannot edit ${assertInsideRoot("/home/user/project", "/home/user/project/.gemini/settings.json")}: a trailing comma at line 2, column 18; Gemini CLI reads JSON with comments and no trailing commas`,
    },
  });
});
