// Guards the write path every destination relies on: a temp file left behind or a traversal that
// escapes its root would each fail silently in sync.
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
import { join, resolve, sep } from "node:path";
import { ExitCode, MaximsError } from "../../src/util/exit-codes.ts";
import {
  assertInsideRoot,
  ensureDir0700,
  followLinks,
  isAbsent,
  type LinkChain,
  type RootedPath,
  realKeyOf,
  realpathOfExistingPrefix,
  writeFileAtomic,
} from "../../src/util/fs.ts";
import { outcome } from "../shared/outcome.ts";
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

  // What would drift silently: a `..` folded before the link in front of it is read, which is
  // what `realpathSync` does on node and on bun, so `link/../target` names the sibling the kernel
  // never opens. Past the deepest existing prefix the fold IS the answer: nothing is there for the
  // kernel to enter, so a link typed after such a `..` is kept as typed, not followed.
  //
  //   link     -> deep/dir
  //   alias    -> deep/target
  //   dangling -> nowhere
  //   notes.md    a file
  const plantKernelRows = (root: string): void => {
    mkdirSync(join(root, "deep", "dir"), { recursive: true });
    mkdirSync(join(root, "deep", "target"));
    mkdirSync(join(root, "target"));
    writeFileSync(join(root, "notes.md"), "");
    symlinkSync(join(root, "deep", "dir"), join(root, "link"));
    symlinkSync(join(root, "deep", "target"), join(root, "alias"));
    symlinkSync(join(root, "nowhere"), join(root, "dangling"));
  };
  const kernelRows: [string, string[], string[]][] = [
    [
      "a `..` after a linked folder steps out of the folder the link reached",
      ["link", "..", "target"],
      ["deep", "target"],
    ],
    [
      "the missing tail after such a `..` is appended as typed",
      ["link", "..", "target", "missing", "leaf.md"],
      ["deep", "target", "missing", "leaf.md"],
    ],
    [
      "a `..` after a file ends the walk, so a link typed after it stays as typed",
      ["notes.md", "..", "alias"],
      ["alias"],
    ],
    [
      "a `..` after a missing entry is folded, so a link typed after it stays as typed",
      ["missing", "..", "alias"],
      ["alias"],
    ],
    ["a `..` after a dangling link is folded the same way", ["dangling", "..", "alias"], ["alias"]],
  ];
  test.skipIf(WINDOWS).each(kernelRows)("%s", async (_name, typed, expected) => {
    await withTempDir((dir) => {
      const root = realpathSync(dir);
      plantKernelRows(root);
      expect(realpathOfExistingPrefix([root, ...typed].join(sep))).toBe(join(root, ...expected));
    });
  });

  // Win32 folds the typed path before any entry is looked at, so there the lexical answer is the
  // kernel's own.
  test.skipIf(!WINDOWS)(
    "a `..` after a linked folder is folded before the link is read",
    async () => {
      await withTempDir((dir) => {
        const root = realpathSync(dir);
        plantKernelRows(root);
        expect(realpathOfExistingPrefix([root, "link", "..", "target"].join(sep))).toBe(
          join(root, "target"),
        );
      });
    },
  );

  // The kernels disagree on which component a sealed folder fails at (macOS's realpath refuses
  // the folder it cannot open, Linux's the entry inside it); each resolver names the entry it was
  // asked about on both, never the lexical path and never the folder. A `..` out of the sealed
  // folder is the same refusal: the kernel enters the folder to leave it, where a lexical fold
  // never looks at it.
  const sealedResolvers: [string, (path: string) => string][] = [
    ["realpathOfExistingPrefix", realpathOfExistingPrefix],
    ["realKeyOf", realKeyOf],
  ];
  const sealedShapes: [string, string[]][] = [
    ["an entry inside it", ["child", "leaf.md"]],
    ["a `..` out of it", ["..", "leaf.md"]],
  ];
  const sealedRows = sealedResolvers.flatMap(([name, resolver]) =>
    sealedShapes.map(([shape, tail]): [string, (path: string) => string, string[]] => [
      `${name}, ${shape}`,
      resolver,
      tail,
    ]),
  );
  test.skipIf(!CHMOD_DENIES).each(sealedRows)(
    "%s: a folder on the way that cannot be searched is exit 4 naming the entry asked about",
    async (_name, resolver, tail) => {
      await withTempDir((dir) => {
        const locked = join(dir, "locked");
        mkdirSync(join(locked, "child"), { recursive: true });
        const asked = [locked, ...tail].join(sep);
        chmodSync(locked, 0o000);
        try {
          expect(outcome(() => resolver(asked))).toEqual({
            kind: "threw",
            error: expect.objectContaining({
              code: ExitCode.DestinationWriteFailed,
              message: expect.stringMatching(
                new RegExp(`^cannot inspect ${asked.replaceAll("\\", "\\\\")}: EACCES`),
              ),
            }),
          });
        } finally {
          chmodSync(locked, 0o755);
        }
      });
    },
  );

  // The kernels fail this at different reads: Linux hands out the cwd and refuses its realpath,
  // macOS refuses the cwd read itself (uv_cwd EACCES). Both are exit 4 naming the typed `.`.
  test.skipIf(!CHMOD_DENIES)(
    "the cwd under a folder that cannot be searched is exit 4 naming the typed `.`",
    async () => {
      await withTempDir((dir) => {
        const locked = join(dir, "locked");
        mkdirSync(join(locked, "child"), { recursive: true });
        const back = process.cwd();
        process.chdir(join(locked, "child"));
        chmodSync(locked, 0o000);
        try {
          expect(outcome(() => realpathOfExistingPrefix("."))).toEqual({
            kind: "threw",
            error: expect.objectContaining({
              code: ExitCode.DestinationWriteFailed,
              message: expect.stringMatching(/^cannot inspect \.: EACCES/),
            }),
          });
        } finally {
          chmodSync(locked, 0o755);
          process.chdir(back);
        }
      });
    },
  );

  // What would drift silently: the cwd read moved back out of the walk's try, where only macOS
  // CI sees it fail (the row above). Only a stub makes the read fail elsewhere, and bun's `resolve`
  // reads the cwd natively, so the stub reaches the read only where the code makes it itself.
  test("a cwd the kernel refuses to read is exit 4 naming the typed `.`", () => {
    const cwd = process.cwd;
    process.cwd = () => {
      throw Object.assign(new Error("EACCES: process.cwd failed with error permission denied"), {
        code: "EACCES",
      });
    };
    try {
      expect(outcome(() => realpathOfExistingPrefix("."))).toEqual({
        kind: "threw",
        error: expect.objectContaining({
          code: ExitCode.DestinationWriteFailed,
          message: expect.stringMatching(/^cannot inspect \.: EACCES/),
        }),
      });
    } finally {
      process.cwd = cwd;
    }
  });
});

// What would drift silently: node's realpathSync folds `jump/../file` before it looks at `jump`,
// so a chain read through it names a file the kernel never opens, and the two kernels disagree on
// what a `..`, a trailing `.`, and a long chain mean. Each table is one kernel's reading, held to
// that kernel's own open of the link where the host is that platform.
//
//   notes.md            "notes"
//   maxims-x.md         "root"            (where Windows's fold of `jump\..\maxims-x.md` lands)
//   rules/notes.md      "under rules"
//   rules/plain.md      "rules"
//   rules/maxims-x.md   -> ../notes.md
//   rules/sub/bridge.md -> ../notes.md
//   jump                -> rules/sub
//   alias               -> rules
//   L1 -> L2 -> ... -> Ln -> notes.md      (n links, planted by the rows that need them)
//   AGENTS.md           -> the row's route (at `alias/AGENTS.md` where the row says so)
describe("followLinks", () => {
  type Place = (rel: string) => string;
  type Row = {
    name: string;
    route: string;
    link?: string;
    planted?: number;
    text: string | null;
    chain: (at: Place) => LinkChain;
  };
  const reached =
    (hops: string[], end: string) =>
    (at: Place): LinkChain => ({ kind: "reached", hops: hops.map(at), end: at(end) });
  const broken = (): LinkChain => ({ kind: "broken", hops: [] });
  const looped =
    (hops: string[]) =>
    (at: Place): LinkChain => ({ kind: "looped", hops: hops.map(at) });
  const links = (n: number): string[] => Array.from({ length: n }, (_, i) => `L${i + 1}`);
  // Both kernels read a relative target from the folder the link's own path reached, a folder
  // link before it followed, and the walk names that folder by its real path.
  const fromTheRealFolder: Row[] = [
    {
      name: "a .. in a link inside a linked folder climbs from the folder the link reached",
      route: "jump/bridge.md",
      text: "under rules\n",
      chain: reached(["jump", "rules/sub/bridge.md", "rules/notes.md"], "rules/notes.md"),
    },
    {
      name: "a link whose own folder is reached through a folder link is named by the real folder",
      route: "plain.md",
      link: "alias/AGENTS.md",
      text: "rules\n",
      chain: reached(["rules/plain.md"], "rules/plain.md"),
    },
  ];
  const tables: { platform: NodeJS.Platform; separator: string; rows: Row[] }[] = [
    {
      platform: "linux",
      separator: "/",
      rows: [
        {
          name: "a .. after a linked folder steps out of the folder the link reached",
          route: "jump/../maxims-x.md",
          text: "notes\n",
          chain: reached(["jump", "rules/maxims-x.md", "notes.md"], "notes.md"),
        },
        ...fromTheRealFolder,
        {
          name: "a .. after a missing folder",
          route: "missing/../notes.md",
          text: null,
          chain: broken,
        },
        { name: "a .. after a file", route: "notes.md/../notes.md", text: null, chain: broken },
        {
          name: "a file named with a trailing separator",
          route: "notes.md/",
          text: null,
          chain: broken,
        },
        {
          name: "a file named with a trailing dot",
          route: "notes.md/.",
          text: null,
          chain: broken,
        },
        {
          name: "a chain of 41 links, past the kernel's bound of 40",
          route: "L1",
          planted: 40,
          text: null,
          chain: looped(links(40)),
        },
      ],
    },
    {
      platform: "win32",
      separator: "\\",
      rows: [
        {
          name: "a .. after a linked folder is folded away before the link is read",
          route: "jump\\..\\maxims-x.md",
          text: "root\n",
          chain: reached(["maxims-x.md"], "maxims-x.md"),
        },
        ...fromTheRealFolder,
        {
          name: "a .. after a missing folder is folded away",
          route: "missing\\..\\notes.md",
          text: "notes\n",
          chain: reached(["notes.md"], "notes.md"),
        },
        {
          name: "a .. after a file is folded away",
          route: "notes.md\\..\\notes.md",
          text: "notes\n",
          chain: reached(["notes.md"], "notes.md"),
        },
        {
          name: "a file named with a trailing separator",
          route: "notes.md\\",
          text: null,
          chain: broken,
        },
        {
          name: "a file named with a trailing dot is the file",
          route: "notes.md\\.",
          text: "notes\n",
          chain: reached(["notes.md"], "notes.md"),
        },
        {
          name: "a chain of 41 links, within the kernel's bound of 63",
          route: "L1",
          planted: 40,
          text: "notes\n",
          chain: reached([...links(40), "notes.md"], "notes.md"),
        },
        {
          name: "a chain of 64 links, past the kernel's bound of 63",
          route: "L1",
          planted: 63,
          text: null,
          chain: looped(links(63)),
        },
      ],
    },
  ];
  // What the kernel hands back through a path: its text, or null where it refuses the path. A
  // failure to look (EACCES, EIO) is neither and fails the row.
  const opens = (path: string): string | null => {
    try {
      return readFileSync(path, "utf8");
    } catch (cause) {
      if (isAbsent(cause) || (cause as NodeJS.ErrnoException).code === "ELOOP") return null;
      throw cause;
    }
  };
  // The Windows table runs on every host, since a POSIX link keeps the backslashes in its target;
  // the POSIX table only on POSIX hosts, since a Windows link may rewrite its target's separators.
  for (const { platform, separator, rows } of tables) {
    const hostKernel = platform === "win32" ? WINDOWS : !WINDOWS;
    const runs = platform === "win32" || !WINDOWS;
    const where = runs ? "" : " (POSIX hosts only)";
    test.skipIf(!runs).each(rows)(
      `${platform}${where}: $name`,
      async ({ route, link, planted, text, chain }) => {
        await withTempDir((dir) => {
          const at: Place = (rel) => join(dir, ...rel.split("/"));
          mkdirSync(at("rules/sub"), { recursive: true });
          writeFileSync(at("notes.md"), "notes\n");
          writeFileSync(at("maxims-x.md"), "root\n");
          writeFileSync(at("rules/notes.md"), "under rules\n");
          writeFileSync(at("rules/plain.md"), "rules\n");
          symlinkSync(`..${separator}notes.md`, at("rules/maxims-x.md"));
          symlinkSync(`..${separator}notes.md`, at("rules/sub/bridge.md"));
          symlinkSync(at("rules/sub"), at("jump"));
          symlinkSync("rules", at("alias"));
          for (let i = 1; i <= (planted ?? 0); i++) {
            symlinkSync(i === planted ? "notes.md" : `L${i + 1}`, at(`L${i}`));
          }
          const linkAt = at(link ?? "AGENTS.md");
          symlinkSync(route, linkAt);
          const read = followLinks(linkAt, platform);
          const walked = read.kind === "reached" ? opens(read.end) : null;
          const kernel = hostKernel ? opens(linkAt) : text;
          expect([kernel, walked, read]).toEqual([text, text, chain(at)]);
          expect(followLinks(at("notes.md"), platform)).toEqual(reached([], "notes.md")(at));
        });
      },
    );
  }

  // What would drift silently: a `..` in a target stepped lexically, so the chain reports a file
  // reached where the kernel's own open refuses to enter the folder the `..` leaves.
  test.skipIf(!CHMOD_DENIES)(
    "a .. out of a folder that cannot be searched is exit 4 naming that folder, as the kernel refuses the open",
    async () => {
      await withTempDir((dir) => {
        const root = realpathSync(dir);
        const locked = join(root, "locked");
        mkdirSync(locked);
        writeFileSync(join(root, "notes.md"), "notes\n");
        const link = join(root, "AGENTS.md");
        symlinkSync(["locked", "..", "notes.md"].join(sep), link);
        chmodSync(locked, 0o000);
        try {
          expect(outcome(() => readFileSync(link, "utf8"))).toEqual({
            kind: "threw",
            error: expect.objectContaining({ code: "EACCES" }),
          });
          expect(outcome(() => followLinks(link))).toEqual({
            kind: "threw",
            error: expect.objectContaining({
              code: ExitCode.DestinationWriteFailed,
              message: expect.stringMatching(new RegExp(`^cannot inspect ${locked}: EACCES`)),
            }),
          });
        } finally {
          chmodSync(locked, 0o755);
        }
      });
    },
  );
});
