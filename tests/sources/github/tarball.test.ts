// Guards the archive boundary: a traversal entry, an absolute path, or a symlink written from a
// crafted tarball would put attacker-chosen bytes outside the temp dir or a secret inside the store.
import { describe, expect, test } from "bun:test";
import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { extractTarball } from "../../../src/sources/github/tarball.ts";
import { withTempDir } from "../../shared/temp_dir.ts";
import {
  absolutePathTarball,
  cleanTarball,
  FIXTURE_MEMORIES,
  symlinkTarball,
  truncatedTarball,
  unsupportedTypeTarball,
  windowsHostileNamesTarball,
  zipSlipTarball,
} from "./fakes/tarballs.ts";

// Entries are listed with forward slashes on every platform: the cases spell tar paths, which
// carry no other separator.
function listTree(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true, recursive: true })) {
    const rel = relative(dir, join(entry.parentPath, entry.name)).split(sep).join("/");
    out.push(entry.isDirectory() ? `${rel}/` : rel);
  }
  return out.sort();
}

describe("extractTarball", () => {
  test("a clean GitHub tarball lands at the repository root with the top folder stripped", async () => {
    await withTempDir(async (dir) => {
      const dest = join(dir, "tree");
      const warnings: string[] = [];
      await extractTarball(cleanTarball(), dest, (m) => warnings.push(m));
      expect(warnings).toEqual([]);
      expect(listTree(dest)).toEqual([
        "README.md",
        "memories/",
        "memories/commit-review.md",
        "memories/tests-first.md",
      ]);
      expect(readFileSync(join(dest, "memories", "tests-first.md"), "utf8")).toBe(
        FIXTURE_MEMORIES["tests-first"],
      );
    });
  });

  // Without this, a repository holding one such name fails the whole fetch: on Windows, where git
  // is absent, the name cannot be written as it is, and at the root `c:` reads as a drive anywhere.
  test("names Windows cannot write are mapped there, and a root name read as a drive is skipped", async () => {
    await withTempDir(async (dir) => {
      const dest = join(dir, "tree");
      const warnings: string[] = [];
      await extractTarball(windowsHostileNamesTarball(), dest, (m) => warnings.push(m));
      expect(warnings).toEqual([
        "skipped tarball entry example-user-rules-0123abc/c:d.md: absolute paths are rejected",
      ]);
      expect(listTree(dest)).toEqual(
        process.platform === "win32"
          ? ["memories/", "memories/a\uf03ab.md", "memories/what\uf03f.md"]
          : ["memories/", "memories/a:b.md", "memories/what?.md"],
      );
    });
  });

  const hostile: [string, () => Uint8Array, string[]][] = [
    [
      "zip-slip",
      zipSlipTarball,
      [
        "skipped tarball entry example-user-rules-0123abc/memories/../../evil.md: path traversal is rejected",
        "skipped tarball entry ../../evil.md: path traversal is rejected",
      ],
    ],
    [
      "absolute path",
      absolutePathTarball,
      ["skipped tarball entry /tmp/maxims-absolute-evil.md: absolute paths are rejected"],
    ],
    [
      "symlink and hardlink",
      symlinkTarball,
      [
        "skipped tarball entry example-user-rules-0123abc/memories/x.md: SymbolicLink entries are never extracted",
        "skipped tarball entry example-user-rules-0123abc/memories/y.md: Link entries are never extracted",
      ],
    ],
    [
      "unknown type flag",
      unsupportedTypeTarball,
      [
        "skipped tarball entry example-user-rules-0123abc/memories/odd.md: Unsupported entries are never extracted",
      ],
    ],
  ];
  test.each(hostile)(
    "%s entries write nothing outside the tree and warn",
    async (_label, tarball, expected) => {
      await withTempDir(async (dir) => {
        mkdirSync(join(dir, "sibling"));
        const dest = join(dir, "nested", "tree");
        const warnings: string[] = [];
        await extractTarball(tarball(), dest, (m) => warnings.push(m));
        expect(warnings).toEqual(expected);
        expect(listTree(dest)).toEqual(["memories/", "memories/ok.md"]);
        expect(listTree(dir)).toEqual([
          "nested/",
          "nested/tree/",
          "nested/tree/memories/",
          "nested/tree/memories/ok.md",
          "sibling/",
        ]);
        expect(existsSync("/tmp/maxims-absolute-evil.md")).toBe(false);
        expect(lstatSync(join(dest, "memories", "ok.md")).isSymbolicLink()).toBe(false);
      });
    },
  );

  // The race is what tells a rejection from a hang. The tree left behind holds the cut-off file:
  // the ladder empties the directory before the next rung, so nothing ever reads it.
  const broken: [string, () => Uint8Array, string[]][] = [
    ["an archive cut off inside a file", truncatedTarball, ["memories/", "memories/big-rule.md"]],
    ["bytes that are not an archive", () => new TextEncoder().encode("not a tarball"), []],
  ];
  test.each(broken)("%s rejects instead of waiting or extracting", async (_label, bytes, tree) => {
    await withTempDir(async (dir) => {
      const dest = join(dir, "tree");
      const outcome = await Promise.race([
        extractTarball(bytes(), dest, () => {}).then(
          () => "resolved",
          (error: Error) => `rejected: ${error.message}`,
        ),
        new Promise<string>((resolve) => setTimeout(() => resolve("hung"), 2000)),
      ]);
      expect(outcome).toMatch(/^rejected: /);
      expect(listTree(dest)).toEqual(tree);
    });
  });
});
