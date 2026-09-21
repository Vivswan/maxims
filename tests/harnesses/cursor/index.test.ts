// Guards the Cursor facts nothing else enforces: a rule file is loaded only as `.mdc` whose
// frontmatter says `alwaysApply: true`, a path-scoped one swaps that flag for `globs`, a project
// hook lands in the project's own versioned `.cursor/hooks.json` rather than the user's and slots
// beside the user's other events, and only a `.cursor` directory counts as an install. All pinned
// as the bytes the writers emit.
import { expect, test } from "bun:test";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { HarnessContext, Scope } from "../../../src/harnesses/contract.ts";
import { cursor } from "../../../src/harnesses/cursor/index.ts";
import { hasHook, planHookRegistryWrite } from "../../../src/harnesses/hook-writer.ts";
import { planRulesDirWrite } from "../../../src/harnesses/strategies/rules-dir.ts";
import { ExitCode, MaximsError } from "../../../src/util/exit-codes.ts";
import { assertInsideRoot } from "../../../src/util/fs.ts";
import { srcPath } from "../../shared/src_path.ts";
import { withTempDir } from "../../shared/temp_dir.ts";

const ctx: HarnessContext = { home: "/home/user", projectRoot: "/home/user/project", env: {} };
const block =
  "<!-- maxims:begin @example-user/doctrine sha=1 -->\n<!-- maxims:end @example-user/doctrine -->\n";
const rulePath = "/home/user/project/.cursor/rules/maxims-example-user-doctrine.mdc";

const alwaysOn = [
  "---",
  "description: Rule memories installed by maxims",
  "alwaysApply: true",
  "---",
];
const scoped = [
  "---",
  "description: Rule memories installed by maxims",
  "globs:",
  "  - src/**/*.ts",
  '  - "docs: notes/*.md"',
  "alwaysApply: false",
  "---",
];

const ruleFiles: [string, string[] | undefined, string[]][] = [
  ["no paths", undefined, alwaysOn],
  ["an empty paths list", [], alwaysOn],
  ["paths", ["src/**/*.ts", "docs: notes/*.md"], scoped],
];

test.each(ruleFiles)(
  "the project rule is an .mdc whose frontmatter Cursor reads (%s)",
  (_, paths, preamble) => {
    const target = cursor.targets.project;
    if (target?.kind !== "rules-dir") throw new Error("Cursor writes a rules directory");
    expect(
      planRulesDirWrite({
        def: cursor,
        target,
        scope: "project",
        ctx,
        sourceSlug: "example-user-doctrine",
        block,
        paths,
      }),
    ).toEqual([
      {
        kind: "write",
        path: assertInsideRoot("/home/user/project", rulePath),
        content: `${preamble.join("\n")}\n${block}`,
      },
    ]);
  },
);

const handlerLines = [
  "      {",
  '        "type": "command",',
  '        "command": "npx -y @vivswan/maxims sync --quiet",',
  '        "timeout": 20',
  "      }",
];

const registries: [Scope, string, string][] = [
  ["project", "/home/user/project", "/home/user/project/.cursor/hooks.json"],
  ["global", "/home/user", "/home/user/.cursor/hooks.json"],
];

test.each(registries)(
  "a fresh %s hooks.json is versioned and carries one ungrouped command entry in seconds",
  (scope, root, path) => {
    if (!hasHook(cursor, "registry")) throw new Error("Cursor registers a command hook");
    const plan = planHookRegistryWrite({
      def: cursor,
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
          '  "version": 1,',
          '  "hooks": {',
          '    "sessionStart": [',
          ...handlerLines,
          "    ]",
          "  }",
          "}",
          "",
        ].join("\n"),
      },
    ]);
  },
);

test("a hand-formatted hooks.json gains the sessionStart list after the user's other events", () => {
  if (!hasHook(cursor, "registry")) throw new Error("Cursor registers a command hook");
  const fixture = readFileSync(srcPath("harnesses", "cursor", "fixtures", "config.json"), "utf8");
  const plan = planHookRegistryWrite({
    def: cursor,
    scope: "project",
    ctx,
    wanted: true,
    currentText: fixture,
  });
  const before = ["    ]", "  }", "}", ""].join("\n");
  const after = ["    ],", '    "sessionStart": [', ...handlerLines, "    ]", "  }", "}", ""].join(
    "\n",
  );
  expect(fixture.endsWith(before)).toBe(true);
  expect(plan.changes).toEqual([
    {
      kind: "write",
      path: assertInsideRoot("/home/user/project", "/home/user/project/.cursor/hooks.json"),
      content: `${fixture.slice(0, -before.length)}${after}`,
    },
  ]);
});

test("a project hook with no project root is a usage error, not a write into the home", () => {
  if (!hasHook(cursor, "registry")) throw new Error("Cursor registers a command hook");
  let caught: unknown;
  try {
    cursor.hook.path("project", { ...ctx, projectRoot: null });
  } catch (error) {
    caught = error;
  }
  expect(caught).toBeInstanceOf(MaximsError);
  expect(caught).toMatchObject({ code: ExitCode.Usage });
});

test("detection reads a ~/.cursor directory and never a stray file of that name", async () => {
  await withTempDir((home) => {
    const local: HarnessContext = { home, projectRoot: null, env: {} };
    expect(cursor.detect(local)).toBe(false);
    writeFileSync(join(home, ".cursor"), "");
    expect(cursor.detect(local)).toBe(false);
  });
  await withTempDir((home) => {
    mkdirSync(join(home, ".cursor"));
    expect(cursor.detect({ home, projectRoot: null, env: {} })).toBe(true);
  });
});
