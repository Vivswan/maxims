import { ExitCode } from "../util/exit-codes.ts";
import { markdownLines } from "./block.ts";
import type { Markers } from "./types.ts";

export const DEFAULT_RULE_CAP = 25;

// Claude Code strips block-level HTML comments before injection and keeps the ones inside fenced
// code, so a stripped estimate removes exactly the comment spans the scanner classes as comment
// blocks: a complete `<!-- ... -->` goes with the spaces around it and the line ending it sits on,
// while text beside it and an unclosed comment ride into context and are counted. The estimate is
// a characters-over-four heuristic, and it treats a comment inside a list item as stripped although
// Claude Code retains that one.
export function estimateTokens(renderedFile: string, markers: Markers): number {
  const injected = markers === "counted" ? renderedFile : withoutBlockComments(renderedFile);
  return Math.ceil(injected.length / 4);
}

const COMMENT_SPAN = /[ \t]*<!--[\s\S]*?-->[ \t]*(?:\r\n|\r|\n)?/g;

// A comment block is its starting line and the continuation lines behind it; two blocks are
// stripped apart, so a closed one never lends its closer to an unclosed one before it.
function withoutBlockComments(fileText: string): string {
  let kept = "";
  let comment = "";
  for (const line of markdownLines(fileText)) {
    const text = fileText.slice(line.start, line.end);
    if (line.kind === "comment-continuation") {
      comment += text;
      continue;
    }
    kept += comment.replace(COMMENT_SPAN, "");
    comment = line.kind === "comment" ? text : "";
    if (line.kind !== "comment") kept += text;
  }
  return kept + comment.replace(COMMENT_SPAN, "");
}

export type CapCheck =
  | { ok: true }
  | { ok: false; code: ExitCode.RuleCapExceeded; count: number; cap: number; hint: string };

export function checkCap(count: number, cap: number): CapCheck {
  if (count <= cap) return { ok: true };
  return {
    ok: false,
    code: ExitCode.RuleCapExceeded,
    count,
    cap,
    hint: capHint(cap),
  };
}

// cooldownCapConfig persists `--cap`, so the hint must not read as a one-run override.
function capHint(cap: number): string {
  return (
    `narrow the source with --memory <name>..., or raise the cap (currently ${cap}) ` +
    "with --cap <n>, which saves ruleCap to config.json as `maxims config set ruleCap <n>` does"
  );
}
