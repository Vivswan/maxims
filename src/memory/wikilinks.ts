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
// installed under the renamed name, so a collision rename never turns a valid link into an error.
export function resolveWikilinks(
  incoming: Memory[],
  installedNames: Set<string>,
  rename: Record<string, string>,
): { unmet: UnmetWikilink[] } {
  const available = new Set(installedNames);
  for (const memory of incoming) available.add(rename[memory.name] ?? memory.name);
  const unmet: UnmetWikilink[] = [];
  for (const memory of incoming) {
    for (const link of extractWikilinks(memory.body)) {
      if (available.has(link) || available.has(rename[link] ?? link)) continue;
      unmet.push({ memory: memory.name, link });
    }
  }
  return { unmet };
}
