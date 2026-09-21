// Fails if the shipped surface the next lane gates on drifts from what npm publish packs: a module the build script
// or the bundle entry reaches, a path package.json packs, or a root file npm packs whatever files lists, that the
// surface does not cover; or a path that only shapes the repository (docs, tests, CI, lint and architecture configs)
// that it does. The build itself opens nothing outside the surface: tests/release/bundle.test.ts builds dist/cli.js
// from a copy holding only src/, scripts/, tsconfig.json, and package.json beside node_modules, and scripts/build.ts
// reads no other path.
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { isShipped } from "../../.github/scripts/release-pipeline.ts";
import manifest from "../../package.json" with { type: "json" };

const REPO = resolve(import.meta.dir, "..", "..");
const BUILD_SCRIPT = "scripts/build.ts";

/** A path relative to the repository root, spelled with forward slashes as git lists it on every platform. */
function repoPath(absolute: string): string {
  return relative(REPO, absolute).split(sep).join("/");
}

/** The relative imports of a TypeScript module, static and dynamic, as repository paths. */
function relativeImports(path: string): string[] {
  const source = readFileSync(join(REPO, path), "utf8");
  return [...source.matchAll(/\b(?:from\s+|import\()"(\.\.?\/[^"]+)"/g)].map((match) =>
    repoPath(resolve(REPO, dirname(path), match[1] as string)),
  );
}

/** Every module reachable over relative imports from `entry`, the entry included. */
function importGraph(entry: string): string[] {
  const seen = new Set<string>();
  const pending = [entry];
  for (let path = pending.pop(); path !== undefined; path = pending.pop()) {
    if (seen.has(path)) continue;
    seen.add(path);
    pending.push(...relativeImports(path));
  }
  return [...seen].sort();
}

/** The entry scripts/build.ts bundles by default, read off the script so the walk below starts where the build does. */
function bundleEntry(): string {
  const entry = readFileSync(join(REPO, BUILD_SCRIPT), "utf8").match(
    /DEFAULT_ENTRY = "([^"]+)"/,
  )?.[1];
  if (entry === undefined) throw new Error(`${BUILD_SCRIPT} no longer declares DEFAULT_ENTRY`);
  return entry;
}

describe("the shipped surface covers the packaging", () => {
  test("every module the build script imports", () => {
    expect(importGraph(BUILD_SCRIPT).filter((path) => !isShipped(path))).toEqual([]);
  });

  test("every module and the manifest the bundle's entry reaches", () => {
    const graph = importGraph(bundleEntry());
    expect(graph).toContain("package.json");
    expect(graph).toContain("src/commands/add.ts");
    expect(graph.filter((path) => !isShipped(path))).toEqual([]);
  });

  test("every path package.json packs, with dist/ as the build's output", () => {
    const packed = manifest.files.filter((entry) => entry !== "dist/");
    expect(packed.length).toBeGreaterThan(0);
    expect(packed.filter((path) => !isShipped(path))).toEqual([]);
    expect(manifest.bin.maxims.startsWith("dist/")).toBe(true);
  });

  test.each([
    "README.md.orig",
    "readme.txt",
    "Readme",
    "LICENSE.txt",
    "licence",
    "COPYING",
    "copying.txt",
    "readme.md.bak",
  ])("%s, a root file npm packs whatever files lists", (path) => {
    expect(isShipped(path)).toBe(true);
  });
});

describe("the shipped surface leaves out what only shapes the repository", () => {
  test.each([
    "docs/cli.md",
    "docs/README.md",
    "tests/release/verdict.test.ts",
    "tests/fixtures/state.json",
    ".github/workflows/post-green.yml",
    ".github/scripts/release-pipeline.ts",
    "architecture.yml",
    "biome.json",
    "knip.jsonc",
    "scripts/bench.ts",
    "scripts/lib/figures.ts",
    "AGENTS.md",
    "CLAUDE.md",
    "srcs/cli.ts",
    "CHANGELOG.md",
    "NOTICE",
    "docs/LICENSE",
    "src-readme.md",
    "README.md~",
    "LICENSE.txt$",
    "README.",
  ])("%s", (path) => {
    expect(isShipped(path)).toBe(false);
  });
});
