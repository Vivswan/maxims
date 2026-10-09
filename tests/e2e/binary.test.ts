// Fails if the e2e runner lets a hung binary hold a test for longer than its budget: bun's own
// `timeout` has to kill the child and report the kill, or every hang in the suite would surface
// as a five-second test timeout with the child's output lost.
import { expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { withTempDir } from "../shared/temp_dir.ts";
import { makeHome, runMaxims } from "./binary.ts";

test("a binary that outlives its budget is killed and the run rejects naming the kill", async () => {
  await withTempDir(async (dir) => {
    const path = join(dir, "cli.js");
    writeFileSync(path, "process.stdout.write('partial'); setTimeout(() => {}, 20_000);\n");
    const started = performance.now();
    const run = runMaxims({ path, bytes: 0 }, makeHome(dir), ["sync"], { timeoutMs: 200 });
    await expect(run).rejects.toThrow("maxims sync was killed with SIGKILL; the budget is 200 ms");
    expect(performance.now() - started).toBeLessThan(3_000);
  });
});
