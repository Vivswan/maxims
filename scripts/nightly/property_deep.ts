// Runs the ordinary suite with a larger property-test iteration count than a pull request pays
// for. The count reaches the property suites through MAXIMS_PROPERTY_ITERATIONS.
import { resolve } from "node:path";
import type { Outcome } from "./report.ts";

const repoRoot = resolve(import.meta.dir, "..", "..");
export const DEFAULT_ITERATIONS = 200;
export const ITERATIONS_ENV = "MAXIMS_PROPERTY_ITERATIONS";
const TAIL_LINES = 200;

export type SuiteResult = { exitCode: number; output: string };
export type SuiteRunner = (env: Record<string, string>) => SuiteResult;

function spawnSuite(env: Record<string, string>): SuiteResult {
  const proc = Bun.spawnSync(["bun", "run", "test"], {
    cwd: repoRoot,
    env,
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  return {
    exitCode: proc.exitCode ?? 1,
    output: `${proc.stdout.toString()}${proc.stderr.toString()}`,
  };
}

export function tail(output: string, lines: number): string {
  const all = output.trimEnd().split("\n");
  return all.slice(Math.max(0, all.length - lines)).join("\n");
}

function suiteEnv(iterations: number): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined) env[key] = value;
  }
  env[ITERATIONS_ENV] = String(iterations);
  return env;
}

export function runPropertyDeep(iterations: number, run: SuiteRunner = spawnSuite): Outcome {
  const result = run(suiteEnv(iterations));
  const headline = `\`${ITERATIONS_ENV}=${iterations} bun run test\` exited ${result.exitCode}`;
  const summary = `## Deep property run\n\n${headline}\n`;
  if (result.exitCode === 0) return { status: "pass", summary };
  return {
    status: "fail",
    summary,
    report: {
      title: "Deep property run failed",
      body: `${headline}. The last ${TAIL_LINES} lines of its output:\n\n\`\`\`text\n${tail(result.output, TAIL_LINES)}\n\`\`\`\n`,
    },
  };
}
