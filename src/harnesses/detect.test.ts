// Guards the two readings a bare existence check gets wrong: a stray regular file at a harness's
// config path would count as an install, and a lookup the process is not allowed to make would
// pass for "not installed" instead of surfacing. Bun's statSync throws ENOTDIR for a path under a
// regular file even with throwIfNoEntry off, which is the third reading that would drift.
import { expect, test } from "bun:test";
import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { CHMOD_DENIES } from "../../tests/shared/platform.ts";
import { withTempDir } from "../../tests/shared/temp_dir.ts";
import { configDirExists } from "./detect.ts";

const readings: [string, (dir: string) => string, boolean][] = [
  ["a directory", (dir) => dir, true],
  ["a regular file", (dir) => join(dir, "file"), false],
  ["a missing entry", (dir) => join(dir, "missing"), false],
  ["a path under a regular file", (dir) => join(dir, "file", "child"), false],
];

test.each(readings)(
  "%s reads as installed only when it is a directory",
  async (_, pathIn, expected) => {
    await withTempDir(async (dir) => {
      writeFileSync(join(dir, "file"), "");
      expect(configDirExists(pathIn(dir))).toBe(expected);
    });
  },
);

test.skipIf(!CHMOD_DENIES)(
  "a lookup the process may not make surfaces instead of reading as absent",
  async () => {
    await withTempDir(async (dir) => {
      const locked = join(dir, "locked");
      mkdirSync(join(locked, "harness"), { recursive: true });
      chmodSync(locked, 0o000);
      try {
        expect(() => configDirExists(join(locked, "harness"))).toThrow(/EACCES/);
      } finally {
        chmodSync(locked, 0o700);
      }
    });
  },
);
