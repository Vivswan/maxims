// What would drift silently: a walker that follows a symlinked folder lists files outside the tree
// a row is proving untouched and never returns on a link loop. Bun's recursive `readdirSync`
// does follow one, so a swap to the platform call must fail here.
import { expect, test } from "bun:test";
import { mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { WINDOWS } from "./platform.ts";
import { withTempDir } from "./temp_dir.ts";
import { walkTree } from "./tree.ts";

test.skipIf(WINDOWS)("walkTree reports a symlink as one entry and never descends through it", () =>
  withTempDir((dir) => {
    const root = join(dir, "tree");
    mkdirSync(join(root, "a", "b"), { recursive: true });
    mkdirSync(join(root, "empty"));
    mkdirSync(join(dir, "outside"));
    writeFileSync(join(root, "a", "b", "f"), "f\n");
    writeFileSync(join(dir, "outside", "secret"), "secret\n");
    symlinkSync("a", join(root, "link"));
    symlinkSync("..", join(root, "a", "loop"));
    symlinkSync(join(dir, "outside"), join(root, "out"));
    symlinkSync("nowhere", join(root, "dangling"));

    expect(walkTree(root)).toEqual([
      { path: "a", kind: "dir" },
      { path: "a/b", kind: "dir" },
      { path: "a/b/f", kind: "file" },
      { path: "a/loop", kind: "symlink", target: ".." },
      { path: "dangling", kind: "symlink", target: "nowhere" },
      { path: "empty", kind: "dir" },
      { path: "link", kind: "symlink", target: "a" },
      { path: "out", kind: "symlink", target: join(dir, "outside") },
    ]);
    expect(walkTree(root, new Set(["a", "out"])).map((entry) => entry.path)).toEqual([
      "dangling",
      "empty",
      "link",
    ]);
  }),
);
