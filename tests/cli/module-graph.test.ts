// Fails if the hook path regrows: a static import chain from the bin entry to the sync verb that
// reaches the interactive frame, the color library, agent detection, or the git and tarball code
// would load them at every session start, which the latency budget forbids. Dynamic imports are
// not followed, since that is exactly how the interactive verbs are meant to load.
import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

const SRC = resolve(import.meta.dir, "..", "..", "src");

const HEAVY = ["@clack/prompts", "picocolors", "@vercel/detect-agent", "simple-git", "tar"];

const STATIC_IMPORT = /^\s*(?:import|export)\s[^;]*?\sfrom\s+["']([^"']+)["']/gm;
const BARE_IMPORT = /^\s*import\s+["']([^"']+)["']/gm;

function staticImports(file: string): string[] {
  const text = readFileSync(file, "utf8");
  const specifiers: string[] = [];
  for (const regex of [STATIC_IMPORT, BARE_IMPORT]) {
    for (const match of text.matchAll(regex)) if (match[1] !== undefined) specifiers.push(match[1]);
  }
  return specifiers;
}

function walk(entry: string): Set<string> {
  const seen = new Set<string>();
  const queue = [entry];
  while (queue.length > 0) {
    const file = queue.pop();
    if (file === undefined || seen.has(file)) continue;
    seen.add(file);
    for (const specifier of staticImports(file)) {
      if (specifier.startsWith(".")) queue.push(resolve(dirname(file), specifier));
      else seen.add(specifier);
    }
  }
  return seen;
}

function offenders(graph: Set<string>): string[] {
  return HEAVY.filter((name) => graph.has(name));
}

test("the static graph from the bin entry through the sync verb carries no interactive module", () => {
  const graph = new Set([
    ...walk(resolve(SRC, "cli.ts")),
    ...walk(resolve(SRC, "commands", "engine-verbs.ts")),
  ]);
  expect(offenders(graph)).toEqual([]);
  expect(graph.has(resolve(SRC, "console", "clack.ts"))).toBe(false);
  expect(graph.has(resolve(SRC, "commands", "add.ts"))).toBe(false);
});

// The negative control: the same check over a graph known to carry the interactive libraries
// must name them, or a green run above proves nothing.
test("the check names the interactive libraries when the walk starts at the clack renderer", () => {
  expect(offenders(walk(resolve(SRC, "console", "clack.ts")))).toEqual([
    "@clack/prompts",
    "picocolors",
  ]);
});
