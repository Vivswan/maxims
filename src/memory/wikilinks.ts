import type { Memory } from "./contract.ts";

// `[[target|alias]]` is the wider wikilink form; only the target names a memory.
const WIKILINK = /\[\[([^[\]\n|]+)(?:\|[^[\]\n]*)?\]\]/g;

export function extractWikilinks(body: string): string[] {
  const seen = new Set<string>();
  for (const match of body.matchAll(WIKILINK)) {
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
