// Strategy A owns the file a harness loads: a frontmatter chosen from the wrong declaration, a
// slug that escapes the rules directory, or a symlink left at the path would each load nothing.
import { describe, expect, test } from "bun:test";
import { lstatSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { withTempDir } from "../../../tests/shared/temp_dir.ts";
import { applyChanges } from "../../util/change.ts";
import { ExitCode, MaximsError } from "../../util/exit-codes.ts";
import type { HarnessContext, HarnessDefinition, Scope } from "../contract.ts";
import { planRulesDirRemove, planRulesDirWrite, type RulesDirTarget } from "./rules-dir.ts";

const ctx: HarnessContext = { home: "/home/user", projectRoot: "/home/user/project", env: {} };
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
    verifiedAgainst: { url: "https://example.com/docs", date: "2026-09-20" },
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
  ];

  test.each(cases)("$name", ({ def, target, scope, paths, path, content }) => {
    const changes = planRulesDirWrite({ def, target, scope, ctx, sourceSlug: "a-b", block, paths });
    expect(changes).toEqual([{ kind: "write", path, content }]);
    expect(planRulesDirRemove({ def, target, scope, ctx, sourceSlug: "a-b" })).toEqual([
      { kind: "delete", path },
    ]);
  });

  const refusals: { name: string; run: () => unknown; code: ExitCode }[] = [
    {
      name: "a slug that escapes the rules directory",
      run: () =>
        planRulesDirWrite({
          def: scoped,
          target: plain,
          scope: "project",
          ctx,
          sourceSlug: "x/../../../../etc/evil",
          block,
        }),
      code: ExitCode.DestinationWriteFailed,
    },
    {
      name: "a project install with no project root",
      run: () =>
        planRulesDirWrite({
          def: scoped,
          target: plain,
          scope: "project",
          ctx: { ...ctx, projectRoot: null },
          sourceSlug: "a-b",
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
          sourceSlug: "a-b",
          block,
        }),
      code: ExitCode.RuleCapExceeded,
    },
  ];

  test.each(refusals)("refuses $name", ({ run, code }) => {
    let caught: unknown;
    try {
      run();
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(MaximsError);
    if (caught instanceof MaximsError) expect(caught.code).toBe(code);
  });

  test("applying the write over a symlink at the target leaves a regular file", async () => {
    await withTempDir(async (root) => {
      const local: HarnessContext = { ...ctx, projectRoot: root };
      const rulesDir = join(root, ".claude", "rules");
      mkdirSync(rulesDir, { recursive: true });
      writeFileSync(join(root, "elsewhere.md"), "not the rules\n");
      symlinkSync(join(root, "elsewhere.md"), join(rulesDir, "maxims-a-b.md"));
      const changes = planRulesDirWrite({
        def: scoped,
        target: plain,
        scope: "project",
        ctx: local,
        sourceSlug: "a-b",
        block,
      });
      await applyChanges({ changes, notices: [] }, { dryRun: false });
      const path = join(rulesDir, "maxims-a-b.md");
      expect(lstatSync(path).isSymbolicLink()).toBe(false);
      expect(readFileSync(path, "utf8")).toBe(block);
      expect(readFileSync(join(root, "elsewhere.md"), "utf8")).toBe("not the rules\n");
    });
  });
});
