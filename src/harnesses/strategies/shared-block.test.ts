// Strategy B shares a file with the user: a splice that shifts a byte outside the pair, a
// separator that add-then-remove fails to undo, or a leftover empty file would each corrupt or
// litter the AGENTS.md family silently.
import { describe, expect, test } from "bun:test";
import { ExitCode, MaximsError } from "../../util/exit-codes.ts";
import type { HarnessContext, HarnessDefinition } from "../contract.ts";
import {
  type ManagedBlockSpan,
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

// Marker pairs at line start, the same shape src/rulefile/block.ts reports; the span runs from
// the begin marker through the end marker's line break.
function parseBlocks(text: string): ManagedBlockSpan[] {
  const spans: ManagedBlockSpan[] = [];
  const begin = /^<!-- maxims:begin (\S+) sha=\S+ -->\n/gm;
  for (const match of text.matchAll(begin)) {
    const source = match[1] ?? "";
    const endMarker = `<!-- maxims:end ${source} -->\n`;
    const endAt = text.indexOf(endMarker, match.index);
    if (endAt === -1) continue;
    spans.push({ source, start: match.index, end: endAt + endMarker.length });
  }
  return spans;
}

const blockFor = (source: string, body: string) =>
  `<!-- maxims:begin ${source} sha=abc -->\n${body}<!-- maxims:end ${source} -->\n`;
const ours = blockFor("@a/b", "- one\n");
const oursV2 = blockFor("@a/b", "- one\n- two\n");
const theirs = blockFor("@c/d", "- other\n");
const path = "/home/user/project/AGENTS.md";

const location = (source: string, currentText: string | null) => ({
  def,
  target,
  scope: "project" as const,
  ctx,
  source,
  currentText,
  parseBlocks,
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
      name: "another source's block before ours",
      before: `intro\n${theirs}`,
      after: `intro\n${theirs}\n${ours}`,
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
    const before = `${theirs}\n${ours}\ntrailing notes\n`;
    const [change] = planSharedBlockWrite({ ...location("@a/b", before), block: oursV2 });
    expect(change).toEqual({
      kind: "write",
      path,
      content: `${theirs}\n${oursV2}\ntrailing notes\n`,
    });
    expect(planSharedBlockRemove(location("@c/d", before))).toEqual([
      { kind: "write", path, content: `${ours}\ntrailing notes\n` },
    ]);
  });

  test("removing a source that has no block changes nothing", () => {
    expect(planSharedBlockRemove(location("@a/b", `notes\n${theirs}`))).toEqual([]);
    expect(planSharedBlockRemove(location("@a/b", null))).toEqual([]);
  });

  test("a global install writes under the home and a budget overrun is refused as exit 8", () => {
    const global = planSharedBlockWrite({
      ...location("@a/b", null),
      scope: "global",
      block: ours,
    });
    expect(global).toEqual([{ kind: "write", path: "/home/user/AGENTS.md", content: ours }]);
    let caught: unknown;
    try {
      planSharedBlockWrite({
        ...location("@a/b", "x".repeat(40)),
        def: { ...def, byteBudget: 60 },
        block: ours,
      });
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(MaximsError);
    if (caught instanceof MaximsError) expect(caught.code).toBe(ExitCode.RuleCapExceeded);
  });
});
