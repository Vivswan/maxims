// Strategy B shares a file with the user: a splice that shifts a byte outside the pair, a
// separator that add-then-remove fails to undo, a block appended inside a fence the user left
// open (invisible to the parser, so every sync would append again), or a leftover empty file
// would each corrupt or litter the AGENTS.md family silently.
import { describe, expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { withTempDir } from "../../../tests/shared/temp_dir.ts";
import { ExitCode, MaximsError } from "../../util/exit-codes.ts";
import { assertInsideRoot } from "../../util/fs.ts";
import type { HarnessContext, HarnessDefinition, Scope } from "../contract.ts";
import {
  planSharedBlockRemove,
  planSharedBlockWrite,
  type SharedBlockTarget,
} from "./shared-block.ts";

const ctx: HarnessContext = { home: "/home/user", projectRoot: "/home/user/project", env: {} };
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
  verifiedAgainst: { url: "https://example.com/docs", date: "2026-09-20" },
};

const blockFor = (source: string, body: string) =>
  `<!-- maxims:begin ${source} sha=abc -->\n${body}<!-- maxims:end ${source} -->\n`;
const ours = blockFor("@a/b", "- one\n");
const oursV2 = blockFor("@a/b", "- one\n- two\n");
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

describe("planSharedBlockWrite then planSharedBlockRemove", () => {
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
    const written = planSharedBlockWrite({ ...location("@a/b", before), block: ours });
    expect(written).toEqual([{ kind: "write", path, content: after }]);
    expect(planSharedBlockWrite({ ...location("@a/b", after), block: ours })).toEqual([]);
    const removed = planSharedBlockRemove(location("@a/b", after));
    expect(removed).toEqual(
      restored === null ? [{ kind: "delete", path }] : [{ kind: "write", path, content: restored }],
    );
  });

  test("replacing one source's block leaves the other source's bytes untouched", () => {
    const before = `${ours}\n${theirs}\ntrailing notes\n`;
    const [change] = planSharedBlockWrite({ ...location("@a/b", before), block: oursV2 });
    expect(change).toEqual({
      kind: "write",
      path,
      content: `${oursV2}\n${theirs}\ntrailing notes\n`,
    });
    expect(planSharedBlockRemove(location("@c/d", before))).toEqual([
      { kind: "write", path, content: `${ours}\ntrailing notes\n` },
    ]);
  });

  // `add alpha; add beta; link beta; link alpha` and `add alpha -a codex; add beta -a codex` are
  // one intent; the shared file they leave must be one set of bytes.
  test("two sources reaching one file in either order leave the same bytes", () => {
    const write = (text: string | null, source: string, block: string): string => {
      const [change] = planSharedBlockWrite({ ...location(source, text), block });
      return change?.kind === "write" ? change.content : (text ?? "");
    };
    const oursFirst = write(write("# Agents\n", "@a/b", ours), "@c/d", theirs);
    const theirsFirst = write(write("# Agents\n", "@c/d", theirs), "@a/b", ours);
    expect(theirsFirst).toBe(oursFirst);
    expect(oursFirst).toBe(`# Agents\n\n${ours}\n${theirs}`);
  });

  // The second block's slot opens between the first block and the text glued below it; removing
  // that block must take its separator back, or the user's text drifts one blank line down.
  test("a block added after another one and removed again leaves the glued text as it was", () => {
    const before = `${ours}user notes\n`;
    const joined = `${ours}\n${theirs}user notes\n`;
    expect(planSharedBlockWrite({ ...location("@c/d", before), block: theirs })).toEqual([
      { kind: "write", path, content: joined },
    ]);
    expect(planSharedBlockRemove(location("@c/d", joined))).toEqual([
      { kind: "write", path, content: before },
    ]);
  });

  test("removing a source that has no block changes nothing", () => {
    expect(planSharedBlockRemove(location("@a/b", `notes\n${theirs}`))).toEqual([]);
    expect(planSharedBlockRemove(location("@a/b", null))).toEqual([]);
  });

  test("a global install writes under the home", () => {
    const global = planSharedBlockWrite({
      ...location("@a/b", null),
      scope: "global",
      block: ours,
    });
    expect(global).toEqual([
      { kind: "write", path: assertInsideRoot(ctx.home, "/home/user/AGENTS.md"), content: ours },
    ]);
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
    const notes = "x".repeat(40);
    const run = () =>
      planSharedBlockWrite({
        ...location("@a/b", notes),
        def: { ...def, byteBudget },
        scope,
        block: ours,
      });
    if (!refused) {
      const file = scope === "project" ? "/home/user/project/AGENTS.md" : "/home/user/AGENTS.md";
      expect(run()).toEqual([
        { kind: "write", path: assertInsideRoot(ctx.home, file), content: `${notes}\n\n${ours}` },
      ]);
      return;
    }
    let caught: unknown;
    try {
      run();
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(MaximsError);
    if (caught instanceof MaximsError) expect(caught.code).toBe(ExitCode.RuleCapExceeded);
  });
});

// Zed reads only the first of its instruction files that exists, so a block planned for AGENTS.md
// beside a `.rules` file would never load; the plan must follow the target's precedence list
// against the real root and fall back to the declared file only when none of them exists.
test("a precedence target plans the block into the file the harness reads first", async () => {
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
      ctx: { ...ctx, projectRoot: root },
    };
    const plan = (currentText: string | null) =>
      planSharedBlockWrite({ ...at, source: "@a/b", currentText, block: ours });
    expect(plan(null).map((change) => String(change.path))).toEqual([join(root, "AGENTS.md")]);
    writeFileSync(join(root, ".rules"), "house rules\n");
    expect(plan("house rules\n").map((change) => String(change.path))).toEqual([
      join(root, ".rules"),
    ]);
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
