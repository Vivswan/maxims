// Guards the tree hash the CLI tests judge with: one blind to a content change would pass every
// "writes nothing" assertion vacuously.
import { describe, expect, test } from "bun:test";
import { symlinkSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { hashDirectory } from "./hash_directory.ts";
import { withTempDir } from "./temp_dir.ts";

describe("hashDirectory", () => {
  test("is deterministic over content, independent of creation order, and blind to symlinks", async () => {
    await withTempDir(async (dir) => {
      const a = join(dir, "a");
      const b = join(dir, "b");
      const secret = join(dir, "secret.txt");
      await mkdir(join(a, "sub"), { recursive: true });
      await mkdir(join(b, "sub"), { recursive: true });
      await writeFile(secret, "token\n");
      await writeFile(join(a, "sub", "two.md"), "two\n");
      await writeFile(join(a, "one.md"), "one\n");
      await writeFile(join(b, "one.md"), "one\n");
      await writeFile(join(b, "sub", "two.md"), "two\n");
      symlinkSync(secret, join(b, "leak.md"));

      const hashA = await hashDirectory(a);
      expect(await hashDirectory(b)).toBe(hashA);
      expect(hashA).toMatch(/^sha256:[0-9a-f]{64}$/);

      // The same length as before, so a hash that only saw sizes could not tell the change.
      await writeFile(join(b, "one.md"), "two\n");
      expect(await hashDirectory(b)).not.toBe(hashA);
    });
  });
});
