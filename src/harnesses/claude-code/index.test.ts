// Pins the bytes Claude Code itself reads: the SessionStart entry a fresh settings.json receives,
// the `paths:` frontmatter of a path-scoped rule file, and the two detection signals. Claude Code
// enforces none of these for us, so a drift here would install silently and load nothing.
import { describe, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { withTempDir } from "../../../tests/shared/temp_dir.ts";
import type { HarnessContext } from "../contract.ts";
import { achievedTier, planHookRegistryWrite } from "../hook-writer.ts";
import { planRulesDirWrite } from "../strategies/rules-dir.ts";
import { claudeCode } from "./index.ts";

const ctx: HarnessContext = { home: "/home/user", projectRoot: "/home/user/project", env: {} };

describe("claude-code", () => {
  test("a fresh settings.json receives the documented async SessionStart command entry", () => {
    const plan = planHookRegistryWrite({
      def: claudeCode,
      scope: "global",
      ctx,
      wanted: true,
      currentText: null,
    });
    expect(plan.changes).toEqual([
      {
        kind: "write",
        path: "/home/user/.claude/settings.json",
        content: [
          "{",
          '  "hooks": {',
          '    "SessionStart": [',
          "      {",
          '        "hooks": [',
          "          {",
          '            "type": "command",',
          '            "command": "npx -y maxims sync --quiet",',
          '            "async": true,',
          '            "timeout": 20,',
          '            "statusMessage": "Syncing maxims"',
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
  });

  test("a path-scoped rule file opens with the paths frontmatter Claude Code reads", () => {
    const [change] = planRulesDirWrite({
      def: claudeCode,
      target: claudeCode.targets.project,
      scope: "project",
      ctx,
      sourceSlug: "example-user-doctrine",
      block:
        "<!-- maxims:begin @example-user/doctrine sha=1 -->\n<!-- maxims:end @example-user/doctrine -->\n",
      paths: ["src/**/*.ts", "docs: notes/*.md"],
    });
    expect(change).toEqual({
      kind: "write",
      path: "/home/user/project/.claude/rules/maxims-example-user-doctrine.md",
      content: [
        "---",
        "paths:",
        "  - src/**/*.ts",
        '  - "docs: notes/*.md"',
        "---",
        "<!-- maxims:begin @example-user/doctrine sha=1 -->",
        "<!-- maxims:end @example-user/doctrine -->",
        "",
      ].join("\n"),
    });
  });

  test("disableAllHooks in settings.json demotes the achieved tier to 2", async () => {
    await withTempDir(async (home) => {
      const local: HarnessContext = { home, projectRoot: null, env: {} };
      mkdirSync(join(home, ".claude"));
      expect(await achievedTier(claudeCode, "global", local)).toBe(1);
      writeFileSync(join(home, ".claude", "settings.json"), '{ "disableAllHooks": true }\n');
      expect(await achievedTier(claudeCode, "global", local)).toBe(2);
      writeFileSync(join(home, ".claude", "settings.json"), '{ "disableAllHooks": false }\n');
      expect(await achievedTier(claudeCode, "global", local)).toBe(1);
    });
  });

  test("detection sees the session variable or a ~/.claude directory, and nothing else", async () => {
    await withTempDir((home) => {
      const bare: HarnessContext = { home, projectRoot: null, env: {} };
      expect(claudeCode.detect(bare)).toBe(false);
      expect(claudeCode.detect({ ...bare, env: { CLAUDECODE: "1" } })).toBe(true);
      mkdirSync(join(home, ".claude"));
      expect(claudeCode.detect(bare)).toBe(true);
    });
  });
});
