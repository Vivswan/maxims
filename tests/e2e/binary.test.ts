// Fails if the e2e runner lets a hung binary outlive its budget, or reads any signal death as its
// own kill: a hang would otherwise surface as a five-second test timeout, and a crash would lose
// the diagnostic the binary wrote before it died.
import { expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { WINDOWS } from "../shared/platform.ts";
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

test.skipIf(WINDOWS)("a binary that aborts returns its code with the diagnostic", async () => {
  await withTempDir(async (dir) => {
    const path = join(dir, "cli.js");
    writeFileSync(
      path,
      "process.stderr.write('assertion failed\\n'); process.kill(process.pid, 'SIGABRT'); setTimeout(() => {}, 20_000);\n",
    );
    const run = await runMaxims({ path, bytes: 0 }, makeHome(dir), ["sync"]);
    expect(run).toEqual({ code: 134, stdout: "", stderr: "assertion failed\n" });
  });
});
