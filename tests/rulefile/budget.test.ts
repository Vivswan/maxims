// Guards the two numbers a user acts on: the token estimate that would quietly overstate a Claude
// Code file by its stripped comments (or understate it by the text those comments sit beside), and
// the count cap whose refusal must carry the two ways out.
import { describe, expect, test } from "bun:test";
import type { MemoryName } from "../../src/memory/contract.ts";
import { renderBlock } from "../../src/rulefile/block.ts";
import { checkCap, DEFAULT_RULE_CAP, estimateTokens } from "../../src/rulefile/budget.ts";
import type { BlockInput } from "../../src/rulefile/types.ts";
import { ExitCode } from "../../src/util/exit-codes.ts";

const INPUT: BlockInput = {
  source: "@Octocat/rules",
  sha: "3f2a9c1e",
  lines: [
    {
      name: "prefer-timeouts-to-hangs" as MemoryName,
      description: "A timeout on EVERY call that leaves the process",
      detailPath:
        "/home/user/.agents/maxims/store/octocat/rules/memories/prefer-timeouts-to-hangs.md",
      shortHash: "a1b2c3d",
    },
  ],
  markers: "counted",
  expands: ["at-import"],
  selfRefresh: false,
};

describe("estimateTokens", () => {
  test("stripped markers cost nothing; counted markers ride into the estimate", () => {
    const stripped = renderBlock({ ...INPUT, markers: "stripped" });
    const counted = renderBlock({ ...INPUT, markers: "counted" });
    const ruleLine = stripped.split("\n").find((l) => l.startsWith("- "));
    if (ruleLine === undefined) throw new Error("render carried no rule line");
    expect(estimateTokens(stripped, "stripped")).toBe(Math.ceil((ruleLine.length + 1) / 4));
    expect(estimateTokens(counted, "counted")).toBe(Math.ceil(counted.length / 4));
    expect(estimateTokens(stripped, "stripped")).toBeLessThan(estimateTokens(counted, "counted"));
  });

  const stripping: [string, string, string][] = [
    [
      "a comment inside a fence, behind a one-line and a multi-line comment",
      "<!-- gone -->\n<!--\nalso gone\n-->\nkept\n```\n<!-- kept: fenced comments survive stripping -->\n```\n",
      "kept\n```\n<!-- kept: fenced comments survive stripping -->\n```\n",
    ],
    ["a fence quoted inside a comment", "<!--\n```\n-->\n", ""],
    ["text after a comment on its line", "<!-- gone -->KEEP THIS\n", "KEEP THIS\n"],
    ["an unclosed comment", "<!-- open\nimportant text\n", "<!-- open\nimportant text\n"],
    ["text between two comments on one line", "<!-- a --> KEEP <!-- b -->\nrest\n", "KEEP\nrest\n"],
    ["text after a multi-line comment's closer", "<!--\ngone\n-->KEEP\nrest\n", "KEEP\nrest\n"],
    ["a comment behind two spaces", "  <!-- gone -->\nrest\n", "rest\n"],
    [
      "an unclosed comment ended by its list item, then a closed one",
      "- <!-- open\n<!-- gone -->\nrest\n",
      "- <!-- open\nrest\n",
    ],
  ];
  test.each(stripping)(
    "under stripping, %s is kept the way the harness keeps it; under counting, nothing is stripped",
    (_label, file, injected) => {
      expect(estimateTokens(file, "stripped")).toBe(Math.ceil(injected.length / 4));
      expect(estimateTokens(file, "counted")).toBe(Math.ceil(file.length / 4));
    },
  );
});

describe("checkCap", () => {
  test("the cap is inclusive, and the refusal names both ways out", () => {
    expect(checkCap(DEFAULT_RULE_CAP, DEFAULT_RULE_CAP)).toEqual({ ok: true });
    expect(checkCap(0, 1)).toEqual({ ok: true });
    expect(checkCap(3, 2)).toEqual({
      ok: false,
      code: ExitCode.RuleCapExceeded,
      count: 3,
      cap: 2,
      hint:
        "narrow the source with --memory <name>..., or raise the cap (currently 2) " +
        "with --cap <n>, which saves ruleCap to config.json as `maxims config set ruleCap <n>` does",
    });
  });
});
