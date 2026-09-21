// Fails if whereBytesLand stops answering with the real destination of a write: a symlinked prefix
// left lexical, a missing tail dropped, a relative spelling resolved against the wrong base, or a
// dangling link followed instead of refused would each let one of the scripts compare two paths
// that differ in spelling only, and write where its guard should have said no. Also fails if
// isInside starts judging by string prefix instead of by path segment, or if outsideCheckouts
// stops refusing a path inside a copy of the repository that carries no .git (the container tier
// runs the scripts from one) or starts guessing at the set of checkouts when git fails for any
// other reason.
import { expect, test } from "bun:test";
import { mkdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { basename, join, parse, relative, resolve } from "node:path";
import { isInside, outsideCheckouts, whereBytesLand } from "../scripts/lib/paths.ts";
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

const root = resolve("/repo");

const containments: [string, string, boolean][] = [
  [root, root, true],
  [root, join(root, "out", "bench.json"), true],
  [root, `${root}-sibling/bench.json`, false],
  [root, resolve(root, ".."), false],
  [join(root, "sub"), join(root, "bench.json"), false],
  ...(process.platform === "win32"
    ? ([
        ["C:\\Repo", "c:/repo/out.json", true],
        ["C:\\Repo", "D:\\Repo\\out.json", false],
      ] satisfies [string, string, boolean][])
    : []),
];

test.each(containments)("isInside(%p, %p) is %p", (inside, path, expected) => {
  expect(isInside(inside, path)).toBe(expected);
});

// A copy of the repository with no .git is what the container tier runs the scripts from; git
// finds no repository above it, which leaves the copy itself as the only checkout. Every other
// failure leaves the set of checkouts unknown, so refuse: a gitfile git cannot read, one pointing
// at a primary that has moved away (the primary is a checkout), and a primary whose own .git is
// damaged, which git skips and then reports as nothing found while its linked worktrees remain.
interface Listing {
  arrange: (root: string) => void;
  target: (dir: string, root: string) => string;
  expected: { path: (dir: string) => string } | { refusal: string };
}

const checkoutListings: [string, Listing][] = [
  [
    "a path inside a copy without .git is refused",
    {
      arrange: () => {},
      target: (_dir, root) => join(root, "out", "bench.json"),
      expected: { refusal: "refusing to write measured data inside the repository: " },
    },
  ],
  [
    "a path beside a copy without .git is allowed",
    {
      arrange: () => {},
      target: (dir) => join(dir, "bench.json"),
      expected: { path: (dir) => join(realpathSync.native(dir), "bench.json") },
    },
  ],
  [
    "a linked worktree whose primary moved away is refused before the path is judged",
    {
      arrange: (root) => writeFileSync(join(root, ".git"), `gitdir: ${join(root, "..", "gone")}\n`),
      target: (dir) => join(dir, "bench.json"),
      expected: {
        refusal: "cannot list the repository's checkouts: git worktree list exited with 128",
      },
    },
  ],
  [
    "a checkout whose own .git is damaged is refused before the path is judged",
    {
      arrange: (root) => {
        const init = Bun.spawnSync(["git", "-C", root, "init", "--quiet"], { stderr: "pipe" });
        if (init.exitCode !== 0) throw new Error(init.stderr.toString());
        rmSync(join(root, ".git", "HEAD"));
      },
      target: (dir) => join(dir, "bench.json"),
      expected: {
        refusal: "cannot list the repository's checkouts: git worktree list exited with 128",
      },
    },
  ],
  [
    "any other git failure is refused before the path is judged",
    {
      arrange: (root) => writeFileSync(join(root, ".git"), "garbage\n"),
      target: (dir) => join(dir, "bench.json"),
      expected: {
        refusal: "cannot list the repository's checkouts: git worktree list exited with 128",
      },
    },
  ],
];

// The ceiling keeps git from adopting a repository that happens to enclose the fixture directory
// (a TMPDIR inside a checkout); the helper spawns git with this process's environment.
test.each(checkoutListings)("outsideCheckouts: %s", async (_name, listing) => {
  await withTempDir((dir) => {
    const ceiling = process.env.GIT_CEILING_DIRECTORIES;
    process.env.GIT_CEILING_DIRECTORIES = dir;
    try {
      const root = join(dir, "copy");
      mkdirSync(root);
      writeFileSync(join(root, "package.json"), "{}\n");
      listing.arrange(root);
      const out = listing.target(dir, root);
      const { expected } = listing;
      if ("path" in expected) {
        expect(outsideCheckouts(out, root, "measured data", refuse)).toBe(expected.path(dir));
      } else {
        expect(() => outsideCheckouts(out, root, "measured data", refuse)).toThrow(
          expected.refusal,
        );
      }
    } finally {
      if (ceiling === undefined) delete process.env.GIT_CEILING_DIRECTORIES;
      else process.env.GIT_CEILING_DIRECTORIES = ceiling;
    }
  });
});
