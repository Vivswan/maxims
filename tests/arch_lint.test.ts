// Fails if the accommodation-vocabulary check stops being red outside a migrations/ folder, starts
// being red inside one, or reads a file architecture.yml excludes: either way the gate that keeps
// compatibility code in the ladder would disagree with the import lint about which files are
// source, with nothing else to notice.
import { expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { type Architecture, lintAccommodationVocabulary } from "../scripts/arch_lint.mts";
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
