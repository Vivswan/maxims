// Guards the one tree walk both resolvers share: a symlink followed, a hidden directory scanned, or
// MEMORY.md or a README collected would reach the store from every source type at once.
import { describe, expect, test } from "bun:test";
import { mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { readMemoryTree, type TreeFile, type TreeScope } from "../../src/sources/tree.ts";
import { ExitCode, MaximsError } from "../../src/util/exit-codes.ts";
import { withTempDir } from "../shared/temp_dir.ts";

function seed(root: string): void {
  mkdirSync(join(root, "memories", "nested"), { recursive: true });
  mkdirSync(join(root, "memories", ".hidden"), { recursive: true });
  mkdirSync(join(root, "docs"), { recursive: true });
  writeFileSync(join(root, "memories", "b-rule.md"), "b\n");
  writeFileSync(join(root, "memories", "a-rule.md"), "a\n");
  writeFileSync(join(root, "memories", "nested", "c-rule.md"), "c\n");
  writeFileSync(join(root, "memories", "MEMORY.md"), "index\n");
  writeFileSync(join(root, "memories", "README.md"), "about these memories\n");
  writeFileSync(join(root, "memories", "nested", "readme.md"), "about the nested ones\n");
  writeFileSync(join(root, "memories", "notes.txt"), "not a memory\n");
  writeFileSync(join(root, "memories", ".hidden", "h.md"), "hidden\n");
  writeFileSync(join(root, "memories", ".dotfile.md"), "hidden file\n");
  writeFileSync(join(root, "docs", "d-rule.md"), "d\n");
  writeFileSync(join(root, "README.md"), "readme\n");
  writeFileSync(join(root, "secret.txt"), "secret\n");
  symlinkSync(join(root, "secret.txt"), join(root, "memories", "x.md"));
  symlinkSync(join(root, "docs"), join(root, "memories", "linked-dir"));
}

// The root is seeded in place, or seeded under `real` and reached through a link beside it: the
// source root may itself be a symlink (a dotfiles checkout often is), and that link is the one
// the walk may follow.
function seededRoot(dir: string): string {
  seed(dir);
  return dir;
}

function linkedRoot(dir: string): string {
  seed(join(dir, "real"));
  symlinkSync(join(dir, "real"), join(dir, "root-link"));
  return join(dir, "root-link");
}

const MEMORIES: TreeFile[] = [
  { relPath: "memories/a-rule.md", text: "a\n" },
  { relPath: "memories/b-rule.md", text: "b\n" },
  { relPath: "memories/nested/c-rule.md", text: "c\n" },
];
const NEVER_FOLLOWED = "links inside a source are never followed";

describe("readMemoryTree", () => {
  const scans: [string, (dir: string) => string, TreeScope, string, TreeFile[], string[]][] = [
    [
      "collects sorted memory files under memoryPath, relative to the source root",
      seededRoot,
      { memoryPath: "memories", fullDepth: false },
      "memories",
      MEMORIES,
      [`skipped symlink linked-dir: ${NEVER_FOLLOWED}`, `skipped symlink x.md: ${NEVER_FOLLOWED}`],
    ],
    [
      "fullDepth walks from the source root, keeps every .md but the reserved names, and still skips hidden entries",
      seededRoot,
      { memoryPath: "memories", fullDepth: true },
      "",
      [{ relPath: "docs/d-rule.md", text: "d\n" }, ...MEMORIES],
      [
        `skipped symlink memories/linked-dir: ${NEVER_FOLLOWED}`,
        `skipped symlink memories/x.md: ${NEVER_FOLLOWED}`,
      ],
    ],
    [
      "a source root that is itself a symlink scans like a real one",
      linkedRoot,
      { memoryPath: "memories", fullDepth: false },
      "memories",
      MEMORIES,
      [`skipped symlink linked-dir: ${NEVER_FOLLOWED}`, `skipped symlink x.md: ${NEVER_FOLLOWED}`],
    ],
  ];
  test.each(scans)("%s", async (_label, rootOf, scope, scanned, files, expectedWarnings) => {
    await withTempDir(async (dir) => {
      const root = rootOf(dir);
      const warnings: string[] = [];
      await expect(readMemoryTree(root, scope, (m) => warnings.push(m))).resolves.toEqual({
        scannedRoot: join(root, scanned),
        files,
      });
      expect(warnings).toEqual(expectedWarnings);
    });
  });

  function leakedRoot(dir: string): string {
    const real = seededRoot(join(dir, "real"));
    mkdirSync(join(dir, "elsewhere"));
    writeFileSync(join(dir, "elsewhere", "leak-rule.md"), "leak\n");
    symlinkSync(join(dir, "elsewhere"), join(real, "linked"));
    return real;
  }

  const failures: [string, (dir: string) => string, TreeScope, RegExp][] = [
    [
      "a missing memoryPath",
      seededRoot,
      { memoryPath: "rules", fullDepth: false },
      /has no rules directory/,
    ],
    [
      "a memoryPath that escapes the source",
      seededRoot,
      { memoryPath: "../outside", fullDepth: false },
      /escapes/,
    ],
    [
      "a memoryPath that is a file",
      seededRoot,
      { memoryPath: "README.md", fullDepth: false },
      /not a directory/,
    ],
    [
      "a missing source directory",
      (dir) => join(dir, "gone"),
      { memoryPath: "memories", fullDepth: true },
      /gone is not a directory/,
    ],
    [
      "a memoryPath reached through a symlink",
      leakedRoot,
      { memoryPath: "linked", fullDepth: false },
      /reached through a symlink/,
    ],
  ];
  test.each(failures)("%s is exit 2", async (_label, rootOf, scope, message) => {
    await withTempDir(async (dir) => {
      const attempt = readMemoryTree(rootOf(dir), scope, () => {});
      await expect(attempt).rejects.toBeInstanceOf(MaximsError);
      await expect(attempt).rejects.toMatchObject({
        code: ExitCode.SourceUnresolvable,
        message: expect.stringMatching(message),
      });
    });
  });
});
