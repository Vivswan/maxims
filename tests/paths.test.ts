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
// at a primary that has moved away (the primary is a checkout), a primary whose own .git is
// damaged, which git skips and then reports as nothing found while its linked worktrees remain,
// and a copy inside a checkout that GIT_CEILING_DIRECTORIES hides from git, which reports the
// same nothing found while a write beside the copy lands in that checkout.
interface Fixture {
  root: string;
  ceiling: string;
}

interface Listing {
  arrange: (dir: string) => Fixture;
  target: (dir: string, root: string) => string;
  expected: { path: (dir: string) => string } | { refusal: (dir: string) => string };
}

function copyOfTree(parent: string): string {
  const root = join(parent, "copy");
  mkdirSync(root);
  writeFileSync(join(root, "package.json"), "{}\n");
  return root;
}

function gitInit(dir: string): void {
  const init = Bun.spawnSync(["git", "-C", dir, "init", "--quiet"], { stderr: "pipe" });
  if (init.exitCode !== 0) throw new Error(init.stderr.toString());
}

const copyAlone = (dir: string): Fixture => ({ root: copyOfTree(dir), ceiling: dir });
const gitFailed = (): string =>
  "cannot list the repository's checkouts: git worktree list exited with 128";

const checkoutListings: [string, Listing][] = [
  [
    "a path inside a copy without .git is refused",
    {
      arrange: copyAlone,
      target: (_dir, root) => join(root, "out", "bench.json"),
      expected: { refusal: () => "refusing to write measured data inside the repository: " },
    },
  ],
  [
    "a path beside a copy without .git is allowed",
    {
      arrange: copyAlone,
      target: (dir) => join(dir, "bench.json"),
      expected: { path: (dir) => join(realpathSync.native(dir), "bench.json") },
    },
  ],
  [
    "a path beside a copy inside a checkout git was kept from seeing is refused",
    {
      arrange: (dir) => {
        const checkout = join(dir, "checkout");
        mkdirSync(checkout);
        gitInit(checkout);
        return { root: copyOfTree(checkout), ceiling: checkout };
      },
      target: (dir) => join(dir, "checkout", "bench.json"),
      expected: {
        refusal: (dir) =>
          "cannot list the repository's checkouts: git found none, yet " +
          `${join(realpathSync.native(dir), "checkout")} has a .git`,
      },
    },
  ],
  [
    "a linked worktree whose primary moved away is refused before the path is judged",
    {
      arrange: (dir) => {
        const fixture = copyAlone(dir);
        writeFileSync(join(fixture.root, ".git"), `gitdir: ${join(dir, "gone")}\n`);
        return fixture;
      },
      target: (dir) => join(dir, "bench.json"),
      expected: { refusal: gitFailed },
    },
  ],
  [
    "a checkout whose own .git is damaged is refused before the path is judged",
    {
      arrange: (dir) => {
        const fixture = copyAlone(dir);
        gitInit(fixture.root);
        rmSync(join(fixture.root, ".git", "HEAD"));
        return fixture;
      },
      target: (dir) => join(dir, "bench.json"),
      expected: { refusal: gitFailed },
    },
  ],
  [
    "any other git failure is refused before the path is judged",
    {
      arrange: (dir) => {
        const fixture = copyAlone(dir);
        writeFileSync(join(fixture.root, ".git"), "garbage\n");
        return fixture;
      },
      target: (dir) => join(dir, "bench.json"),
      expected: { refusal: gitFailed },
    },
  ],
];

// The ceiling is the directory git may not climb into, so the fixture's own layout is all git
// sees; the helper spawns git with this process's environment. The .git walk above the root has
// no ceiling, so the two rows about a copy on its own need a temp HOME that no checkout encloses:
// a TMPDIR inside a checkout turns both into refusals naming that checkout.
test.each(checkoutListings)("outsideCheckouts: %s", async (_name, listing) => {
  await withTempDir((dir) => {
    const ceiling = process.env.GIT_CEILING_DIRECTORIES;
    const { root, ceiling: stop } = listing.arrange(dir);
    process.env.GIT_CEILING_DIRECTORIES = stop;
    try {
      const out = listing.target(dir, root);
      const { expected } = listing;
      if ("path" in expected) {
        expect(outsideCheckouts(out, root, "measured data", refuse)).toBe(expected.path(dir));
      } else {
        expect(() => outsideCheckouts(out, root, "measured data", refuse)).toThrow(
          expected.refusal(dir),
        );
      }
    } finally {
      if (ceiling === undefined) delete process.env.GIT_CEILING_DIRECTORIES;
      else process.env.GIT_CEILING_DIRECTORIES = ceiling;
    }
  });
});
