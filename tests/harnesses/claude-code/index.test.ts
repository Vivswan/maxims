// Pins the bytes Claude Code itself reads: the SessionStart entry a fresh settings.json receives
// and the one appended beside a hand-formatted user's hooks, the rule file with and without its
// `paths:` frontmatter, and the `disableAllHooks` demotion. Claude Code enforces none of these for
// us, so a drift here would install silently and load nothing.
import { describe, expect, test } from "bun:test";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { claudeCode } from "../../../src/harnesses/claude-code/spec.ts";
import type { HarnessContext, Scope, SourceSlug } from "../../../src/harnesses/contract.ts";
import {
  achievedTier,
  hasHook,
  planHookRegistryWrite,
} from "../../../src/harnesses/hook-writer.ts";
import { planRulesDirWrite } from "../../../src/harnesses/strategies/rules-dir.ts";
import { assertInsideRoot } from "../../../src/util/fs.ts";
import { srcPath } from "../../shared/src_path.ts";
import { withTempDir } from "../../shared/temp_dir.ts";
import { exampleContext as ctx } from "../context.ts";

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
    expect(
      planRulesDirWrite({
        def: claudeCode,
        target: rulesDir(scope),
        scope,
        ctx,
        sourceSlug: "example-user-doctrine" as SourceSlug,
        block,
      }),
    ).toEqual([{ kind: "write", path: assertInsideRoot(root, path), content: block }]);
  });

  test("a path-scoped rule file opens with the paths frontmatter Claude Code reads", () => {
    const [change] = planRulesDirWrite({
      def: claudeCode,
      target: rulesDir("project"),
      scope: "project",
      ctx,
      sourceSlug: "example-user-doctrine" as SourceSlug,
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

  // Claude Code reads `disableAllHooks` after settings precedence applies, so a `true` in the user
  // settings silences a project hook too unless the project's own settings say `false`, and the
  // local settings file outranks both. A per-scope read of one file would call a project install
  // tier 1 while every hook on the machine is off.
  const off = '{ "disableAllHooks": true }\n';
  const on = '{ "disableAllHooks": false }\n';
  const silent = '{ "model": "opus" }\n';
  const layers: [string, string | null, string | null, string | null, 1 | 2][] = [
    ["user off, project silent", null, silent, off, 2],
    ["user off, project absent", null, null, off, 2],
    ["project on over a user off", null, on, off, 1],
    ["project off over a user on", null, off, on, 2],
    ["local on over project off", on, off, off, 1],
    ["local off over project on", off, on, on, 2],
    ["nothing set anywhere", null, silent, silent, 1],
  ];

  test.each(layers)(
    "disableAllHooks is read after settings precedence: local, project, then user (%s)",
    async (_, localJson, projectJson, userJson, expected) => {
      await withTempDir(async (dir) => {
        const home = join(dir, "home");
        const project = join(dir, "project");
        mkdirSync(join(home, ".claude"), { recursive: true });
        mkdirSync(join(project, ".claude"), { recursive: true });
        const write = (path: string, text: string | null): void => {
          if (text !== null) writeFileSync(path, text);
        };
        write(join(project, ".claude", "settings.local.json"), localJson);
        write(join(project, ".claude", "settings.json"), projectJson);
        write(join(home, ".claude", "settings.json"), userJson);
        const layered: HarnessContext = { home, projectRoot: project, env: {} };
        for (const scope of ["project", "global"] as const) {
          expect(await achievedTier(claudeCode, scope, layered)).toEqual({
            tier: expected,
            unreadable: null,
          });
        }
      });
    },
  );

  // A layer that does not parse is not a layer that sets nothing: wherever it sits in the walk, the
  // reading is the reason, so a valid setting in another layer never passes for the machine's
  // answer. Below a deciding project layer it is the user file the global hook is registered in:
  // Claude Code skips a broken settings file, so that hook never runs whatever the project says.
  const broken: [string, string | null, string | null, string | null, string][] = [
    [
      "project broken over a user on",
      null,
      "{ this is not json\n",
      on,
      "project/.claude/settings.json",
    ],
    [
      "user broken under a project on",
      null,
      on,
      "{ this is not json\n",
      "home/.claude/settings.json",
    ],
    [
      "user broken under a local on",
      on,
      null,
      "{ this is not json\n",
      "home/.claude/settings.json",
    ],
  ];

  test.each(broken)(
    "a malformed settings.json is tier 2 with the reason, whichever other layer sets the key (%s)",
    async (_, localJson, projectJson, userJson, brokenFile) => {
      await withTempDir(async (dir) => {
        const home = join(dir, "home");
        const project = join(dir, "project");
        mkdirSync(join(home, ".claude"), { recursive: true });
        mkdirSync(join(project, ".claude"), { recursive: true });
        const write = (path: string, text: string | null): void => {
          if (text !== null) writeFileSync(path, text);
        };
        write(join(project, ".claude", "settings.local.json"), localJson);
        write(join(project, ".claude", "settings.json"), projectJson);
        write(join(home, ".claude", "settings.json"), userJson);
        const layered: HarnessContext = { home, projectRoot: project, env: {} };
        for (const scope of ["project", "global"] as const) {
          expect(await achievedTier(claudeCode, scope, layered)).toEqual({
            tier: 2,
            unreadable: `settings.json could not be read (${join(dir, brokenFile)}: InvalidSymbol at offset 2); assuming hooks off`,
          });
        }
      });
    },
  );
});
