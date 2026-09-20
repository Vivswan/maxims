// Fails if the benchmark harness stops producing the record the CI latency job reads: the field
// names, the run count, and a real median are what the sticky PR comment is built from, and a
// mean, a NaN, or a child that ran fewer times than --runs would flow through unnoticed. Also
// fails if a run leaves its throwaway HOME behind, if a failing child's stderr is swallowed, or if
// measured timings can be written inside the repository, where a commit would publish them.
import { expect, test } from "bun:test";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { summarize } from "../scripts/bench.ts";

const repoRoot = resolve(import.meta.dir, "..");

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

// Names carry the test's own temp-dir token so a file another run left behind cannot collide.
const insideRepo: [string, (token: string) => string][] = [
  ["a relative path", (token) => `${token}.json`],
  [
    "an absolute path under an ignored directory",
    (token) => join(repoRoot, "dist", `${token}.json`),
  ],
];

test.each(insideRepo)(
  "--json with %s inside the repository is refused before any run",
  (_name, jsonArgFor) => {
    const dir = mkdtempSync(join(tmpdir(), "maxims-bench-"));
    try {
      const jsonArg = jsonArgFor(basename(dir));
      const log = join(dir, "runs.log");
      const command = [
        "node",
        "-e",
        "require('node:fs').appendFileSync(process.argv[1], 'x')",
        log,
      ];
      const bench = runBench(["--runs", "1", "--json", jsonArg, "--", ...command], dir);
      expect(bench.exitCode).toBe(2);
      expect(bench.stdout.toString()).toBe("");
      expect(bench.stderr.toString()).toBe(
        `bench: refusing to write measured data inside the repository: ${resolve(repoRoot, jsonArg)}\n` +
          "usage: bun scripts/bench.ts [--runs N] [--json path] -- <command...>\n",
      );
      expect(readdirSync(dir)).toEqual([]);
      expect(existsSync(resolve(repoRoot, jsonArg))).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  },
);

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
    expect(readdirSync(dir)).toEqual([]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
