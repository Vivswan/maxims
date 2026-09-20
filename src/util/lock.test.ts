// Guards the concurrency table: a second writer that waits forever, a hook that blocks a session
// start, a crashed holder's lock that is never stolen, or a live holder whose long sync is stolen
// from under it would each show up only under load.
import { describe, expect, test } from "bun:test";
import { existsSync, readdirSync, readFileSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { withTempDir } from "../../tests/shared/temp_dir.ts";
import { ExitCode, MaximsError } from "./exit-codes.ts";
import { type LockOptions, withLock } from "./lock.ts";

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

function writeStaleLock(lockPath: string, holder: Record<string, unknown>, ageMs: number): void {
  writeFileSync(lockPath, `${JSON.stringify(holder)}\n`);
  const then = new Date(Date.now() - ageMs);
  utimesSync(lockPath, then, then);
}

type ChildHolder = {
  pid: number;
  kill: (signal: "SIGTERM") => Promise<{ exitCode: number | null; signalCode: string | null }>;
};

const HOLDER_SCRIPT = `
const { withLock } = await import(process.argv[1]);
await withLock(process.argv[2], JSON.parse(process.argv[3]), async () => {
  console.log(String(process.pid));
  await Bun.stdin.text();
});
`;

// A holder in another process, so a signal aimed at it leaves exactly what a real interrupt leaves.
async function holdInChild(lockPath: string, options: LockOptions): Promise<ChildHolder> {
  const proc = Bun.spawn(
    [
      process.execPath,
      "-e",
      HOLDER_SCRIPT,
      join(import.meta.dir, "lock.ts"),
      lockPath,
      JSON.stringify(options),
    ],
    { stdin: "pipe", stdout: "pipe", stderr: "inherit" },
  );
  const reader = proc.stdout.getReader();
  let text = "";
  while (!text.includes("\n")) {
    const chunk = await reader.read();
    if (chunk.done) throw new Error(`child holder exited with ${await proc.exited}`);
    text += new TextDecoder().decode(chunk.value);
  }
  return {
    pid: Number(text.slice(0, text.indexOf("\n"))),
    kill: async (signal) => {
      proc.kill(signal);
      await proc.exited;
      return { exitCode: proc.exitCode, signalCode: proc.signalCode };
    },
  };
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

  test("a live holder past staleMs keeps its lock: the heartbeat refreshes it, so a hook is refused", async () => {
    await withTempDir(async (dir) => {
      const lockPath = join(dir, "state.json.lock");
      const record = await withLock(lockPath, { staleMs: 2000 }, async () => {
        await Bun.sleep(3200);
        const error = await expectLocked(
          withLock(lockPath, { waitMs: 0, staleMs: 2000 }, async () => "stolen"),
        );
        expect(error.message).toContain(`pid ${process.pid}`);
        return readFileSync(lockPath, "utf8");
      });
      expect(JSON.parse(record).pid).toBe(process.pid);
      expect(existsSync(lockPath)).toBe(false);
    });
  }, 10_000);

  test("a lock older than staleMs is stolen and the theft reported to the callback", async () => {
    await withTempDir(async (dir) => {
      const lockPath = join(dir, "state.json.lock");
      const startedAt = new Date(Date.now() - 120_000).toISOString();
      writeStaleLock(
        lockPath,
        { pid: 2 ** 31 - 1, host: "example.com", startedAt, argv: ["maxims", "sync"] },
        120_000,
      );
      const seen = await withLock(lockPath, { waitMs: 0, staleMs: 60_000 }, async (lock) => lock);
      expect(seen.stolen?.holder).toEqual({
        pid: 2 ** 31 - 1,
        host: "example.com",
        startedAt,
        argv: ["maxims", "sync"],
      });
      expect(seen.stolen?.ageMs).toBeGreaterThanOrEqual(120_000);
      expect(seen.stolen?.holderAlive).toBe(false);
      expect(existsSync(lockPath)).toBe(false);
    });
  });

  test("two stealers racing on one stale lock: one theft, and their callbacks never overlap", async () => {
    await withTempDir(async (dir) => {
      const lockPath = join(dir, "state.json.lock");
      const startedAt = new Date(Date.now() - 120_000).toISOString();
      writeStaleLock(
        lockPath,
        { pid: 2 ** 31 - 1, host: "example.com", startedAt, argv: [] },
        120_000,
      );
      let inside = 0;
      let overlap = 0;
      const run = () =>
        withLock(lockPath, { waitMs: 3000, staleMs: 60_000 }, async (lock) => {
          inside += 1;
          if (inside > 1) overlap += 1;
          await Bun.sleep(40);
          inside -= 1;
          return lock.stolen !== null;
        });
      const thefts = (await Promise.all([run(), run()])).filter(Boolean).length;
      expect(overlap).toBe(0);
      expect(thefts).toBe(1);
      expect(existsSync(lockPath)).toBe(false);
    });
  });

  test("a fresh lock with no record yet is neither stolen nor clobbered", async () => {
    await withTempDir(async (dir) => {
      const lockPath = join(dir, "state.json.lock");
      writeFileSync(lockPath, "");
      const started = Date.now();
      await expectLocked(withLock(lockPath, { waitMs: 100, staleMs: 60_000 }, async () => "never"));
      expect(Date.now() - started).toBeLessThan(2000);
      expect(existsSync(lockPath)).toBe(true);
      expect(readFileSync(lockPath, "utf8")).toBe("");
    });
  });

  test("a displaced holder's release leaves the newer lock in place", async () => {
    await withTempDir(async (dir) => {
      const lockPath = join(dir, "state.json.lock");
      const newer = `${JSON.stringify({ pid: 2 ** 31 - 2, host: "example.com", startedAt: new Date().toISOString(), argv: ["maxims", "add"] })}\n`;
      await withLock(lockPath, {}, async () => {
        writeFileSync(lockPath, newer);
      });
      expect(readFileSync(lockPath, "utf8")).toBe(newer);
      await withLock(lockPath, { staleMs: 0 }, async () => {
        writeFileSync(lockPath, "");
      });
      expect(readFileSync(lockPath, "utf8")).toBe("");
    });
  });

  // On Windows a kill is TerminateProcess, with no signal for the exit hook to see; the analogue is
  // a console Ctrl-C event, which a test cannot aim at one child.
  const signalTest = test.skipIf(process.platform === "win32");

  signalTest(
    "a holder killed by SIGTERM removes its own lock before dying of the signal",
    async () => {
      await withTempDir(async (dir) => {
        const lockPath = join(dir, "state.json.lock");
        const child = await holdInChild(lockPath, {});
        expect(JSON.parse(readFileSync(lockPath, "utf8")).pid).toBe(child.pid);
        expect(await child.kill("SIGTERM")).toEqual({ exitCode: null, signalCode: "SIGTERM" });
        expect(readdirSync(dir)).toEqual([]);
      });
    },
  );

  signalTest("a displaced holder's exit on a signal leaves the newer lock in place", async () => {
    await withTempDir(async (dir) => {
      const lockPath = join(dir, "state.json.lock");
      const displaced = await holdInChild(lockPath, { staleMs: 60_000 });
      const then = new Date(Date.now() - 120_000);
      utimesSync(lockPath, then, then);
      const seen = await withLock(lockPath, { waitMs: 0, staleMs: 60_000 }, async (lock) => {
        await displaced.kill("SIGTERM");
        expect(JSON.parse(readFileSync(lockPath, "utf8")).pid).toBe(process.pid);
        return lock;
      });
      expect(seen.stolen?.holder?.pid).toBe(displaced.pid);
      expect(readdirSync(dir)).toEqual([]);
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
