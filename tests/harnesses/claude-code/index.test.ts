// Pins the bytes Claude Code itself reads: the SessionStart entry a fresh settings.json receives
// and the one appended beside a hand-formatted user's hooks, the rule file with and without its
// `paths:` frontmatter, the `disableAllHooks` demotion, and the detection signals. Claude Code
// enforces none of these for us, so a drift here would install silently and load nothing.
import { describe, expect, test } from "bun:test";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { claudeCode } from "../../../src/harnesses/claude-code/index.ts";
import type { HarnessContext, Scope } from "../../../src/harnesses/contract.ts";
import {
  achievedTier,
  hasHook,
  planHookRegistryWrite,
} from "../../../src/harnesses/hook-writer.ts";
import { planRulesDirWrite } from "../../../src/harnesses/strategies/rules-dir.ts";
import { assertInsideRoot } from "../../../src/util/fs.ts";
import { srcPath } from "../../shared/src_path.ts";
import { withTempDir } from "../../shared/temp_dir.ts";

const ctx: HarnessContext = { home: "/home/user", projectRoot: "/home/user/project", env: {} };
const block =
  "<!-- maxims:begin @example-user/doctrine sha=1 -->\n<!-- maxims:end @example-user/doctrine -->\n";

const handlerLines = [
  "          {",
  '            "type": "command",',
  '            "command": "npx -y @vivswan/maxims sync --quiet",',
  '            "async": true,',
  '            "timeout": 20,',
  '            "statusMessage": "Syncing maxims"',
  "          }",
];

function rulesDir(scope: Scope) {
  const target = claudeCode.targets[scope];
  if (target?.kind !== "rules-dir") throw new Error("the target is a rules directory");
  return target;
}

describe("claude-code", () => {
  test("a fresh settings.json receives the documented async SessionStart command entry", () => {
    if (!hasHook(claudeCode, "registry")) throw new Error("the hook is a registry entry");
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
        path: assertInsideRoot(ctx.home, "/home/user/.claude/settings.json"),
        content: [
          "{",
          '  "hooks": {',
          '    "SessionStart": [',
          "      {",
          '        "hooks": [',
          ...handlerLines,
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

  // A user's settings carry their own matcher-scoped SessionStart group; ours is appended as a
  // second, matcher-less group so theirs keeps its matcher and every other byte stays.
  test("a hand-formatted settings.json gains one matcher-less group after the user's own", () => {
    if (!hasHook(claudeCode, "registry")) throw new Error("the hook is a registry entry");
    const fixture = readFileSync(
      srcPath("harnesses", "claude-code", "fixtures", "settings.json"),
      "utf8",
    );
    const plan = planHookRegistryWrite({
      def: claudeCode,
      scope: "project",
      ctx,
      wanted: true,
      currentText: fixture,
    });
    const before = ["        ]", "      }", "    ],", '    "PreToolUse": ['].join("\n");
    const after = [
      "        ]",
      "      },",
      "      {",
      '        "hooks": [',
      ...handlerLines,
      "        ]",
      "      }",
      "    ],",
      '    "PreToolUse": [',
    ].join("\n");
    expect(fixture.split(before)).toHaveLength(2);
    expect(plan.changes).toEqual([
      {
        kind: "write",
        path: assertInsideRoot("/home/user/project", "/home/user/project/.claude/settings.json"),
        content: fixture.replace(before, after),
      },
    ]);
  });

  const ruleFiles: [Scope, string, string][] = [
    [
      "project",
      "/home/user/project",
      "/home/user/project/.claude/rules/maxims-example-user-doctrine.md",
    ],
    ["global", "/home/user", "/home/user/.claude/rules/maxims-example-user-doctrine.md"],
  ];

  // `.claude/rules/**/*.md` loads at launch with no frontmatter, so an always-on file is the block
  // alone; a preamble would be injected as rule text.
  test.each(ruleFiles)("the %s always-on rule file is the bare block", (scope, root, path) => {
    for (const paths of [undefined, []]) {
      expect(
        planRulesDirWrite({
          def: claudeCode,
          target: rulesDir(scope),
          scope,
          ctx,
          sourceSlug: "example-user-doctrine",
          block,
          paths,
        }),
      ).toEqual([{ kind: "write", path: assertInsideRoot(root, path), content: block }]);
    }
  });

  test("a path-scoped rule file opens with the paths frontmatter Claude Code reads", () => {
    const [change] = planRulesDirWrite({
      def: claudeCode,
      target: rulesDir("project"),
      scope: "project",
      ctx,
      sourceSlug: "example-user-doctrine",
      block,
      paths: ["src/**/*.ts", "docs: notes/*.md"],
    });
    expect(change).toEqual({
      kind: "write",
      path: assertInsideRoot(
        ctx.home,
        "/home/user/project/.claude/rules/maxims-example-user-doctrine.md",
      ),
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
      expect(await achievedTier(claudeCode, "global", local)).toEqual({
        tier: 1,
        unreadable: null,
      });
      writeFileSync(join(home, ".claude", "settings.json"), '{ "disableAllHooks": true }\n');
      expect(await achievedTier(claudeCode, "global", local)).toEqual({
        tier: 2,
        unreadable: null,
      });
      writeFileSync(join(home, ".claude", "settings.json"), '{ "disableAllHooks": false }\n');
      expect(await achievedTier(claudeCode, "global", local)).toEqual({
        tier: 1,
        unreadable: null,
      });
    });
  });

  test("detection sees either session variable or a ~/.claude directory, never a stray file there", async () => {
    await withTempDir((home) => {
      const bare: HarnessContext = { home, projectRoot: null, env: {} };
      expect(claudeCode.detect(bare)).toBe(false);
      expect(claudeCode.detect({ ...bare, env: { CLAUDECODE: "1" } })).toBe(true);
      expect(claudeCode.detect({ ...bare, env: { CLAUDE_CODE_ENTRYPOINT: "cli" } })).toBe(true);
      writeFileSync(join(home, ".claude"), "");
      expect(claudeCode.detect(bare)).toBe(false);
      rmSync(join(home, ".claude"));
      mkdirSync(join(home, ".claude"));
      expect(claudeCode.detect(bare)).toBe(true);
    });
  });
});
