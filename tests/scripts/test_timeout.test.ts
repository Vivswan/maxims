// Fails if the launcher stops widening the per-test budget on Windows, where a git-heavy row spends
// bun's default five seconds on process start-up alone, or starts overriding a budget the caller
// asked for, or spells the flag in a way `bun test` no longer reads.
import { expect, test } from "bun:test";
import {
  bunTestArgs,
  DEFAULT_TEST_TIMEOUT_MS,
  WINDOWS_TEST_TIMEOUT_MS,
} from "../../scripts/lib/test_timeout.ts";

const budgets: [platform: NodeJS.Platform, argv: string[], expected: string[]][] = [
  [
    "win32",
    ["tests/smoke.test.ts"],
    [`--timeout=${WINDOWS_TEST_TIMEOUT_MS}`, "tests/smoke.test.ts"],
  ],
  [
    "linux",
    ["tests/smoke.test.ts"],
    [`--timeout=${DEFAULT_TEST_TIMEOUT_MS}`, "tests/smoke.test.ts"],
  ],
  [
    "darwin",
    ["tests/smoke.test.ts"],
    [`--timeout=${DEFAULT_TEST_TIMEOUT_MS}`, "tests/smoke.test.ts"],
  ],
  ["win32", ["--timeout=1000", "tests/smoke.test.ts"], ["--timeout=1000", "tests/smoke.test.ts"]],
  [
    "win32",
    ["--timeout", "1000", "tests/smoke.test.ts"],
    ["--timeout", "1000", "tests/smoke.test.ts"],
  ],
];

test.each(budgets)(
  "bunTestArgs(%p, %p) is %p: the platform budget leads unless the caller carries one",
  (platform, argv, expected) => {
    expect(bunTestArgs(platform, argv)).toEqual(expected);
  },
);

test("the flag the launcher passes is one `bun test` documents", async () => {
  const proc = Bun.spawn([process.execPath, "test", "--help"], { stdout: "pipe", stderr: "pipe" });
  const help = await new Response(proc.stdout).text();
  await proc.exited;
  expect(help).toContain("--timeout=");
});
