// Strategy B shares a file with the user: a splice that shifts a byte outside the pair, a
// separator that add-then-remove fails to undo, a block appended inside a fence the user left
// open (invisible to the parser, so every sync would append again), or a leftover empty file
// would each corrupt or litter the AGENTS.md family silently. The engine writes a block with the
// grammar's own `replaceBlock` over the file's current text (an absent file is "") and judges the
// budget once on the finished text, so those two calls stand in for the write here; the grammar's
// own splices are tests/rulefile/block.test.ts's, and only what the strategy adds is pinned here.
import { describe, expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import type { HarnessDefinition, Scope } from "../../../src/harnesses/contract.ts";
import { assertWithinBudget } from "../../../src/harnesses/strategies/rules-dir.ts";
import {
  planSharedBlockRemove,
  type SharedBlockTarget,
  sharedBlockPath,
} from "../../../src/harnesses/strategies/shared-block.ts";
import { replaceBlock } from "../../../src/rulefile/block.ts";
import { ExitCode } from "../../../src/util/exit-codes.ts";
import { assertInsideRoot } from "../../../src/util/fs.ts";
import { outcome } from "../../shared/outcome.ts";
import { withTempDir } from "../../shared/temp_dir.ts";
import { exampleContext as ctx } from "../context.ts";

const target: SharedBlockTarget = { kind: "shared-block", file: "AGENTS.md" };
const def: HarnessDefinition = {
  id: "codex",
  displayName: "Example",
  tier: 1,
  targets: { project: target, global: target },
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
};

const blockFor = (source: string, body: string) =>
  `<!-- maxims:begin ${source} sha=abc version=1 -->\n${body}<!-- maxims:end ${source} -->\n`;
const ours = blockFor("@a/b", "- one\n");
const theirs = blockFor("@c/d", "- other\n");
const path = assertInsideRoot(ctx.home, "/home/user/project/AGENTS.md");

const location = (source: string, currentText: string | null) => ({
  def,
  target,
  scope: "project" as const,
  ctx,
  source,
  currentText,
});

const write = (text: string | null, source: string, block: string): string =>
  replaceBlock(text ?? "", source, block);

// Add-then-remove leaves three residues by design: a missing final newline on the user's text,
// which gains one; the closer the first block wrote for a construct the user's text left open,
// which stays; and a CRLF or lone-CR line ending that closed a block on disk, which becomes LF.
describe("replaceBlock then planSharedBlockRemove", () => {
  const cases: { name: string; before: string | null; after: string; restored: string | null }[] = [
    { name: "no file", before: null, after: ours, restored: null },
    {
      name: "user text with a trailing newline",
      before: "# Agents\n\nhand-written\n",
      after: `# Agents\n\nhand-written\n\n${ours}`,
      restored: "# Agents\n\nhand-written\n",
    },
    {
      name: "user text without a trailing newline gains one",
      before: "hand-written",
      after: `hand-written\n\n${ours}`,
      restored: "hand-written\n",
    },
    {
      name: "another source's block, which sorts after ours, already in the file",
      before: `intro\n${theirs}`,
      after: `intro\n${ours}\n${theirs}`,
      restored: `intro\n${theirs}`,
    },
    {
      name: "our stale block between user text is replaced in place",
      before: `above\n${blockFor("@a/b", "- old\n")}below\n`,
      after: `above\n${ours}below\n`,
      restored: "above\nbelow\n",
    },
    {
      name: "a file that holds nothing but our block is deleted on remove",
      before: `\n${blockFor("@a/b", "- old\n")}\n`,
      after: `\n${ours}\n`,
      restored: null,
    },
    {
      name: "user text ending inside an open fence has the fence closed so the markers stay visible",
      before: "```md\nnotes\n",
      after: `\`\`\`md\nnotes\n\`\`\`\n\n${ours}`,
      restored: "```md\nnotes\n```\n",
    },
  ];

  test.each(cases)("$name", ({ before, after, restored }) => {
    expect(write(before, "@a/b", ours)).toBe(after);
    expect(write(after, "@a/b", ours)).toBe(after);
    const removed = planSharedBlockRemove(location("@a/b", after));
    expect(removed).toEqual(
      restored === null ? [{ kind: "delete", path }] : [{ kind: "write", path, content: restored }],
    );
  });

  test("removing a source that has no block changes nothing", () => {
    expect(planSharedBlockRemove(location("@a/b", `notes\n${theirs}`))).toEqual([]);
    expect(planSharedBlockRemove(location("@a/b", null))).toEqual([]);
  });

  // Windsurf caps a workspace rule and its one global file differently, so a budget may name a
  // cap per scope.
  const budgets: {
    name: string;
    byteBudget: HarnessDefinition["byteBudget"];
    scope: Scope;
    refused: boolean;
  }[] = [
    {
      name: "a plain number caps the project scope",
      byteBudget: 60,
      scope: "project",
      refused: true,
    },
    {
      name: "a plain number caps the global scope",
      byteBudget: 60,
      scope: "global",
      refused: true,
    },
    {
      name: "a project cap refuses a project file",
      byteBudget: { project: 60 },
      scope: "project",
      refused: true,
    },
    {
      name: "a project cap leaves a global file alone",
      byteBudget: { project: 60 },
      scope: "global",
      refused: false,
    },
    {
      name: "a global cap refuses a global file",
      byteBudget: { global: 60 },
      scope: "global",
      refused: true,
    },
    {
      name: "a global cap leaves a project file alone",
      byteBudget: { global: 60 },
      scope: "project",
      refused: false,
    },
  ];

  test.each(budgets)("$name", ({ byteBudget, scope, refused }) => {
    const text = write("x".repeat(40), "@a/b", ours);
    const verdict = outcome(() => assertWithinBudget({ ...def, byteBudget }, scope, path, text));
    if (refused) {
      expect(verdict).toMatchObject({
        kind: "threw",
        error: { name: "MaximsError", code: ExitCode.RuleCapExceeded },
      });
    } else {
      expect(verdict).toEqual({ kind: "value", value: undefined });
    }
  });
});

// Zed reads only the first of its instruction files that exists, so a block planned for AGENTS.md
// beside a `.rules` file would never load; the path must follow the target's precedence list
// against the real root and fall back to the declared file only when none of them exists.
test("a precedence target resolves to the file the harness reads first", async () => {
  const preferring: SharedBlockTarget = {
    kind: "shared-block",
    file: "AGENTS.md",
    precedence: [".rules", "AGENTS.md"],
  };
  await withTempDir((root) => {
    const at = {
      def,
      target: preferring,
      scope: "project" as const,
      ctx: { ...ctx, projectRoot: root, cwd: root },
    };
    expect(String(sharedBlockPath(at))).toBe(join(root, "AGENTS.md"));
    writeFileSync(join(root, ".rules"), "house rules\n");
    expect(String(sharedBlockPath(at))).toBe(join(root, ".rules"));
    expect(
      planSharedBlockRemove({
        ...at,
        source: "@a/b",
        currentText: `house rules\n\n${ours}`,
      }),
    ).toEqual([
      {
        kind: "write",
        path: assertInsideRoot(root, join(root, ".rules")),
        content: "house rules\n",
      },
    ]);
  });
});
