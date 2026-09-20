// Guards the log's cap and its containment: without them a hooked machine with many sessions grows
// refresh.log forever, a naive truncation would cut a line in half, and a `log` entry replaced by a
// symlink would carry every session's append outside the maxims home.
import { expect, test } from "bun:test";
import { readdirSync, readFileSync, statSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import { withTempDir, withTempHome } from "../../tests/shared/temp_dir.ts";
import { ExitCode, MaximsError } from "./exit-codes.ts";
import { homePaths } from "./home.ts";
import { appendRefreshLog, MAX_LOG_BYTES } from "./log.ts";

test("appends one line per call and drops the oldest whole lines past the cap", async () => {
  await withTempHome(async (home) => {
    const path = homePaths(home).log;
    await appendRefreshLog(home, "first");
    await appendRefreshLog(home, "second\n");
    expect(readFileSync(path, "utf8")).toBe("first\nsecond\n");

    const line = `${"x".repeat(1023)}\n`;
    const count = Math.ceil(MAX_LOG_BYTES / line.length) + 3;
    for (let i = 0; i < count; i += 1) await appendRefreshLog(home, `${i}:${line.slice(0, -1)}`);
    const text = readFileSync(path, "utf8");
    expect(statSync(path).size).toBeLessThanOrEqual(MAX_LOG_BYTES);
    expect(text.endsWith(`${count - 1}:${line}`)).toBe(true);
    expect(text.startsWith("first")).toBe(false);
    for (const entry of text.split("\n").slice(0, -1)) expect(entry).toMatch(/^\d+:x+$/);
  });
});

test("a log directory that is a symlink out of the home is refused with exit 4, nothing written", async () => {
  await withTempHome(async (home) => {
    await withTempDir(async (outside) => {
      symlinkSync(outside, join(home, "log"));
      let caught: unknown;
      try {
        await appendRefreshLog(home, "leak");
      } catch (error) {
        caught = error;
      }
      expect(caught).toBeInstanceOf(MaximsError);
      expect((caught as MaximsError).code).toBe(ExitCode.DestinationWriteFailed);
      expect(readdirSync(outside)).toEqual([]);
    });
  });
});
