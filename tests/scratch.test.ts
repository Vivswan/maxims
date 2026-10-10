// Fails if withScratchDir goes back to dropping a signal that arrives while its callback blocks the
// event loop. A bench or a nightly step is a chain of spawnSync calls followed by process.exit, so
// a SIGTERM during one of them must still end the process by that signal, with the scratch
// directory gone, before that exit runs.
import { expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { withScratchDir } from "../scripts/lib/scratch.ts";
import { CHMOD_DENIES, WINDOWS } from "./shared/platform.ts";
import { launcherHome, withTempDir } from "./shared/temp_dir.ts";

const SCRATCH = resolve(import.meta.dir, "..", "scripts", "lib", "scratch.ts");

async function waitForFile(path: string): Promise<void> {
  for (let waited = 0; !existsSync(path); waited += 20) {
    if (waited > 4000) throw new Error(`${path} never appeared`);
    await Bun.sleep(20);
  }
}

test.skipIf(WINDOWS)(
  "a SIGTERM during a synchronous scratch step ends the process by that signal and removes the dir",
  async () => {
    await withTempDir(async (scratch) => {
      const marker = join(scratch, "dir.txt");
      const returned = join(scratch, "returned");
      const script = join(scratch, "blocked.ts");
      writeFileSync(
        script,
        [
          `import { writeFileSync } from "node:fs";`,
          `import { withScratchDir } from ${JSON.stringify(SCRATCH)};`,
          `const code = await withScratchDir("maxims-scratch-probe-", (dir) => {`,
          `  writeFileSync(${JSON.stringify(marker)}, dir);`,
          `  Bun.spawnSync(["node", "-e", "setTimeout(() => {}, 3000)"], { stdin: "ignore", stdout: "ignore", stderr: "ignore" });`,
          `  return 0;`,
          `}, ${JSON.stringify(scratch)});`,
          `writeFileSync(${JSON.stringify(returned)}, "");`,
          `process.exit(code);`,
        ].join("\n"),
      );
      const proc = Bun.spawn([process.execPath, script], {
        stdin: "ignore",
        stdout: "ignore",
        stderr: "pipe",
      });
      await waitForFile(marker);
      proc.kill("SIGTERM");
      await proc.exited;
      const dir = await Bun.file(marker).text();
      expect(await new Response(proc.stderr).text()).toBe("");
      expect([proc.exitCode, proc.signalCode, existsSync(returned), existsSync(dir)]).toEqual([
        null,
        "SIGTERM",
        false,
        false,
      ]);
    });
  },
  15_000,
);

type ExitEmitter = { listeners: { exit: unknown[]; afterExit: unknown[] } };

function hookCounts(): number[] {
  const emitter = (globalThis as Record<symbol, unknown>)[
    Symbol.for("signal-exit emitter")
  ] as ExitEmitter;
  return [emitter.listeners.exit.length, emitter.listeners.afterExit.length];
}

// Fails if withScratchDir goes back to keeping its exit hook for the process lifetime: a looped
// bench then retains one closure per run, which the signal test above cannot see.
test("a loop of scratch steps leaves no exit hook behind", async () => {
  const step = (): Promise<void> =>
    withScratchDir("maxims-scratch-probe-", () => {}, launcherHome());
  await step();
  const before = hookCounts();
  for (let i = 0; i < 1000; i += 1) await step();
  expect(hookCounts()).toEqual(before);
});

// Fails if withScratchDir goes back to releasing its exit hook only after a removal that succeeded:
// a scratch dir the process cannot remove then keeps a hook that retries that removal at exit.
test.skipIf(!CHMOD_DENIES)(
  "a scratch dir that cannot be removed rejects and leaves no exit hook behind",
  async () => {
    await withTempDir(async (scratch) => {
      let locked = "";
      try {
        const before = hookCounts();
        const rejected = await withScratchDir(
          "maxims-scratch-probe-",
          (dir) => {
            locked = join(dir, "locked");
            mkdirSync(locked);
            writeFileSync(join(locked, "entry"), "");
            chmodSync(locked, 0o500);
          },
          scratch,
        ).then(
          () => false,
          () => true,
        );
        expect([rejected, hookCounts()]).toEqual([true, before]);
      } finally {
        if (locked !== "") chmodSync(locked, 0o700);
      }
    });
  },
);
