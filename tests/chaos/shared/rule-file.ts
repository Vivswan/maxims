// What a rendered rule file must hold for a source: one line per installed memory carrying its
// description and a detail path into the store copy, the copy itself byte-identical to the fixture,
// and a staleness line only when a row expects one.

import { expect } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parseRuleBlocks } from "../../../src/commands/shared/blocks.ts";
import { type MemorySpec, memoryFile } from "./fixture-repo.ts";

export const STALE_LINE = "have not refreshed since";

export function ruleLines(text: string): string[] {
  return text.split("\n").filter((line) => line.startsWith("- "));
}

export function staleLines(text: string): string[] {
  return text.split("\n").filter((line) => line.includes(STALE_LINE));
}

export function withoutStaleLine(text: string): string {
  return text
    .split("\n")
    .filter((line) => !line.includes(STALE_LINE))
    .join("\n");
}

export function expectRuleFile(
  rule: string,
  key: string,
  storeEntry: string,
  memories: Record<string, MemorySpec>,
): void {
  const text = readFileSync(rule, "utf8");
  const names = Object.keys(memories).sort();
  expect(
    parseRuleBlocks(text).map((block) => ({ ...block, names: block.names.map(String) })),
  ).toEqual([{ source: key, names }]);
  const lines = ruleLines(text);
  expect(lines).toHaveLength(names.length);
  for (const [index, name] of names.entries()) {
    const spec = memories[name];
    if (spec === undefined) throw new Error(`no fixture for ${name}`);
    const body = join(storeEntry, "memories", `${name}.md`);
    expect(lines[index]).toContain(`- ${spec.description} (detail: ${body}, `);
    expect(readFileSync(body, "utf8")).toBe(memoryFile(name, spec));
  }
}
