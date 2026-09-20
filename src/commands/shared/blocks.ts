import { type MemoryName, parseMemoryName } from "../../memory/contract.ts";
import { parseBlocks } from "../../rulefile/block.ts";

// A managed block as a rule file holds it: the source it belongs to and the local names of the
// rule lines it carries, read back from each line's detail path.
export type RuleBlock = {
  source: string;
  names: MemoryName[];
};

export function parseRuleBlocks(text: string): RuleBlock[] {
  return parseBlocks(text).blocks.map((block) => ({
    source: block.source,
    names: ruleLineNames(text.slice(block.start, block.end)),
  }));
}

// The renderer wraps a detail token holding a reference-looking `@` in backticks, comma
// included, so the path is read up to the comma with an optional fence on either side.
const DETAIL_PATH = /\(detail: `?(.+?),`? [0-9a-f]{7}\)$/gm;

export function ruleLineNames(blockText: string): MemoryName[] {
  const names: MemoryName[] = [];
  for (const match of blockText.matchAll(DETAIL_PATH)) {
    const parsed = parseMemoryName(detailStem(match[1] ?? ""));
    if (parsed !== null) names.push(parsed);
  }
  return names;
}

// The memory name a rendered detail path ends in. The renderer turns backslashes, backticks, `<`,
// `[` and tilde runs into entities on a line holding a reference token, and a path written on
// Windows separates with backslashes, so both are undone before the last segment is taken.
function detailStem(rendered: string): string {
  const path = rendered
    .replaceAll("&#92;", "\\")
    .replaceAll("&#96;", "`")
    .replaceAll("&lt;", "<")
    .replaceAll("&#91;", "[")
    .replaceAll("&#126;", "~");
  const last = path.split(/[\\/]/).pop() ?? "";
  return last.endsWith(".md") ? last.slice(0, -".md".length) : last;
}
