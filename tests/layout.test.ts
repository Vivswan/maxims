// Fails if a unit test lands beside its code again: bun discovers `*.test.ts` anywhere under the
// repository, so a file under src/ would run and pass while tests/ quietly stopped being the one
// place a reader looks for a module's tests.
import { expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join, sep } from "node:path";
import { srcPath } from "./shared/src_path.ts";
import { withTempDir } from "./shared/temp_dir.ts";

function testFilesUnder(root: string): string[] {
  return [...new Bun.Glob("**/*.test.ts").scanSync({ cwd: root })]
    .map((entry) => entry.split(sep).join("/"))
    .sort();
}

test("no *.test.ts sits under src/; unit tests live under tests/ mirroring it", async () => {
  await withTempDir((dir) => {
    mkdirSync(join(dir, "nested"));
    writeFileSync(join(dir, "nested", "planted.test.ts"), "");
    expect(testFilesUnder(dir)).toEqual(["nested/planted.test.ts"]);
  });
  expect(testFilesUnder(srcPath())).toEqual([]);
});
