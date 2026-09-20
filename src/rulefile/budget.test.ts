// Guards the two numbers a user acts on: the token estimate that would quietly overstate a Claude
// Code file by its stripped comments, and the count cap whose refusal must carry the two ways out.
import { describe, expect, test } from "bun:test";
import type { MemoryName } from "../memory/contract.ts";
import { ExitCode } from "../util/exit-codes.ts";
import { renderBlock } from "./block.ts";
import { checkCap, DEFAULT_RULE_CAP, estimateTokens } from "./budget.ts";
import type { BlockInput } from "./types.ts";

const INPUT: BlockInput = {
  source: "@Vivswan/skills",
  sha: "3f2a9c1e",
  lines: [
    {
      name: "rubber-duck-before-every-commit" as MemoryName,
      description: "Codex rubber-duck review before EVERY commit",
      detailPath:
        "/home/user/.agents/maxims/store/Vivswan/skills/rubber-duck-before-every-commit.md",
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

  test("under stripping, a comment inside a fence and a multi-line comment follow the harness rule", () => {
    const file = [
      "<!-- gone -->",
      "<!--",
      "also gone",
      "-->",
      "kept",
      "```",
      "<!-- kept: fenced comments survive stripping -->",
      "```",
      "",
    ].join("\n");
    const injected = [
      "kept",
      "```",
      "<!-- kept: fenced comments survive stripping -->",
      "```",
      "",
    ].join("\n");
    expect(estimateTokens(file, "stripped")).toBe(Math.ceil(injected.length / 4));
    expect(estimateTokens(file, "counted")).toBe(Math.ceil(file.length / 4));
    expect(estimateTokens("<!--\n```\n-->\n", "stripped")).toBe(0);
  });
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
      hint: "narrow the source with --memory <name>..., or raise config.ruleCap (currently 2)",
    });
  });
});
