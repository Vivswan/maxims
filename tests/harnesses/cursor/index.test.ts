// Guards the Cursor facts nothing else enforces: a rule file is loaded only as `.mdc` whose
// frontmatter says `alwaysApply: true`, a path-scoped one swaps that flag for `globs`, and a
// project hook lands in the project's own versioned `.cursor/hooks.json` rather than the user's
// and slots beside the user's other events. All pinned as the bytes the writers emit.
import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import type { Scope, SourceSlug } from "../../../src/harnesses/contract.ts";
import { cursor } from "../../../src/harnesses/cursor/spec.ts";
import { hasHook, planHookRegistryWrite } from "../../../src/harnesses/hook-writer.ts";
import { planRulesDirWrite } from "../../../src/harnesses/strategies/rules-dir.ts";
import { renderBlock } from "../../../src/rulefile/block.ts";
import { assertInsideRoot } from "../../../src/util/fs.ts";
import { memoryName } from "../../engine/fakes.ts";
import { srcPath } from "../../shared/src_path.ts";
import { exampleContext as ctx } from "../context.ts";

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
        sourceSlug: "example-user-doctrine" as SourceSlug,
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

// Cursor's rules page states that rule content reaches the agent as written and an `@file`
// mention is not inlined, so a rule line is not rewritten around an `@` token the way it is for a
// harness that expands imports at load; the user's own code span survives byte for byte.
test("a rule line keeps an @ mention and the code span around it literal", () => {
  const rendered = renderBlock({
    source: "@example-user/doctrine",
    sha: "1",
    lines: [
      {
        name: memoryName("install-skills-first"),
        description: "Install the team skills with `npx skills add @octocat/skills` first.",
        detailPath: ".agents/memories/install-skills-first.md",
        shortHash: "a1b2c3d",
      },
    ],
    markers: cursor.markers,
    expands: cursor.expands,
    selfRefresh: false,
  });
  expect(rendered.split("\n")[1]).toBe(
    "- Install the team skills with `npx skills add @octocat/skills` first. (detail: .agents/memories/install-skills-first.md, a1b2c3d)",
  );
});
