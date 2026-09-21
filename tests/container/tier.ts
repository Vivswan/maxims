// The container image declares this variable (tests/container/Dockerfile), so every process in
// a container run sees it and nothing outside one does: the tests that drive the image's
// installed harness CLIs run when it is set and skip by name otherwise.
export const CONTAINER_TIER_ENV = "MAXIMS_CONTAINER_TIER";

export function inContainerTier(env: Record<string, string | undefined>): boolean {
  return env[CONTAINER_TIER_ENV] === "1";
}

// The rows the tier reads back out of the suite's output. The smoke test builds its rows from
// this list and titles them with these names under this describe, so the tier and the test
// cannot name different rows.
export const HARNESS_SMOKE_FILE = "tests/e2e/harness-smoke.test.ts";
export const HARNESS_SMOKE_SUITE = "installed harness CLIs against the fake endpoint";
export const HARNESS_SMOKE_CLIS = ["claude", "codex", "gemini", "copilot", "opencode"] as const;
export type HarnessSmokeCli = (typeof HARNESS_SMOKE_CLIS)[number];

// bun omits the timing of a test that took no measurable time, so a pass or fail can carry none.
export type SmokeRowResult =
  | { status: "pass" | "fail"; ms: number | null }
  | { status: "skip" | "absent" };

export type SuiteEvidence = {
  rows: Record<HarnessSmokeCli, SmokeRowResult>;
  // bun's closing `Ran N tests across M files.` line; null when the suite never got there.
  summary: { tests: number; files: number } | null;
};

const RESULT_LINE = /^\((pass|fail|skip)\) (.+?)(?: \[(\d+(?:\.\d+)?)ms\])?$/;
const SUMMARY_LINE = /^Ran (\d+) tests? across (\d+) files?\./;
const ABSENT: SmokeRowResult = { status: "absent" };

// Reads bun's console reporter as it prints without color: one `(status) <describe> > <title>
// [<ms>]` line per test, and the summary line last. A row with no line is absent, which is what
// a file bun never collected looks like.
export function readSuiteEvidence(output: string): SuiteEvidence {
  const rows: Record<HarnessSmokeCli, SmokeRowResult> = {
    claude: ABSENT,
    codex: ABSENT,
    gemini: ABSENT,
    copilot: ABSENT,
    opencode: ABSENT,
  };
  const titles = new Map(HARNESS_SMOKE_CLIS.map((cli) => [`${HARNESS_SMOKE_SUITE} > ${cli}`, cli]));
  let summary: SuiteEvidence["summary"] = null;
  for (const line of output.split(/\r?\n/)) {
    const result = RESULT_LINE.exec(line);
    if (result !== null) {
      const cli = titles.get(result[2] ?? "");
      if (cli === undefined) continue;
      const ms = result[3] === undefined ? null : Number(result[3]);
      rows[cli] =
        result[1] === "skip"
          ? { status: "skip" }
          : { status: result[1] === "pass" ? "pass" : "fail", ms };
      continue;
    }
    const ran = SUMMARY_LINE.exec(line);
    if (ran?.[1] !== undefined && ran[2] !== undefined) {
      summary = { tests: Number(ran[1]), files: Number(ran[2]) };
    }
  }
  return { rows, summary };
}
