// Fails if the benchmark harness stops producing the record the CI latency job reads: the field
// names, the run count, and a real median are what the sticky PR comment is built from, and a
// mean or a NaN would flow through unnoticed.
import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const repoRoot = resolve(import.meta.dir, "..");

test("bun scripts/bench.ts --runs 3 --json <out> -- <command> writes the median record", () => {
  const dir = mkdtempSync(join(tmpdir(), "maxims-bench-"));
  try {
    const out = join(dir, "bench.json");
    const command = ["node", "-e", "process.exit(0)"];
    const bench = Bun.spawnSync(
      ["bun", "scripts/bench.ts", "--runs", "3", "--json", out, "--", ...command],
      { cwd: repoRoot, stdout: "pipe", stderr: "pipe" },
    );
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
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a failing command is reported instead of timed", () => {
  const bench = Bun.spawnSync(
    ["bun", "scripts/bench.ts", "--runs", "1", "--", "node", "-e", "process.exit(3)"],
    {
      cwd: repoRoot,
      stdout: "pipe",
      stderr: "pipe",
    },
  );
  expect(bench.exitCode).not.toBe(0);
  expect(bench.stdout.toString()).toBe("");
  expect(bench.stderr.toString()).toContain("node -e process.exit(3) exited with code 3\n");
});
