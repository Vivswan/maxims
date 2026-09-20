// Fails if whereBytesLand stops answering with the real destination of a write: a symlinked prefix
// left lexical, a missing tail dropped, a relative spelling resolved against the wrong base, or a
// dangling link followed instead of refused would each let one of the scripts compare two paths
// that differ in spelling only, and write where its guard should have said no.
import { expect, test } from "bun:test";
import { mkdirSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import { basename, join, parse, relative } from "node:path";
import { whereBytesLand } from "../scripts/lib/paths.ts";
import { withTempDir } from "./shared/temp_dir.ts";

const refuse = (message: string): never => {
  throw new Error(message);
};

interface Landing {
  input: string;
  expected: { path: string } | { refusal: string };
}

// The fixture directory is canonicalized the helper's way: macOS reaches its temp dir through a
// symlink and Windows spells it with a short name.
const landings: [string, (dir: string) => Landing][] = [
  [
    "a missing tail below a symlinked directory",
    (dir) => {
      mkdirSync(join(dir, "real"));
      symlinkSync(join(dir, "real"), join(dir, "link"));
      return {
        input: join(dir, "link", "a", "b.json"),
        expected: { path: join(realpathSync.native(dir), "real", "a", "b.json") },
      };
    },
  ],
  [
    "an existing file reached through a symlink",
    (dir) => {
      mkdirSync(join(dir, "real"));
      writeFileSync(join(dir, "real", "f.json"), "{}\n");
      symlinkSync(join(dir, "real", "f.json"), join(dir, "f.json"));
      return {
        input: join(dir, "f.json"),
        expected: { path: join(realpathSync.native(dir), "real", "f.json") },
      };
    },
  ],
  [
    "a relative spelling, resolved against the cwd",
    (dir) => ({
      input: relative(process.cwd(), join(dir, "x.json")),
      expected: { path: join(realpathSync.native(dir), "x.json") },
    }),
  ],
  [
    "a missing path directly below the filesystem root",
    (dir) => {
      const input = join(parse(dir).root, `${basename(dir)}-missing`, "x.json");
      return { input, expected: { path: input } };
    },
  ],
  [
    "a path through a dangling symlink",
    (dir) => {
      symlinkSync(join(dir, "nowhere"), join(dir, "dangling"));
      return {
        input: join(dir, "dangling", "x.json"),
        expected: {
          refusal: `refusing to write through the dangling symlink ${join(dir, "dangling")}`,
        },
      };
    },
  ],
];

test.each(landings)("whereBytesLand of %s", async (_name, plan) => {
  await withTempDir((dir) => {
    const { input, expected } = plan(dir);
    if ("path" in expected) expect(whereBytesLand(input, refuse)).toBe(expected.path);
    else expect(() => whereBytesLand(input, refuse)).toThrow(expected.refusal);
  });
});
