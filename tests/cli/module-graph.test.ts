// Fails if the hook path regrows: a static import chain from the bin entry, the engine loader or
// the sync verb that reaches the interactive frame, the color library, agent detection, the
// GitHub fetch ladder, the git and tarball resolvers or the diff renderer would load them at
// every session start, which the latency budget forbids. Dynamic imports are not followed, since that is exactly how
// the interactive verbs and the resolvers are meant to load, and neither are type-only imports,
// which the compiler erases and the bundle never carries.
import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { dirname, relative, resolve, sep } from "node:path";

const SRC = resolve(import.meta.dir, "..", "..", "src");

const HEAVY = [
  "@clack/prompts",
  "picocolors",
  "@vercel/detect-agent",
  "simple-git",
  "tar",
  "debug",
  "diff",
];

const HOOK_PATH_EXCLUDES = [
  "sources/github/ladder.ts",
  "sources/github/index.ts",
  "sources/github/tarball.ts",
  "sources/git/index.ts",
  "console/clack.ts",
  "console/rename.ts",
  "commands/add.ts",
  "commands/update.ts",
].map((path) => resolve(SRC, path));

const HOOK_PATH_ROOTS = ["cli.ts", "commands/engine.ts", "commands/engine-verbs.ts"].map((path) =>
  resolve(SRC, path),
);

const STATIC_IMPORT = /^\s*(?:import|export)\s(?!type\s)[^;]*?\sfrom\s+["']([^"']+)["']/gm;
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

// Sorted, so a row below names a set and a reordering of the lists above changes nothing.
function offenders(graph: Set<string>): { packages: string[]; modules: string[] } {
  return {
    packages: HEAVY.filter((name) => graph.has(name)).sort(),
    modules: HOOK_PATH_EXCLUDES.filter((path) => graph.has(path))
      .map((path) => relative(SRC, path).split(sep).join("/"))
      .sort(),
  };
}

test("the static graph from the bin entry, the engine loader and the sync verb carries no fetch or interactive module", () => {
  const graph = new Set(HOOK_PATH_ROOTS.flatMap((root) => [...walk(root)]));
  expect(offenders(graph)).toEqual({ packages: [], modules: [] });
});

// The negative controls: the same check over graphs known to carry the interactive libraries and
// the fetch ladder must name them, or a green run above proves nothing.
const CONTROLS: [string, string, ReturnType<typeof offenders>][] = [
  [
    "the clack renderer",
    "console/clack.ts",
    { packages: ["@clack/prompts", "picocolors"], modules: ["console/clack.ts"] },
  ],
  [
    "the github resolver",
    "sources/github/index.ts",
    {
      packages: ["debug", "simple-git", "tar"],
      modules: ["sources/github/index.ts", "sources/github/ladder.ts", "sources/github/tarball.ts"],
    },
  ],
  [
    "the show verb",
    "commands/show.ts",
    {
      packages: ["debug", "diff", "simple-git", "tar"],
      modules: ["sources/github/index.ts", "sources/github/ladder.ts", "sources/github/tarball.ts"],
    },
  ],
];

test.each(CONTROLS)("the check names what a walk from %s carries", (_name, root, expected) => {
  expect(offenders(walk(resolve(SRC, root)))).toEqual(expected);
});
