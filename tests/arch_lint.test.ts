// Fails if the import scanner drops a form that loads a module, or if the accommodation-vocabulary
// check stops being red outside a migrations/ folder, starts being red inside one, or reads a file
// architecture.yml excludes: either way a gate would disagree with the import lint about which
// edges or which files exist, with nothing else to notice.
import { expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  type Architecture,
  importSpecifiers,
  lintAccommodationVocabulary,
} from "../scripts/arch_lint.mts";
import { withTempDir } from "./shared/temp_dir.ts";

const ARCH: Architecture = {
  layers: { app: ["src/"] },
  exclude: ["src/**/*.test.ts", "src/**/fixtures/**"],
  edges: {},
};

test("a word of accommodation is a problem outside migrations/, none inside or in an excluded file", async () => {
  await withTempDir((root) => {
    mkdirSync(join(root, "src", "state", "migrations"), { recursive: true });
    mkdirSync(join(root, "src", "state", "fixtures"), { recursive: true });
    writeFileSync(
      join(root, "src", "state", "store.ts"),
      "// Legacy files land here.\nconst note = 'kept for backward-compatibility';\n",
    );
    writeFileSync(
      join(root, "src", "state", "migrations", "rename-select.ts"),
      "// The legacy `select` key, deprecated by the list, becomes `names`.\n",
    );
    writeFileSync(join(root, "src", "state", "store.test.ts"), "// a deprecated test subject\n");
    writeFileSync(join(root, "src", "state", "fixtures", "older.ts"), "// an older file\n");
    writeFileSync(join(root, "src", "state", "fixtures.json"), '{"note": "legacy"}\n');
    expect(lintAccommodationVocabulary(root, ARCH)).toEqual([
      'accommodation vocabulary "Legacy" at src/state/store.ts:1; compatibility with an older shape lives only under a migrations/ folder',
      'accommodation vocabulary "backward-compatibility" at src/state/store.ts:2; compatibility with an older shape lives only under a migrations/ folder',
    ]);
  });
});

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

// A dropped edge is the one silent failure the lint exists to refuse: the walk must surface the
// refusal from inside the visitor, naming file and line, rather than return the edges it did find.
test("a computed import() is refused naming the line, never read as a file with fewer edges", () => {
  expect(() => importSpecifiers('import "./a.ts";\nconst m = import(name);', "src/x.ts")).toThrow(
    "src/x.ts:2 loads a module through a computed specifier",
  );
});
