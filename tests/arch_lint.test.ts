// Fails if the accommodation-vocabulary check stops being red outside a migrations/ folder or
// starts being red inside one: either way the gate that keeps compatibility code in the ladder
// would stay green on a tree that broke the rule, with nothing else to notice.
import { expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { type Architecture, lintAccommodationVocabulary } from "../scripts/arch_lint.mts";
import { withTempDir } from "./shared/temp_dir.ts";

const ARCH: Architecture = { layers: { app: ["src/"] }, exclude: [], edges: {} };

test("a word of accommodation is a problem outside migrations/ and none inside", async () => {
  await withTempDir((root) => {
    mkdirSync(join(root, "src", "state", "migrations"), { recursive: true });
    writeFileSync(
      join(root, "src", "state", "store.ts"),
      "// Legacy files land here.\nconst note = 'kept for backward-compatibility';\n",
    );
    writeFileSync(
      join(root, "src", "state", "migrations", "rename-select.ts"),
      "// The legacy `select` key, deprecated by the list, becomes `names`.\n",
    );
    writeFileSync(join(root, "src", "state", "fixtures.json"), '{"note": "legacy"}\n');
    expect(lintAccommodationVocabulary(root, ARCH)).toEqual([
      'accommodation vocabulary "Legacy" at src/state/store.ts:1; compatibility with an older shape lives only under a migrations/ folder',
      'accommodation vocabulary "backward-compatibility" at src/state/store.ts:2; compatibility with an older shape lives only under a migrations/ folder',
    ]);
  });
});
