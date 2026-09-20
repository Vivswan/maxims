// Guards the write path every destination relies on: a temp file left behind, a traversal that
// escapes its root, or a directory hash that follows symlinks would each fail silently in sync.
import { describe, expect, test } from "bun:test";
import {
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { WINDOWS } from "../../tests/shared/platform.ts";
import { withTempDir } from "../../tests/shared/temp_dir.ts";
import { ExitCode, MaximsError } from "./exit-codes.ts";
import {
  assertInsideRoot,
  ensureDir0700,
  hashDirectory,
  type RootedPath,
  sha256,
  writeFileAtomic,
} from "./fs.ts";

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

describe("assertInsideRoot", () => {
  const root = resolve("/home/user/.agents/maxims/store");
  const cases: { candidate: string; ok: boolean }[] = [
    { candidate: `${root}/owner/repo/a.md`, ok: true },
    { candidate: root, ok: true },
    { candidate: `${root}/..foo/x.md`, ok: true },
    { candidate: `${root}/owner/../../store/x.md`, ok: true },
    { candidate: `${root}/../store-evil/x.md`, ok: false },
    { candidate: `${root}/owner/../../../x.md`, ok: false },
    { candidate: "/home/user/.agents/maxims/store2/x.md", ok: false },
    { candidate: "/etc/passwd", ok: false },
  ];
  test.each(cases)("$candidate inside root: $ok", ({ candidate, ok }) => {
    if (ok) {
      expect(assertInsideRoot(root, candidate)).toBe(resolve(candidate) as RootedPath);
      return;
    }
    let caught: unknown;
    try {
      assertInsideRoot(root, candidate);
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(MaximsError);
    expect((caught as MaximsError).code).toBe(ExitCode.DestinationWriteFailed);
  });
});

test("assertInsideRoot resolves symlinked ancestors but judges the final entry by where it sits", async () => {
  await withTempDir((dir) => {
    const root = join(dir, "root");
    const outside = join(dir, "outside");
    mkdirSync(root);
    mkdirSync(outside);
    symlinkSync(outside, join(root, "escape"));
    symlinkSync(join(root, "real"), join(root, "alias"));
    mkdirSync(join(root, "real"));
    let caught: unknown;
    try {
      assertInsideRoot(root, join(root, "escape", "victim.md"));
    } catch (error) {
      caught = error;
    }
    expect((caught as MaximsError).code).toBe(ExitCode.DestinationWriteFailed);
    expect(assertInsideRoot(root, join(root, "alias", "ok.md"))).toBe(
      join(root, "alias", "ok.md") as RootedPath,
    );
    symlinkSync(join(outside, "body.md"), join(root, "body.md"));
    expect(assertInsideRoot(root, join(root, "body.md"))).toBe(join(root, "body.md") as RootedPath);
    symlinkSync(join(root, "real", "file.md"), join(outside, "into-root.md"));
    caught = undefined;
    try {
      assertInsideRoot(root, join(outside, "into-root.md"));
    } catch (error) {
      caught = error;
    }
    expect((caught as MaximsError).code).toBe(ExitCode.DestinationWriteFailed);
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

test("sha256 renders the prefixed digest the state schema stores", () => {
  expect(sha256("abc")).toBe(
    "sha256:ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
  );
});

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

      await writeFile(join(b, "one.md"), "changed\n");
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

test("assertInsideRoot accepts a root whose own name is a symlink, for itself and its children", async () => {
  await withTempDir((dir) => {
    const real = join(dir, "real");
    const link = join(dir, "link");
    mkdirSync(real);
    symlinkSync(real, link);
    expect(assertInsideRoot(link, link)).toBe(link as RootedPath);
    expect(assertInsideRoot(link, join(link, "file.md"))).toBe(join(link, "file.md") as RootedPath);
    for (const outside of [join(link, "..", "escape.md"), join(dir, "outside.md"), dir]) {
      let caught: unknown;
      try {
        assertInsideRoot(link, outside);
      } catch (error) {
        caught = error;
      }
      expect((caught as MaximsError).code).toBe(ExitCode.DestinationWriteFailed);
    }
  });
});
