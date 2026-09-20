// The two places a nightly category's result leaves the process: the job's step summary and the
// failure report the tracking-issue action reads (repo-platform's docs/fuzzer.md, contract v1).
import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export type FailureReport = { title: string; body: string };

// A failed category always carries the evidence that tripped it, so the issue body can show the
// diff, the table, or the exit codes instead of pointing at a run log.
export type Outcome =
  | { status: "pass"; summary: string }
  | { status: "fail"; summary: string; report: FailureReport };

export function writeStepSummary(markdown: string, env: NodeJS.ProcessEnv): void {
  const path = env.GITHUB_STEP_SUMMARY;
  if (path === undefined || path === "") process.stdout.write(markdown);
  else appendFileSync(path, markdown);
}

// The replay block sits right under the heading because the action keeps only a report's head
// in the issue body when the whole report rides in the artifact.
export function renderFailureReport(replay: string, report: FailureReport): string {
  return [`# ${report.title}`, "", "```sh", replay, "```", "", report.body.trimEnd(), ""].join(
    "\n",
  );
}

export function writeFailureReport(
  dir: string,
  category: string,
  replay: string,
  report: FailureReport,
): void {
  const failureDir = join(dir, category);
  mkdirSync(failureDir, { recursive: true });
  writeFileSync(join(failureDir, "report.md"), renderFailureReport(replay, report));
}

export function markdownTable(
  header: readonly string[],
  rows: readonly (readonly string[])[],
): string {
  const line = (cells: readonly string[]): string =>
    `| ${cells.map((cell) => cell.replaceAll("|", "\\|")).join(" | ")} |`;
  return [line(header), `|${header.map(() => "---").join("|")}|`, ...rows.map(line)].join("\n");
}
