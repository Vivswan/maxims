// Fails if the iteration count stops reaching the suite's environment, if a failing suite stops
// failing the run, or if the report drops the tail of the output or a failing row's own block.
import { expect, test } from "bun:test";
import {
  ITERATIONS_ENV,
  runPropertyDeep,
  type SuiteRunner,
} from "../../scripts/nightly/property_deep.ts";

test("the suite runs with the iteration count in its environment and passes on exit 0", () => {
  const seen: Record<string, string>[] = [];
  const run: SuiteRunner = (env) => {
    seen.push(env);
    return { exitCode: 0, output: "1790 pass\n0 fail\n" };
  };
  expect(runPropertyDeep(500, run)).toEqual({
    status: "pass",
    summary: "## Deep property run\n\n`MAXIMS_PROPERTY_ITERATIONS=500 bun run test` exited 0\n",
  });
  expect(seen.map((env) => env[ITERATIONS_ENV])).toEqual(["500"]);
  // Windows spells the variable Path; the copy keeps the spelling it found.
  const pathKey = Object.keys(process.env).find((key) => key.toUpperCase() === "PATH") ?? "PATH";
  expect(seen[0]?.[pathKey]).toBe(process.env[pathKey] ?? "");
});

// A hand-written capture in bun's shape: a file whose assertion and timeout failures sit past the
// tail, and the closing list that names them again without that output.

const failingBlock = [
  "16 |   expect(run.stderr).toContain(expected);",
  "                        ^",
  "error: expect(received).toContain(expected)",
  "",
  'Expected to contain: "git ls-remote: fatal: "',
  'Received: "RegExp.escape is not a function\\n"',
  "",
  "      at <anonymous> (/repo/tests/early.test.ts:16:26)",
  "(fail) early: a row that fails before the tail starts [12.34ms]",
];
const timedOutBlock = [
  "(fail) early: a row that times out [50.40ms]",
  "  ^ this test timed out after 50ms.",
];
const earlyFailure = [
  "::group::tests/early.test.ts:",
  "(pass) early: a row that passes [0.10ms]",
  ...failingBlock,
  ...timedOutBlock,
  "(pass) early: a row after the failures [0.05ms]",
  "::endgroup::",
  "",
  "::group::tests/late.test.ts:",
  ...Array.from({ length: 220 }, (_, i) => `(pass) late: row ${i + 1} [0.01ms]`),
  "::endgroup::",
  "",
  "2 tests failed:",
  "(fail) early: a row that fails before the tail starts [12.34ms]",
  "(fail) early: a row that times out [50.40ms]",
  "",
  " 221 pass",
  " 2 fail",
  "Ran 223 tests across 2 files. [1.00s]",
];

test("failing rows that scrolled past the tail are reported whole, once each, ahead of the tail", () => {
  const output = `${earlyFailure.join("\n")}\n`;
  const run: SuiteRunner = () => ({ exitCode: 1, output });
  const outcome = runPropertyDeep(200, run);
  const body = outcome.status === "fail" ? outcome.report.body : "";
  const tail = earlyFailure.slice(-200).join("\n");
  expect(tail).not.toContain("error: expect");
  expect(body).toBe(
    "`MAXIMS_PROPERTY_ITERATIONS=200 bun run test` exited 1. " +
      "Each failing row as bun printed it:\n\n" +
      `\`\`\`text\n${failingBlock.join("\n")}\n\n${timedOutBlock.join("\n")}\n\`\`\`\n\n` +
      `The last 200 lines of its output:\n\n\`\`\`text\n${tail}\n\`\`\`\n`,
  );
});

test("a failing suite fails with the last 200 lines of its output", () => {
  const lines = Array.from({ length: 250 }, (_, i) => `line ${i + 1}`);
  const output = `${lines.join("\n")}\n`;
  const run: SuiteRunner = () => ({ exitCode: 1, output });
  const outcome = runPropertyDeep(200, run);
  expect(outcome.status).toBe("fail");
  const body = outcome.status === "fail" ? outcome.report.body : "";
  expect(body).toBe(
    "`MAXIMS_PROPERTY_ITERATIONS=200 bun run test` exited 1. The last 200 lines of its output:\n\n" +
      `\`\`\`text\n${lines.slice(50).join("\n")}\n\`\`\`\n`,
  );
});
