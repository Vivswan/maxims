// Fails if the benchmark harness stops producing the record the CI latency job reads: the field
// names, the run count, and a real median are what the sticky PR comment is built from, and a
// mean, a NaN, or a child that ran fewer times than --runs would flow through unnoticed. Also
// fails if a run leaves its throwaway HOME behind, if a failing child's stderr is swallowed, or if
// measured timings can be written inside the repository, where a commit would publish them,
// including through a symlink or a /proc alias whose lexical path lies outside the checkout, or
// into any other checkout of a repository the bench runs from a linked worktree of. Also fails if
// the bench guesses at that set of checkouts when git cannot list them or is not installed.
import { expect, test } from "bun:test";
import {
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, parse, relative, resolve, sep } from "node:path";
import { summarize } from "../scripts/bench.ts";

const repoRoot = resolve(import.meta.dir, "..");
const realRepoRoot = realpathSync(repoRoot);
const USAGE = "usage: bun scripts/bench.ts [--runs N] [--json path] -- <command...>\n";

// Samples where the mean and the median differ, so a switch to the mean fails these cases.
const summaries: [number[], ReturnType<typeof summarize>][] = [
  [[1, 2, 99], { medianMs: 2, minMs: 1, maxMs: 99 }],
  [[99, 1, 2], { medianMs: 2, minMs: 1, maxMs: 99 }],
  [[1, 2, 3, 99], { medianMs: 2.5, minMs: 1, maxMs: 99 }],
  [[7], { medianMs: 7, minMs: 7, maxMs: 7 }],
  [[0.0004, 1.0005, 2.00051], { medianMs: 1.001, minMs: 0, maxMs: 2.001 }],
];

test.each(summaries)(
  "summarize(%p) is the median, min, and max to the microsecond",
  (samples, expected) => {
    expect(summarize(samples)).toEqual(expected);
  },
);

// The bench creates its per-run HOME under the OS tmpdir; pointing TMPDIR at a directory the test
// owns lets the test see whether every run cleaned up after itself.
function runBench(args: string[], scratch: string) {
  return Bun.spawnSync(["bun", "scripts/bench.ts", ...args], {
    cwd: repoRoot,
    env: { ...process.env, TMPDIR: scratch },
    stdout: "pipe",
    stderr: "pipe",
  });
}

// A red run of a guard test writes exactly where the guard should have refused. The shallowest
// missing ancestor of each path is what such a run would create, and removing it afterwards takes
// everything under it along without touching what was already there. Descent stops at an entry
// that is not a directory, so a stray file or a dangling link is neither probed beneath nor removed.
function removerOfCreated(paths: string[]): () => void {
  const created = new Set<string>();
  for (const path of paths) {
    let current = parse(path).root;
    for (const segment of relative(current, path).split(sep)) {
      current = join(current, segment);
      if (lstatSync(current, { throwIfNoEntry: false }) === undefined) {
        created.add(current);
        break;
      }
      if (!statSync(current, { throwIfNoEntry: false })?.isDirectory()) break;
    }
  }
  return () => {
    for (const path of created) rmSync(path, { recursive: true, force: true });
  };
}

test("bun scripts/bench.ts --runs 3 --json <out> -- <command> runs the child 3 times in fresh homes", () => {
  const dir = mkdtempSync(join(tmpdir(), "maxims-bench-"));
  try {
    const out = join(dir, "bench.json");
    const log = join(dir, "runs.log");
    const command = [
      "node",
      "-e",
      "require('node:fs').appendFileSync(process.argv[1], process.env.HOME + '\\n')",
      log,
    ];
    const bench = runBench(["--runs", "3", "--json", out, "--", ...command], dir);
    expect(bench.stderr.toString()).toBe("");
    expect(bench.exitCode).toBe(0);

    const homes = readFileSync(log, "utf8").split("\n");
    expect(homes.pop()).toBe("");
    expect(homes).toHaveLength(3);
    expect(new Set(homes).size).toBe(3);
    for (const home of homes) expect(dirname(home)).toBe(dir);

    const record = JSON.parse(readFileSync(out, "utf8"));
    expect(JSON.parse(bench.stdout.toString())).toEqual(record);
    expect(Object.keys(record).sort()).toEqual(["command", "maxMs", "medianMs", "minMs", "runs"]);
    expect(record.command).toEqual(command);
    expect(record.runs).toBe(3);
    for (const key of ["medianMs", "minMs", "maxMs"]) {
      expect(Number.isFinite(record[key])).toBe(true);
      expect(record[key]).toBeGreaterThan(0);
    }
    expect(record.minMs).toBeLessThanOrEqual(record.medianMs);
    expect(record.medianMs).toBeLessThanOrEqual(record.maxMs);
    expect(readdirSync(dir).sort()).toEqual(["bench.json", "runs.log"]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

interface JsonTarget {
  jsonArg: string;
  // Where the bytes would land: the temp file for an accepted path, the file inside the
  // repository a lexical-only guard would let through for a refused one.
  target: string;
  // Fragments the refusal on stderr must name; undefined when the path is accepted.
  refusal: string[] | undefined;
}

// Names carry the test's own temp-dir token so a file another run left behind cannot collide.
// The bench runs with the repository as cwd, which is what makes the /proc alias point at it.
const jsonTargets: [string, (dir: string, token: string) => JsonTarget][] = [
  [
    "a plain path in the temp dir",
    (dir, token) => {
      const target = join(dir, `${token}.json`);
      return { jsonArg: target, target, refusal: undefined };
    },
  ],
  [
    "a relative path inside the repository",
    (_dir, token) => {
      const target = join(realRepoRoot, `${token}.json`);
      return { jsonArg: `${token}.json`, target, refusal: ["repository", target] };
    },
  ],
  [
    "an absolute path under an ignored directory",
    (_dir, token) => {
      const target = join(realRepoRoot, "dist", `${token}.json`);
      return {
        jsonArg: join(repoRoot, "dist", `${token}.json`),
        target,
        refusal: ["repository", target],
      };
    },
  ],
  [
    "a symlink in the temp dir pointing at the repository",
    (dir, token) => {
      symlinkSync(repoRoot, join(dir, "repo"));
      const target = join(realRepoRoot, `${token}.json`);
      return {
        jsonArg: join(dir, "repo", `${token}.json`),
        target,
        refusal: ["repository", target],
      };
    },
  ],
  [
    "a dangling symlink in the temp dir pointing into the repository",
    (dir, token) => {
      const target = join(realRepoRoot, `${token}.json`);
      const link = join(dir, "dangling.json");
      symlinkSync(target, link);
      return { jsonArg: link, target, refusal: ["dangling symlink", link] };
    },
  ],
  ...(process.platform === "linux"
    ? ([
        [
          "a /proc/self/cwd alias of the repository",
          (_dir, token) => {
            const target = join(realRepoRoot, `${token}.json`);
            return {
              jsonArg: join("/proc/self/cwd", `${token}.json`),
              target,
              refusal: ["repository", target],
            };
          },
        ],
      ] satisfies [string, (dir: string, token: string) => JsonTarget][])
    : []),
];

test.each(jsonTargets)("--json with %s is decided by where the bytes would land", (_name, plan) => {
  const dir = mkdtempSync(join(tmpdir(), "maxims-bench-"));
  try {
    const { jsonArg, target, refusal } = plan(dir, basename(dir));
    const removeStrays = removerOfCreated([target]);
    try {
      const log = join(dir, "runs.log");
      const command = [
        "node",
        "-e",
        "require('node:fs').appendFileSync(process.argv[1], 'x')",
        log,
      ];
      const bench = runBench(["--runs", "1", "--json", jsonArg, "--", ...command], dir);
      if (refusal !== undefined) {
        expect(bench.exitCode).toBe(2);
        expect(bench.stdout.toString()).toBe("");
        for (const fragment of refusal) expect(bench.stderr.toString()).toContain(fragment);
        expect(existsSync(log)).toBe(false);
        expect(existsSync(target)).toBe(false);
      } else {
        expect(bench.stderr.toString()).toBe("");
        expect(bench.exitCode).toBe(0);
        expect(readFileSync(log, "utf8")).toBe("x");
        expect(JSON.parse(readFileSync(target, "utf8")).runs).toBe(1);
      }
    } finally {
      removeStrays();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a failing command's stderr and exit code are reported with status 1, and its HOME is removed", () => {
  const dir = mkdtempSync(join(tmpdir(), "maxims-bench-"));
  try {
    const command = ["node", "-e", "process.stderr.write('child says no\\n'); process.exit(3)"];
    const bench = runBench(["--runs", "1", "--", ...command], dir);
    expect(bench.exitCode).toBe(1);
    expect(bench.stdout.toString()).toBe("");
    expect(bench.stderr.toString()).toBe(
      `child says no\nbench: ${command.join(" ")} exited with code 3\n`,
    );
    expect(readdirSync(dir).sort()).toEqual([]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

interface Fixture {
  primary: string;
  linked: string;
  other: string;
  bench: string;
}

// The bench derives the repository from its own location, so a copy of the script inside a
// fixture's linked worktree measures that fixture. Git's default-branch hint goes to stderr and
// is not an error; only the exit code says whether a step succeeded.
function fixtureWorktree(dir: string): Fixture {
  const primary = join(dir, "primary");
  const linked = join(dir, "linked");
  const other = join(dir, "other");
  mkdirSync(primary);
  const steps = [
    ["git", "-C", primary, "init", "--quiet"],
    ["git", "-C", primary, "commit", "--quiet", "--allow-empty", "-m", "root"],
    ["git", "-C", primary, "worktree", "add", "--quiet", linked],
    ["git", "-C", primary, "worktree", "add", "--quiet", other],
  ];
  for (const step of steps) {
    const ran = Bun.spawnSync(step, { stdout: "pipe", stderr: "pipe" });
    if (ran.exitCode !== 0) throw new Error(`${step.join(" ")}: ${ran.stderr.toString()}`);
  }
  mkdirSync(join(linked, "scripts"));
  const bench = join(linked, "scripts", "bench.ts");
  copyFileSync(join(repoRoot, "scripts", "bench.ts"), bench);
  return { primary, linked, other, bench };
}

const worktreeTargets: [string, (fixture: Fixture) => string, boolean][] = [
  ["the linked worktree itself", ({ linked }) => join(linked, "bench.json"), true],
  ["the primary checkout", ({ primary }) => join(primary, "bench.json"), true],
  ["another linked worktree", ({ other }) => join(other, "bench.json"), true],
  ["a sibling of every checkout", ({ primary }) => join(dirname(primary), "bench.json"), false],
];

test.each(worktreeTargets)(
  "--json into %s, from a linked worktree, is refused when it lands in any checkout",
  (_name, target, refused) => {
    const dir = mkdtempSync(join(tmpdir(), "maxims-bench-"));
    try {
      const fixture = fixtureWorktree(dir);
      const out = target(fixture);
      const log = join(dir, "runs.log");
      const command = [
        "node",
        "-e",
        "require('node:fs').appendFileSync(process.argv[1], 'x')",
        log,
      ];
      const bench = Bun.spawnSync(
        ["bun", fixture.bench, "--runs", "1", "--json", out, "--", ...command],
        {
          cwd: fixture.linked,
          env: { ...process.env, TMPDIR: dir },
          stdout: "pipe",
          stderr: "pipe",
        },
      );
      if (refused) {
        expect(bench.exitCode).toBe(2);
        expect(bench.stdout.toString()).toBe("");
        expect(bench.stderr.toString()).toContain(
          `inside the repository: ${realpathSync(dirname(out))}`,
        );
        expect(existsSync(log)).toBe(false);
        expect(existsSync(out)).toBe(false);
      } else {
        expect(bench.stderr.toString()).toBe("");
        expect(bench.exitCode).toBe(0);
        expect(readFileSync(log, "utf8")).toBe("x");
        expect(JSON.parse(readFileSync(out, "utf8")).runs).toBe(1);
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  },
);

interface GitFailure {
  bench: string;
  env: Record<string, string>;
  // Fragments the refusal on stderr must carry: git's own words and the bench's reason.
  fragments: string[];
}

// The bench derives the repository from its own location, so a copy of the script in a plain
// directory asks git about a checkout that is not one. The ceiling keeps git from adopting a
// repository that happens to enclose the OS tmpdir. With an empty PATH only git goes missing: the
// bench and its child are named by absolute path.
const gitFailures: [string, (dir: string) => GitFailure][] = [
  [
    "a checkout git does not recognize",
    (dir) => {
      mkdirSync(join(dir, "fixture", "scripts"), { recursive: true });
      const bench = join(dir, "fixture", "scripts", "bench.ts");
      copyFileSync(join(repoRoot, "scripts", "bench.ts"), bench);
      return {
        bench,
        env: { GIT_CEILING_DIRECTORIES: dirname(dir) },
        fragments: ["not a git repository", "git worktree list exited with 128"],
      };
    },
  ],
  [
    "no git on PATH",
    (dir) => {
      const emptyPath = join(dir, "empty-path");
      mkdirSync(emptyPath);
      return {
        bench: join(repoRoot, "scripts", "bench.ts"),
        env: { PATH: emptyPath },
        fragments: ['"git"'],
      };
    },
  ],
];

test.each(gitFailures)(
  "--json with %s is refused with exit 2 before the child runs or anything is written",
  (_name, plan) => {
    const dir = mkdtempSync(join(tmpdir(), "maxims-bench-"));
    try {
      const { bench, env, fragments } = plan(dir);
      const out = join(dir, "bench.json");
      const log = join(dir, "runs.log");
      const command = [
        process.execPath,
        "-e",
        "require('node:fs').appendFileSync(process.argv[1], 'x')",
        log,
      ];
      const ran = Bun.spawnSync([process.execPath, bench, "--json", out, "--", ...command], {
        cwd: dirname(dirname(bench)),
        env: { ...process.env, TMPDIR: dir, ...env },
        stdout: "pipe",
        stderr: "pipe",
      });
      expect(ran.exitCode).toBe(2);
      expect(ran.stdout.toString()).toBe("");
      const stderr = ran.stderr.toString();
      expect(stderr).toContain("bench: cannot list the repository's checkouts: ");
      for (const fragment of fragments) expect(stderr).toContain(fragment);
      expect(stderr.endsWith(USAGE)).toBe(true);
      expect(existsSync(log)).toBe(false);
      expect(existsSync(out)).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  },
);
