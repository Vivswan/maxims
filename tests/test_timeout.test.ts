// Fails if the launcher stops widening the per-test budget on Windows, where a git-heavy row spends
// bun's default five seconds on process start-up alone, or starts overriding a budget the caller
// asked for, or spells the flag in a way `bun test` no longer reads.
import { expect, test } from "bun:test";
import {
  bunTestArgs,
  DEFAULT_TEST_TIMEOUT_MS,
  WINDOWS_TEST_TIMEOUT_MS,
} from "../scripts/lib/test_timeout.ts";

const budgets: [NodeJS.Platform, number][] = [
  ["win32", WINDOWS_TEST_TIMEOUT_MS],
  ["linux", DEFAULT_TEST_TIMEOUT_MS],
  ["darwin", DEFAULT_TEST_TIMEOUT_MS],
];

test.each(budgets)(
  "%s tests get a %d ms budget ahead of the caller's arguments",
  (platform, ms) => {
    expect(bunTestArgs(platform, ["tests/smoke.test.ts"])).toEqual([
      `--timeout=${ms}`,
      "tests/smoke.test.ts",
    ]);
  },
);

const explicitBudgets: [string[]][] = [[["--timeout=1000"]], [["--timeout", "1000"]]];

test.each(explicitBudgets)("a caller's own %p wins and is not doubled", (explicit) => {
  expect(bunTestArgs("win32", [...explicit, "tests/smoke.test.ts"])).toEqual([
    ...explicit,
    "tests/smoke.test.ts",
  ]);
});

test("the flag the launcher passes is one `bun test` documents", async () => {
  const proc = Bun.spawn([process.execPath, "test", "--help"], { stdout: "pipe", stderr: "pipe" });
  const help = await new Response(proc.stdout).text();
  await proc.exited;
  expect(help).toContain("--timeout=");
});
