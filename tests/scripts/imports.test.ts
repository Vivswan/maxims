// Fails if the import scanner drops a form that loads a module, or if resolveImport stops following
// bun's extension order: the module-graph, shipped-files, and bench tests read the import graph
// through these two, so a missing edge there would pass with nothing else to notice.
import { expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { importSpecifiers, resolveImport } from "../../scripts/lib/imports.ts";
import { withTempDir } from "../shared/temp_dir.ts";

// oxc-parser's module record has no entry for `export {} from "./x"`, which still loads the module,
// so the scanner reads the statements off the tree; this pins every form the header lists.
test("importSpecifiers names every relative module a file loads, the empty re-export included", () => {
  const text = [
    'import { a } from "./a.ts";',
    'import type { B } from "./b.ts";',
    'export {} from "./empty.ts";',
    'export * from "./all.ts";',
    'export * as ns from "./ns.ts";',
    'export { e } from "./e.ts";',
    'export type { F } from "./f.ts";',
    'import "./side.ts";',
    'import R = require("./req.ts");',
    'type T = import("./type-import.ts").T;',
    'const lazy = () => import("./lazy.ts");',
    'const loaded = require("./loaded.ts");',
    'import { z } from "zod";',
    'export { y } from "yaml";',
  ].join("\n");
  expect(importSpecifiers(text, "src/x.ts")).toEqual([
    "./a.ts",
    "./b.ts",
    "./empty.ts",
    "./all.ts",
    "./ns.ts",
    "./e.ts",
    "./f.ts",
    "./side.ts",
    "./req.ts",
    "./type-import.ts",
    "./lazy.ts",
    "./loaded.ts",
  ]);
});

// The tree alone does not say which sibling bun loads for an extensionless specifier (phase.ts
// beside phase.tsx); the edge the lint draws must be the one bun follows.
test("resolveImport follows bun's extension order from the importer's directory and names an unresolvable import", async () => {
  await withTempDir((root) => {
    mkdirSync(join(root, "src", "dir"), { recursive: true });
    for (const file of ["x.ts", "phase.ts", "phase.tsx", "dir/index.ts", "dir/index.js"]) {
      writeFileSync(join(root, "src", file), "");
    }
    const importer = join(root, "src", "x.ts");
    const rows: [specifier: string, resolved: string][] = [
      // bun tries .tsx before .ts, then the same order under index (https://bun.com/docs/runtime/modules)
      ["./phase", "phase.tsx"],
      ["./dir", "dir/index.ts"],
      ["./phase.js", "phase.ts"],
    ];
    expect(rows.map(([specifier]) => resolveImport(importer, specifier))).toEqual(
      rows.map(([, resolved]) => join(root, "src", resolved)),
    );
    expect(() => resolveImport(importer, "./missing")).toThrow(
      `${importer} imports "./missing", which resolves to no file`,
    );
  });
});

// A dropped edge is the one silent failure the lint exists to refuse: the walk must surface the
// refusal from inside the visitor, naming file and line, rather than return the edges it did find.
test("a computed import() is refused naming the line, never read as a file with fewer edges", () => {
  expect(() => importSpecifiers('import "./a.ts";\nconst m = import(name);', "src/x.ts")).toThrow(
    "src/x.ts:2 loads a module through a computed specifier",
  );
});
