// Fails if the iteration count stops reaching the suite's environment, if a failing suite stops
// failing the run, or if the report drops the tail of the output that names the failing test.
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
  expect(body).not.toContain("line 50\n");
});
