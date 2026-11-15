import { fromMarkdown } from "mdast-util-from-markdown";
import { visit } from "unist-util-visit";
import type { Memory } from "./contract.ts";

// `[[target|alias]]` is the wider wikilink form; only the target names a memory.
const WIKILINK = /\[\[([^[\]\n|]+)(?:\|[^[\]\n]*)?\]\]/g;

// Blanking these alone keeps the rest of a code span, so a link whose alias holds one still matches.
const BRACKET = /[[\]]/g;

// micromark skips one leading byte order mark and counts every offset from the next character.
const BYTE_ORDER_MARK = "\uFEFF";

/**
 * The body with every bracket inside fenced code, indented code and a code span blanked, at the
 * same length, so an index into one reads the same in the other. Only brackets go, so a span
 * inside an alias (``[[a|`--flag`]]``) leaves the link around it whole.
 */
function withoutCodeBrackets(body: string): string {
  const shift = body.startsWith(BYTE_ORDER_MARK) ? BYTE_ORDER_MARK.length : 0;
  let masked = body;

  visit(fromMarkdown(body), ["code", "inlineCode"], (node) => {
    const start = node.position?.start.offset;
    const end = node.position?.end.offset;
    if (start === undefined || end === undefined)
      throw new Error("mdast-util-from-markdown positions every node");

    const code = masked.slice(start + shift, end + shift).replace(BRACKET, " ");
    masked = masked.slice(0, start + shift) + code + masked.slice(end + shift);
  });

  return masked;
}

/**
 * The memory names a body links to, in order of first appearance, each once. A `[[...]]` inside
 * Markdown code is text the memory shows, not a dependency; one inside HTML still is.
 */
export function extractWikilinks(body: string): string[] {
  // Most bodies link nothing, and the search is far cheaper than the parse.
  if (!body.includes("[[")) return [];

  const seen = new Set<string>();
  for (const match of withoutCodeBrackets(body).matchAll(WIKILINK)) {
    // A match that leans on a blanked bracket reads differently in the body, where it never was a link.
    if (body.slice(match.index, match.index + match[0].length) !== match[0]) continue;

    const target = (match[1] ?? "").trim();
    if (target !== "") seen.add(target);
  }

  return [...seen];
}

export type UnmetWikilink = {
  memory: string;
  link: string;
};

// A link written against an upstream name resolves through the rename map to the local memory
// installed under the renamed name, and ONLY to it: a same-named memory another source owns is
// the collision the rename exists to step around, so it must not satisfy the link.
export function resolveWikilinks(
  incoming: Memory[],
  installedNames: Set<string>,
  rename: Record<string, string>,
): { unmet: UnmetWikilink[] } {
  const localName = (name: string) => (Object.hasOwn(rename, name) ? rename[name] : name);
  const available = new Set(installedNames);
  for (const memory of incoming) available.add(localName(memory.name));
  const unmet: UnmetWikilink[] = [];
  for (const memory of incoming) {
    for (const link of extractWikilinks(memory.body)) {
      if (available.has(localName(link))) continue;
      unmet.push({ memory: memory.name, link });
    }
  }
  return { unmet };
}
