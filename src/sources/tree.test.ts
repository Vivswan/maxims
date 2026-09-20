// Guards the one tree walk both resolvers share: a symlink followed, a hidden directory scanned, or
// MEMORY.md collected would reach the store from every source type at once.
import { describe, expect, test } from "bun:test";
import { mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { withTempDir } from "../../tests/shared/temp_dir.ts";
import { ExitCode, MaximsError } from "../util/exit-codes.ts";
import { readMemoryTree } from "./tree.ts";

function seed(root: string): void {
  mkdirSync(join(root, "memories", "nested"), { recursive: true });
  mkdirSync(join(root, "memories", ".hidden"), { recursive: true });
  mkdirSync(join(root, "docs"), { recursive: true });
  writeFileSync(join(root, "memories", "b-rule.md"), "b\n");
  writeFileSync(join(root, "memories", "a-rule.md"), "a\n");
  writeFileSync(join(root, "memories", "nested", "c-rule.md"), "c\n");
  writeFileSync(join(root, "memories", "MEMORY.md"), "index\n");
  writeFileSync(join(root, "memories", "notes.txt"), "not a memory\n");
  writeFileSync(join(root, "memories", ".hidden", "h.md"), "hidden\n");
  writeFileSync(join(root, "memories", ".dotfile.md"), "hidden file\n");
  writeFileSync(join(root, "docs", "d-rule.md"), "d\n");
  writeFileSync(join(root, "README.md"), "readme\n");
  writeFileSync(join(root, "secret.txt"), "secret\n");
  symlinkSync(join(root, "secret.txt"), join(root, "memories", "x.md"));
  symlinkSync(join(root, "docs"), join(root, "memories", "linked-dir"));
}

describe("readMemoryTree", () => {
  test("collects sorted memory files under memoryPath, relative to the source root", async () => {
    await withTempDir(async (root) => {
      seed(root);
      const warnings: string[] = [];
      const tree = await readMemoryTree(root, { memoryPath: "memories", fullDepth: false }, (m) =>
        warnings.push(m),
      );
      expect(tree.scannedRoot).toBe(join(root, "memories"));
      expect(tree.files).toEqual([
        { relPath: "memories/a-rule.md", text: "a\n" },
        { relPath: "memories/b-rule.md", text: "b\n" },
        { relPath: "memories/nested/c-rule.md", text: "c\n" },
      ]);
      expect(warnings).toEqual([
        "skipped symlink linked-dir: links inside a source are never followed",
        "skipped symlink x.md: links inside a source are never followed",
      ]);
    });
  });

  test("fullDepth walks from the source root, keeps every .md, and still skips hidden entries", async () => {
    await withTempDir(async (root) => {
      seed(root);
      const tree = await readMemoryTree(
        root,
        { memoryPath: "memories", fullDepth: true },
        () => {},
      );
      expect(tree.scannedRoot).toBe(root);
      expect(tree.files.map((f) => f.relPath)).toEqual([
        "README.md",
        "docs/d-rule.md",
        "memories/a-rule.md",
        "memories/b-rule.md",
        "memories/nested/c-rule.md",
      ]);
    });
  });

  const failures: [string, { memoryPath: string; fullDepth: boolean }, RegExp][] = [
    ["a missing memoryPath", { memoryPath: "rules", fullDepth: false }, /has no rules directory/],
    [
      "a memoryPath that escapes the source",
      { memoryPath: "../outside", fullDepth: false },
      /escapes/,
    ],
    [
      "a memoryPath that is a file",
      { memoryPath: "README.md", fullDepth: false },
      /not a directory/,
    ],
  ];
  test.each(failures)("%s is exit 2", async (_label, scope, message) => {
    await withTempDir(async (root) => {
      seed(root);
      let caught: unknown;
      try {
        await readMemoryTree(root, scope, () => {});
      } catch (error) {
        caught = error;
      }
      expect(caught).toBeInstanceOf(MaximsError);
      expect((caught as MaximsError).code).toBe(ExitCode.SourceUnresolvable);
      expect((caught as MaximsError).message).toMatch(message);
    });
  });

  test("a memoryPath reached through a symlink is exit 2, even when the root is a symlink", async () => {
    await withTempDir(async (dir) => {
      const real = join(dir, "real");
      seed(real);
      mkdirSync(join(dir, "elsewhere"));
      writeFileSync(join(dir, "elsewhere", "leak-rule.md"), "leak\n");
      symlinkSync(real, join(dir, "root-link"));
      const viaRootLink = await readMemoryTree(
        join(dir, "root-link"),
        { memoryPath: "memories", fullDepth: false },
        () => {},
      );
      expect(viaRootLink.files.map((f) => f.relPath)).toEqual([
        "memories/a-rule.md",
        "memories/b-rule.md",
        "memories/nested/c-rule.md",
      ]);
      symlinkSync(join(dir, "elsewhere"), join(real, "linked"));
      let caught: unknown;
      try {
        await readMemoryTree(real, { memoryPath: "linked", fullDepth: false }, () => {});
      } catch (error) {
        caught = error;
      }
      expect((caught as MaximsError).code).toBe(ExitCode.SourceUnresolvable);
      expect((caught as MaximsError).message).toMatch(/reached through a symlink/);
    });
  });

  test("a missing source directory is exit 2", async () => {
    await withTempDir(async (root) => {
      let caught: unknown;
      try {
        await readMemoryTree(
          join(root, "gone"),
          { memoryPath: "memories", fullDepth: true },
          () => {},
        );
      } catch (error) {
        caught = error;
      }
      expect((caught as MaximsError).code).toBe(ExitCode.SourceUnresolvable);
    });
  });
});
