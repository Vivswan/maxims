// Guards the unit Gemini CLI reads `timeout` in: milliseconds, unlike every other registry. A
// handler that copied the shared seconds value through would give sync 20ms before Gemini killed
// it, and the only symptom would be rules that never refresh. Pinned as the bytes a fresh
// settings.json receives, beside the files Gemini reads them from and its `.gemini` detection.
import { expect, test } from "bun:test";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import type { HarnessContext, Scope } from "../../../src/harnesses/contract.ts";
import { geminiCli } from "../../../src/harnesses/gemini-cli/index.ts";
import { hasHook, planHookRegistryWrite } from "../../../src/harnesses/hook-writer.ts";
import { planSharedBlockWrite } from "../../../src/harnesses/strategies/shared-block.ts";
import { assertInsideRoot } from "../../../src/util/fs.ts";
import { withTempDir } from "../../shared/temp_dir.ts";

const ctx: HarnessContext = { home: "/home/user", projectRoot: "/home/user/project", env: {} };

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

const blocks: [Scope, string, string][] = [
  ["project", "/home/user/project", "/home/user/project/GEMINI.md"],
  ["global", "/home/user", "/home/user/.gemini/GEMINI.md"],
];

test.each(blocks)("the %s block is written to the GEMINI.md Gemini loads", (scope, root, path) => {
  const target = geminiCli.targets[scope];
  if (target?.kind !== "shared-block") throw new Error("GEMINI.md is a shared block");
  const block =
    "<!-- maxims:begin @example-user/doctrine sha=1 -->\n<!-- maxims:end @example-user/doctrine -->\n";
  const [change] = planSharedBlockWrite({
    def: geminiCli,
    target,
    scope,
    ctx,
    source: "@example-user/doctrine",
    currentText: null,
    block,
  });
  expect(change).toEqual({ kind: "write", path: assertInsideRoot(root, path), content: block });
});

test("detection reads a ~/.gemini directory and nothing else", async () => {
  await withTempDir((home) => {
    const local: HarnessContext = { home, projectRoot: null, env: {} };
    expect(geminiCli.detect(local)).toBe(false);
    mkdirSync(join(home, ".gemini"));
    expect(geminiCli.detect(local)).toBe(true);
  });
});
