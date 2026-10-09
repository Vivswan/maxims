// Guards the write path every destination relies on: a temp file left behind or a traversal that
// escapes its root would each fail silently in sync. Also guards the tree hash the CLI tests judge
// with: one blind to a content change would pass every "writes nothing" assertion vacuously.
import { describe, expect, test } from "bun:test";
import {
  chmodSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { ExitCode, MaximsError } from "../../src/util/exit-codes.ts";
import {
  assertInsideRoot,
  ensureDir0700,
  type RootedPath,
  realpathOfExistingPrefix,
  writeFileAtomic,
} from "../../src/util/fs.ts";
import { outcome } from "../fuzz/shared.ts";
import { hashDirectory } from "../shared/hash_directory.ts";
import { CHMOD_DENIES, WINDOWS } from "../shared/platform.ts";
import { withTempDir } from "../shared/temp_dir.ts";

describe("writeFileAtomic", () => {
  test("writes the content, replaces it in place, and leaves no temp file behind", async () => {
    await withTempDir((dir) => {
      const target = assertInsideRoot(dir, join(dir, "nested", "rules.md"));
      writeFileAtomic(target, "one\n", { mode: 0o600 });
      writeFileAtomic(target, "two\n", { mode: 0o600 });
      expect(readFileSync(target, "utf8")).toBe("two\n");
      expect(readdirSync(join(dir, "nested"))).toEqual(["rules.md"]);
    });
  });

  test("a link at the destination becomes a real file and the link's target keeps its content", async () => {
    await withTempDir((dir) => {
      const target = join(dir, "store.md");
      const destination = join(dir, "dest.md");
      writeFileSync(target, "canonical\n");
      symlinkSync(target, destination);
      writeFileAtomic(assertInsideRoot(dir, destination), "rendered\n");
      expect(lstatSync(destination).isSymbolicLink()).toBe(false);
      expect(readFileSync(destination, "utf8")).toBe("rendered\n");
      expect(readFileSync(target, "utf8")).toBe("canonical\n");
      expect(readdirSync(dir).sort()).toEqual(["dest.md", "store.md"]);
    });
  });

  test("a failed write surfaces as exit 4 and leaves the directory as it was", async () => {
    await withTempDir((dir) => {
      const blocker = join(dir, "file");
      writeFileSync(blocker, "");
      let caught: unknown;
      try {
        writeFileAtomic(assertInsideRoot(dir, join(blocker, "child.md")), "x");
      } catch (error) {
        caught = error;
      }
      expect(caught).toBeInstanceOf(MaximsError);
      expect((caught as MaximsError).code).toBe(ExitCode.DestinationWriteFailed);
      expect(readdirSync(dir)).toEqual(["file"]);
    });
  });
});

// Rows through links share one fixture. Every folder exists before its alias is linked, so Windows
// creates a directory link: a file link to a directory there cannot be resolved.
//
//   link          -> real                      (a root that is itself a link)
//   root/escape   -> outside                   (a linked directory leaving the root)
//   root/alias    -> root/real                 (a linked directory staying inside)
//   root/body.md  -> outside/body.md           (an entry inside, its target outside)
//   outside/into-root.md -> root/real/file.md  (an entry outside, its target inside)
function plantLinks(dir: string): void {
  mkdirSync(join(dir, "real"));
  mkdirSync(join(dir, "outside"));
  mkdirSync(join(dir, "root", "real"), { recursive: true });
  symlinkSync(join(dir, "real"), join(dir, "link"));
  symlinkSync(join(dir, "outside"), join(dir, "root", "escape"));
  symlinkSync(join(dir, "root", "real"), join(dir, "root", "alias"));
  symlinkSync(join(dir, "outside", "body.md"), join(dir, "root", "body.md"));
  symlinkSync(join(dir, "root", "real", "file.md"), join(dir, "outside", "into-root.md"));
}

describe("assertInsideRoot", () => {
  const lexical = () => resolve("/home/user/.agents/maxims/store");
  const root = (dir: string) => join(dir, "root");
  const link = (dir: string) => join(dir, "link");
  const cases: {
    name: string;
    root: (dir: string) => string;
    candidate: (dir: string) => string;
    ok: boolean;
  }[] = [
    {
      name: "a file below the root",
      root: lexical,
      candidate: () => `${lexical()}/owner/repo/a.md`,
      ok: true,
    },
    { name: "the root itself", root: lexical, candidate: lexical, ok: true },
    {
      name: "a child named with two leading dots",
      root: lexical,
      candidate: () => `${lexical()}/..foo/x.md`,
      ok: true,
    },
    {
      name: "a traversal that comes back inside",
      root: lexical,
      candidate: () => `${lexical()}/owner/../../store/x.md`,
      ok: true,
    },
    {
      name: "a traversal to a sibling",
      root: lexical,
      candidate: () => `${lexical()}/../store-evil/x.md`,
      ok: false,
    },
    {
      name: "a traversal above the root",
      root: lexical,
      candidate: () => `${lexical()}/owner/../../../x.md`,
      ok: false,
    },
    {
      name: "a sibling sharing the root's name as a prefix",
      root: lexical,
      candidate: () => "/home/user/.agents/maxims/store2/x.md",
      ok: false,
    },
    {
      name: "an unrelated absolute path",
      root: lexical,
      candidate: () => "/etc/passwd",
      ok: false,
    },
    {
      name: "a file under a linked directory that leaves the root",
      root,
      candidate: (dir) => join(root(dir), "escape", "victim.md"),
      ok: false,
    },
    {
      name: "a file under a linked directory that stays inside",
      root,
      candidate: (dir) => join(root(dir), "alias", "ok.md"),
      ok: true,
    },
    {
      name: "a link inside whose target lies outside",
      root,
      candidate: (dir) => join(root(dir), "body.md"),
      ok: true,
    },
    {
      name: "a link outside whose target lies inside",
      root,
      candidate: (dir) => join(dir, "outside", "into-root.md"),
      ok: false,
    },
    { name: "a root that is itself a link, as itself", root: link, candidate: link, ok: true },
    {
      name: "a child of a linked root",
      root: link,
      candidate: (dir) => join(link(dir), "file.md"),
      ok: true,
    },
    {
      name: "a traversal out of a linked root",
      root: link,
      candidate: (dir) => join(link(dir), "..", "escape.md"),
      ok: false,
    },
    {
      name: "a sibling of a linked root",
      root: link,
      candidate: (dir) => join(dir, "outside.md"),
      ok: false,
    },
    { name: "the parent of a linked root", root: link, candidate: (dir) => dir, ok: false },
  ];

  test.each(cases)("$name: inside is $ok", async ({ root, candidate, ok }) => {
    await withTempDir((dir) => {
      plantLinks(dir);
      const verdict = outcome(() => assertInsideRoot(root(dir), candidate(dir)));
      if (ok) {
        expect(verdict).toEqual({ kind: "value", value: resolve(candidate(dir)) as RootedPath });
        return;
      }
      const error = verdict.kind === "threw" ? verdict.error : verdict;
      expect(error).toBeInstanceOf(MaximsError);
      expect((error as MaximsError).code).toBe(ExitCode.DestinationWriteFailed);
    });
  });
});

// Windows has no mode bits: the option is accepted there and changes nothing.
test.skipIf(WINDOWS)(
  "writeFileAtomic applies the requested mode on create and on rewrite regardless of the umask",
  async () => {
    await withTempDir((dir) => {
      // A permissive umask for the private file, where a lost mode shows as 0644; a restrictive
      // one for the executable, where a mode taken from the open call alone would show as 0700.
      const previous = process.umask(0o022);
      try {
        const state = assertInsideRoot(dir, join(dir, "state.json"));
        writeFileAtomic(state, "{}\n", { mode: 0o600 });
        writeFileAtomic(state, "{ }\n", { mode: 0o600 });
        expect(statSync(state).mode & 0o777).toBe(0o600);
        process.umask(0o077);
        const hook = assertInsideRoot(dir, join(dir, "hook.sh"));
        writeFileAtomic(hook, "#!/bin/sh\n", { mode: 0o755 });
        expect(statSync(hook).mode & 0o777).toBe(0o755);
      } finally {
        process.umask(previous);
      }
    });
  },
);

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

test("ensureDir0700 creates the chain and leaves the leaf owner-only", async () => {
  await withTempDir(async (dir) => {
    const leaf = join(dir, "x", "y");
    await ensureDir0700(leaf);
    await ensureDir0700(leaf);
    expect(statSync(leaf).isDirectory()).toBe(true);
    // Windows has no mode bits, so the leaf is only proven to exist there.
    if (!WINDOWS) expect(statSync(leaf).mode & 0o777).toBe(0o700);
  });
});

// What would drift silently: a prefix that exists but cannot be inspected answered with the lexical
// path, the same answer a path with no symlink gets, so a containment check or a sweep identity
// built on it would judge a destination it never looked at.
describe("realpathOfExistingPrefix", () => {
  test("resolves the deepest existing prefix through its link and keeps the missing tail as typed", async () => {
    await withTempDir((dir) => {
      const real = join(dir, "real");
      mkdirSync(real);
      symlinkSync(real, join(dir, "alias"));
      expect(realpathOfExistingPrefix(join(dir, "alias", "missing", "leaf.md"))).toBe(
        join(realpathSync(real), "missing", "leaf.md"),
      );
    });
  });

  test.skipIf(!CHMOD_DENIES)(
    "a prefix that exists but cannot be inspected is exit 4, never the lexical path",
    async () => {
      await withTempDir((dir) => {
        const locked = join(dir, "locked");
        mkdirSync(join(locked, "child"), { recursive: true });
        const probed = join(locked, "child", "leaf.md");
        chmodSync(locked, 0o000);
        try {
          let caught: unknown;
          try {
            realpathOfExistingPrefix(probed);
          } catch (error) {
            caught = error;
          }
          expect(caught).toBeInstanceOf(MaximsError);
          expect((caught as MaximsError).code).toBe(ExitCode.DestinationWriteFailed);
          expect((caught as MaximsError).message).toMatch(
            new RegExp(`^cannot inspect ${probed.replaceAll("\\", "\\\\")}: EACCES`),
          );
        } finally {
          chmodSync(locked, 0o755);
        }
      });
    },
  );
});
