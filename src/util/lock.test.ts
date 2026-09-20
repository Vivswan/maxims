// Guards the concurrency table: a second writer that waits forever, a hook that blocks a session
// start, or a crashed holder's lock that is never stolen would each show up only under load.
import { describe, expect, test } from "bun:test";
import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { withTempDir } from "../../tests/shared/temp_dir.ts";
import { ExitCode, MaximsError } from "./exit-codes.ts";
import { withLock } from "./lock.ts";

async function expectLocked(promise: Promise<unknown>): Promise<MaximsError> {
  let caught: unknown;
  try {
    await promise;
  } catch (error) {
    caught = error;
  }
  expect(caught).toBeInstanceOf(MaximsError);
  expect((caught as MaximsError).code).toBe(ExitCode.StoreLocked);
  return caught as MaximsError;
}

describe("withLock", () => {
  test("two concurrent callers: the second waits, then fails naming the holder's command line", async () => {
    await withTempDir(async (dir) => {
      const lockPath = join(dir, "state.json.lock");
      let release: () => void = () => undefined;
      const held = new Promise<void>((done) => {
        release = done;
      });
      const first = withLock(lockPath, {}, async () => {
        await held;
        return "first";
      });
      await Bun.sleep(10);
      const error = await expectLocked(withLock(lockPath, { waitMs: 60 }, async () => "second"));
      expect(error.message).toContain(process.argv.join(" "));
      expect(error.hint).toContain(lockPath);
      release();
      expect(await first).toBe("first");
      expect(existsSync(lockPath)).toBe(false);
    });
  });

  test("a waiting caller proceeds once the holder releases", async () => {
    await withTempDir(async (dir) => {
      const lockPath = join(dir, "state.json.lock");
      const order: string[] = [];
      const first = withLock(lockPath, {}, async () => {
        await Bun.sleep(80);
        order.push("first");
      });
      await Bun.sleep(5);
      const second = withLock(lockPath, { waitMs: 2000 }, async () => {
        order.push("second");
      });
      await Promise.all([first, second]);
      expect(order).toEqual(["first", "second"]);
    });
  });

  test("hook mode (waitMs 0) fails immediately while a fresh lock is held", async () => {
    await withTempDir(async (dir) => {
      const lockPath = join(dir, "state.json.lock");
      writeFileSync(
        lockPath,
        `${JSON.stringify({
          pid: process.pid,
          host: "example.com",
          startedAt: new Date().toISOString(),
          argv: ["npx", "maxims", "add", "@example-user/rules"],
        })}\n`,
      );
      const started = Date.now();
      const error = await expectLocked(withLock(lockPath, { waitMs: 0 }, async () => "never"));
      expect(Date.now() - started).toBeLessThan(500);
      expect(error.message).toContain("npx maxims add @example-user/rules");
      expect(existsSync(lockPath)).toBe(true);
    });
  });

  test("a lock older than staleMs is stolen and the theft reported to the callback", async () => {
    await withTempDir(async (dir) => {
      const lockPath = join(dir, "state.json.lock");
      const startedAt = new Date(Date.now() - 120_000).toISOString();
      writeFileSync(
        lockPath,
        `${JSON.stringify({ pid: 999_999, host: "example.com", startedAt, argv: ["maxims", "sync"] })}\n`,
      );
      const seen = await withLock(lockPath, { waitMs: 0, staleMs: 60_000 }, async (lock) => lock);
      expect(seen.stolen?.holder).toEqual({
        pid: 999_999,
        host: "example.com",
        startedAt,
        argv: ["maxims", "sync"],
      });
      expect(seen.stolen?.ageMs).toBeGreaterThanOrEqual(120_000);
      expect(seen.stolen?.holderAlive).toBe(false);
      expect(existsSync(lockPath)).toBe(false);
    });
  });

  test("the lock is released when the callback throws", async () => {
    await withTempDir(async (dir) => {
      const lockPath = join(dir, "state.json.lock");
      await expect(
        withLock(lockPath, {}, async () => {
          throw new Error("boom");
        }),
      ).rejects.toThrow("boom");
      expect(existsSync(lockPath)).toBe(false);
    });
  });
});
