import { fromMarkdown } from "mdast-util-from-markdown";
import { visit } from "unist-util-visit";
import type { Memory } from "./contract.ts";

// `[[target|alias]]` is the wider wikilink form; only the target names a memory.
const WIKILINK = /\[\[([^[\]\n|]+)(?:\|[^[\]\n]*)?\]\]/g;

/**
 * The body with fenced code, indented code and code spans turned to spaces, so the parser alone
 * decides what is code. Leading byte order marks go first: the parser skips one and counts
 * offsets from the next character.
 */
function withCodeBlanked(body: string): string {
  let text = body.replace(/^\uFEFF+/, "");

  visit(fromMarkdown(text), ["code", "inlineCode"], ({ position }) => {
    const start = position?.start.offset ?? 0;
    const end = position?.end.offset ?? 0;
    text = text.slice(0, start) + " ".repeat(end - start) + text.slice(end);
  });

  return text;
}

/**
 * The memory names a body links to, in order of first appearance, each once. A `[[...]]` inside
 * Markdown code is text the memory shows, not a dependency; one inside HTML still is.
 */
export function extractWikilinks(body: string): string[] {
  // Most bodies link nothing, and the search is far cheaper than the parse.
  if (!body.includes("[[")) return [];

  const seen = new Set<string>();
  for (const match of withCodeBlanked(body).matchAll(WIKILINK)) {
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
