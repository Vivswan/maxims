// Fails if the benchmark harness stops producing the record the CI latency job reads: the field
// names, the run count, and a real median are what the sticky PR comment is built from, and a
// mean or a NaN would flow through unnoticed. Also fails if a run leaves its throwaway HOME behind.
import { expect, test } from "bun:test";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const repoRoot = resolve(import.meta.dir, "..");

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

test("bun scripts/bench.ts --runs 3 --json <out> -- <command> writes the median record", () => {
  const dir = mkdtempSync(join(tmpdir(), "maxims-bench-"));
  try {
    const out = join(dir, "bench.json");
    const command = ["node", "-e", "process.exit(0)"];
    const bench = runBench(["--runs", "3", "--json", out, "--", ...command], dir);
    expect(bench.stderr.toString()).toBe("");
    expect(bench.exitCode).toBe(0);

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
    expect(readdirSync(dir)).toEqual(["bench.json"]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a failing command is reported instead of timed, and its HOME is still removed", () => {
  const dir = mkdtempSync(join(tmpdir(), "maxims-bench-"));
  try {
    const bench = runBench(["--runs", "1", "--", "node", "-e", "process.exit(3)"], dir);
    expect(bench.exitCode).not.toBe(0);
    expect(bench.stdout.toString()).toBe("");
    expect(bench.stderr.toString()).toContain("node -e process.exit(3) exited with code 3\n");
    expect(readdirSync(dir)).toEqual([]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
