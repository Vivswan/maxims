import { ExitCode } from "../util/exit-codes.ts";
import { markdownLines } from "./block.ts";
import type { Markers } from "./types.ts";

export const DEFAULT_RULE_CAP = 25;

// Claude Code strips block-level HTML comments before injection and keeps the ones inside fenced
// code, so a stripped estimate drops exactly the lines the scanner classes as comment blocks.
export function estimateTokens(renderedFile: string, markers: Markers): number {
  const injected = markers === "counted" ? renderedFile : withoutBlockComments(renderedFile);
  return Math.ceil(injected.length / 4);
}

function withoutBlockComments(fileText: string): string {
  return markdownLines(fileText)
    .filter((line) => line.kind !== "comment" && line.kind !== "comment-continuation")
    .map((line) => fileText.slice(line.start, line.end))
    .join("");
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

function capHint(cap: number): string {
  return (
    `narrow the source with --memory <name>..., or raise the cap (currently ${cap}) ` +
    "with --cap <n> for this run or `maxims config set ruleCap <n>` to keep it"
  );
}
