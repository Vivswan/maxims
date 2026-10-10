// Strategy A owns the file a harness loads: a frontmatter chosen from the wrong declaration, a
// slug that escapes the rules directory, or a rules directory that leaves the project would each
// load nothing.
import { describe, expect, test } from "bun:test";
import { mkdirSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import type {
  HarnessContext,
  HarnessDefinition,
  Scope,
  SourceSlug,
} from "../../../src/harnesses/contract.ts";
import {
  planRulesDirRemove,
  planRulesDirWrite,
  type RulesDirTarget,
} from "../../../src/harnesses/strategies/rules-dir.ts";
import { ExitCode } from "../../../src/util/exit-codes.ts";
import { assertInsideRoot } from "../../../src/util/fs.ts";
import { outcome } from "../../shared/outcome.ts";
import { withTempDir } from "../../shared/temp_dir.ts";
import { exampleContext as ctx } from "../context.ts";

const rooted = (path: string) => assertInsideRoot(ctx.home, path);
const block = "<!-- maxims:begin @a/b sha=1 -->\n- rule\n<!-- maxims:end @a/b -->\n";

function definition(overrides: Partial<HarnessDefinition> = {}): HarnessDefinition {
  return {
    id: "cursor",
    displayName: "Example",
    tier: 1,
    targets: { project: null, global: null },
    bodiesDir: () => null,
    hook: { kind: "none" },
    markers: "counted",
    expands: ["none"],
    detect: () => false,
    verifiedAgainst: {
      date: "2026-09-20",
      sources: [
        { kind: "page", url: "https://example.com/docs", claims: ["hooks"], why: "a fixture" },
      ],
    },
    ...overrides,
  };
}

const plain: RulesDirTarget = {
  kind: "rules-dir",
  dir: ".claude/rules",
  fileName: (slug) => `maxims-${slug}.md`,
};
const declared: RulesDirTarget = {
  ...plain,
  dir: ".cursor/rules",
  fileName: (slug) => `maxims-${slug}.mdc`,
  frontmatter: ({ paths }) =>
    paths === undefined ? "---\nalwaysApply: true\n---" : `---\nglobs: ${paths.join(",")}\n---\n`,
};
const scoped = definition({
  scopeFrontmatter: (globs) => `---\npaths: [${globs.join(", ")}]\n---\n`,
});

const SLUG = "a-b" as SourceSlug;

describe("planRulesDirWrite", () => {
  const cases: {
    name: string;
    def: HarnessDefinition;
    target: RulesDirTarget;
    scope: Scope;
    paths?: string[];
    path: string;
    content: string;
  }[] = [
    {
      name: "no frontmatter declared and no paths writes the block alone under the project",
      def: scoped,
      target: plain,
      scope: "project",
      path: "/home/user/project/.claude/rules/maxims-a-b.md",
      content: block,
    },
    {
      name: "a global install resolves the same relative directory under the home",
      def: scoped,
      target: plain,
      scope: "global",
      path: "/home/user/.claude/rules/maxims-a-b.md",
      content: block,
    },
    {
      name: "paths without a target frontmatter use the definition's scope frontmatter",
      def: scoped,
      target: plain,
      scope: "project",
      paths: ["src/**", "docs/**"],
      path: "/home/user/project/.claude/rules/maxims-a-b.md",
      content: `---\npaths: [src/**, docs/**]\n---\n${block}`,
    },
    {
      name: "an empty paths list counts as no paths",
      def: scoped,
      target: plain,
      scope: "project",
      paths: [],
      path: "/home/user/project/.claude/rules/maxims-a-b.md",
      content: block,
    },
    {
      name: "a target frontmatter owns the preamble and gains the missing line break",
      def: scoped,
      target: declared,
      scope: "project",
      path: "/home/user/project/.cursor/rules/maxims-a-b.mdc",
      content: `---\nalwaysApply: true\n---\n${block}`,
    },
    {
      name: "a target frontmatter receives the paths instead of the scope frontmatter",
      def: scoped,
      target: declared,
      scope: "project",
      paths: ["src/**"],
      path: "/home/user/project/.cursor/rules/maxims-a-b.mdc",
      content: `---\nglobs: src/**\n---\n${block}`,
    },
    {
      name: "a budget naming only the project scope leaves a global file alone",
      def: definition({ byteBudget: { project: block.length - 1 } }),
      target: plain,
      scope: "global",
      path: "/home/user/.claude/rules/maxims-a-b.md",
      content: block,
    },
  ];

  test.each(cases)("$name", ({ def, target, scope, paths, path, content }) => {
    const changes = planRulesDirWrite({ def, target, scope, ctx, sourceSlug: SLUG, block, paths });
    expect(changes).toEqual([{ kind: "write", path: rooted(path), content }]);
    expect(planRulesDirRemove({ def, target, scope, ctx, sourceSlug: SLUG })).toEqual([
      { kind: "delete", path: rooted(path) },
    ]);
  });

  const refusals: { name: string; run: () => unknown; code: ExitCode }[] = [
    {
      name: "a project install with no project root",
      run: () =>
        planRulesDirWrite({
          def: scoped,
          target: plain,
          scope: "project",
          ctx: { ...ctx, projectRoot: null },
          sourceSlug: SLUG,
          block,
        }),
      code: ExitCode.Usage,
    },
    {
      name: "a file over the harness byte budget",
      run: () =>
        planRulesDirWrite({
          def: definition({ byteBudget: block.length - 1 }),
          target: plain,
          scope: "project",
          ctx,
          sourceSlug: SLUG,
          block,
        }),
      code: ExitCode.RuleCapExceeded,
    },
    {
      name: "a file over the budget its own scope names",
      run: () =>
        planRulesDirWrite({
          def: definition({ byteBudget: { project: block.length - 1 } }),
          target: plain,
          scope: "project",
          ctx,
          sourceSlug: SLUG,
          block,
        }),
      code: ExitCode.RuleCapExceeded,
    },
  ];

  test.each(refusals)("refuses $name", ({ run, code }) => {
    expect(outcome(run)).toMatchObject({ kind: "threw", error: { name: "MaximsError", code } });
  });

  test("a rules directory symlinked outside the project is refused, not followed", async () => {
    await withTempDir(async (dir) => {
      const project = join(dir, "project");
      const outside = join(dir, "outside");
      mkdirSync(join(project, ".claude"), { recursive: true });
      mkdirSync(outside);
      symlinkSync(outside, join(project, ".claude", "rules"));
      const local: HarnessContext = { ...ctx, projectRoot: project };
      const verdict = outcome(() =>
        planRulesDirWrite({
          def: scoped,
          target: plain,
          scope: "project",
          ctx: local,
          sourceSlug: SLUG,
          block,
        }),
      );
      expect(verdict).toMatchObject({
        kind: "threw",
        error: { name: "MaximsError", code: ExitCode.DestinationWriteFailed },
      });
    });
  });
});
