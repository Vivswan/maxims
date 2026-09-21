// Fails if the nightly container log stops carrying the evidence a reader needs to tell what ran
// inside the container: the whole captured suite output through bun's own summary line (a queued
// pipe write is cut at the first buffer when the tier exits right after it), one verdict line per
// real-CLI smoke row with the tier failing unless every row passed, and the suite's test count.
import { expect, test } from "bun:test";
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { REPO_ROOT } from "../container/runner.ts";
import {
  HARNESS_SMOKE_CLIS,
  HARNESS_SMOKE_FILE,
  HARNESS_SMOKE_SUITE,
  type HarnessSmokeCli,
} from "../container/tier.ts";
import { withTempDir } from "../shared/temp_dir.ts";

// The suite run is the only `run` whose command ends in `bun run test`; the fake answers it with
// the captured file on stderr, where bun prints its results, and the probe runs with the probe's
// expected lines.
const FAKE_DOCKER = [
  "#!/bin/sh",
  'case "$1" in',
  "  info) exit 0 ;;",
  "  build) exit 0 ;;",
  "  image) echo 812345 ;;",
  "  run)",
  '    case "$*" in',
  '      *"bun run test") cat "$MAXIMS_FAKE_SUITE_STDERR" >&2 ;;',
  "      *) printf 'home-is-expected\\nhome-empty\\nwork-copied\\nhome-writable\\nnetwork-none\\n' ;;",
  "    esac ;;",
  '  *) echo "unexpected: $*" >&2; exit 9 ;;',
  "esac",
  "",
].join("\n");

const PROBE_OUTPUT = "home-is-expected\nhome-empty\nwork-copied\nhome-writable\nnetwork-none\n";

// The job log is read by a process slower than the tier's writes. A reader that starts only
// after the tier has exited is the same condition at its limit: everything the tier queued
// instead of writing is gone. Both streams go to the one log, so both are read as one here.
const SLOW_READER = '{ "$@" 2>&1; echo "$?" > "$MAXIMS_TIER_EXIT_FILE"; } | { sleep 2; cat; }';

type TierRun = { exitCode: number; log: string };

function runTier(dir: string, suiteStderr: string): TierRun {
  const bin = join(dir, "bin");
  mkdirSync(bin);
  writeFileSync(join(bin, "docker"), FAKE_DOCKER);
  chmodSync(join(bin, "docker"), 0o755);
  const captured = join(dir, "suite-stderr.txt");
  writeFileSync(captured, suiteStderr);
  const exitFile = join(dir, "tier-exit");
  const proc = Bun.spawnSync(
    ["sh", "-c", SLOW_READER, "sh", process.execPath, "scripts/container_tests.ts"],
    {
      cwd: REPO_ROOT,
      env: {
        ...process.env,
        PATH: `${bin}:${process.env.PATH}`,
        MAXIMS_FAKE_SUITE_STDERR: captured,
        MAXIMS_TIER_EXIT_FILE: exitFile,
        GITHUB_STEP_SUMMARY: "",
      },
      stdout: "pipe",
      stderr: "pipe",
    },
  );
  return {
    exitCode: Number(readFileSync(exitFile, "utf8").trim()),
    log: `${proc.stdout.toString()}${proc.stderr.toString()}`,
  };
}

// The step timings are the one thing that differs between runs; the row timings come from the
// captured output and are pinned.
function withoutSeconds(log: string): string {
  return log.replaceAll(/ exit (\d+) in \d+\.\ds\n/g, " exit $1 in <s>s\n");
}

function expectedLog(suiteStderr: string, afterSuite: readonly string[], tail: string): string {
  return [
    "container tier: image build (maxims-container-tier:local) exit 0 in <s>s\n",
    "container tier: image size 793 KiB (812345 bytes)\n",
    suiteStderr,
    "container tier: suite inside the container exit 0 in <s>s\n",
    ...afterSuite.map((line) => `${line}\n`),
    PROBE_OUTPUT,
    "container tier: hermetic probe run 1 exit 0 in <s>s\n",
    PROBE_OUTPUT,
    "container tier: hermetic probe run 2 exit 0 in <s>s\n",
    tail,
  ].join("");
}

type RowStatus = "pass" | "skip" | "fail";

// Hand-picked timings whose rounding to a tenth of a second is not the identity.
const ROW_MS: Record<HarnessSmokeCli, string> = {
  claude: "12345.67",
  codex: "8000.00",
  gemini: "15250.50",
  copilot: "9999.99",
  opencode: "30000.01",
};
const ROW_SECONDS: Record<HarnessSmokeCli, string> = {
  claude: "12.3",
  codex: "8.0",
  gemini: "15.3",
  copilot: "10.0",
  opencode: "30.0",
};

function statuses<S extends RowStatus | "absent">(status: S): Record<HarnessSmokeCli, S> {
  return { claude: status, codex: status, gemini: status, copilot: status, opencode: status };
}

// The smoke file's section as bun prints it: the stub rows first, then the real rows.
function smokeSection(rows: Record<HarnessSmokeCli, RowStatus>): string {
  const lines = [
    `${HARNESS_SMOKE_FILE}:`,
    "(pass) the smoke's own logic on a stub CLI > a stub that runs the hook and loads the rules passes [390.33ms]",
  ];
  for (const cli of HARNESS_SMOKE_CLIS) {
    const title = `${HARNESS_SMOKE_SUITE} > ${cli}`;
    lines.push(
      rows[cli] === "skip" ? `(skip) ${title}` : `(${rows[cli]}) ${title} [${ROW_MS[cli]}ms]`,
    );
  }
  return `\n${lines.join("\n")}\n`;
}

const SUMMARY =
  "\n 2770 pass\n 5 skip\n 0 fail\n 5012 expect() calls\nRan 2775 tests across 98 files. [66.22s]\n";
const SUMMARY_LINE = "container tier: suite ran 2775 tests across 98 files";

function suiteOutput(sections: readonly string[], summary: string): string {
  return `\ntests/first.test.ts:\n(pass) first > runs [0.10ms]\n${sections.join("")}${summary}`;
}

function rowLines(rows: Record<HarnessSmokeCli, RowStatus | "absent">): string[] {
  return HARNESS_SMOKE_CLIS.map((cli) => {
    const time = rows[cli] === "pass" || rows[cli] === "fail" ? ` in ${ROW_SECONDS[cli]}s` : "";
    return `container tier: harness smoke ${cli} ${rows[cli]}${time}`;
  });
}

const NOT_PASSING = "container tier: harness smoke rows not passing: ";
const SKIP_MEANS = "skip means the tier marker did not reach the suite";
const ABSENT_MEANS = "absent means bun did not collect the smoke file";
const FAIL_MEANS = "fail means the row ran and failed";
const NO_SUMMARY =
  "container tier: the suite printed no summary line, so it did not run to the end\n";

type Case = {
  name: string;
  suite: string;
  exitCode: number;
  afterSuite: string[];
  tail: string;
};

const cases: Case[] = [
  {
    name: "every row passes",
    suite: suiteOutput([smokeSection(statuses("pass"))], SUMMARY),
    exitCode: 0,
    afterSuite: [...rowLines(statuses("pass")), SUMMARY_LINE],
    tail: "",
  },
  {
    name: "every row is skipped because the tier marker did not reach the suite",
    suite: suiteOutput([smokeSection(statuses("skip"))], SUMMARY),
    exitCode: 1,
    afterSuite: [...rowLines(statuses("skip")), SUMMARY_LINE],
    tail: `${NOT_PASSING}claude skip, codex skip, gemini skip, copilot skip, opencode skip (${SKIP_MEANS})\n`,
  },
  {
    name: "one row fails",
    suite: suiteOutput([smokeSection({ ...statuses("pass"), gemini: "fail" })], SUMMARY),
    exitCode: 1,
    afterSuite: [...rowLines({ ...statuses("pass"), gemini: "fail" }), SUMMARY_LINE],
    tail: `${NOT_PASSING}gemini fail (${FAIL_MEANS})\n`,
  },
  {
    name: "the smoke file was not collected",
    suite: suiteOutput([], SUMMARY),
    exitCode: 1,
    afterSuite: [...rowLines(statuses("absent")), SUMMARY_LINE],
    tail: `${NOT_PASSING}claude absent, codex absent, gemini absent, copilot absent, opencode absent (${ABSENT_MEANS})\n`,
  },
  {
    name: "the suite stopped before its summary line",
    suite: suiteOutput([smokeSection(statuses("pass"))], ""),
    exitCode: 1,
    afterSuite: rowLines(statuses("pass")),
    tail: NO_SUMMARY,
  },
];

test.each(cases)(
  "the tier's verdict on the smoke rows: $name",
  async ({ suite, exitCode, afterSuite, tail }) => {
    await withTempDir((dir) => {
      const run = runTier(dir, suite);
      expect({ exitCode: run.exitCode, log: withoutSeconds(run.log) }).toEqual({
        exitCode,
        log: expectedLog(suite, afterSuite, tail),
      });
    });
  },
);

// Well past one pipe buffer (64 KiB), so a write that stops at the first buffer loses the tail.
const FILLER_LINES = 4000;

function filler(): string {
  const lines = ["\ntests/filler.test.ts:"];
  for (let index = 0; index < FILLER_LINES; index += 1) {
    lines.push(`(pass) filler cases > case ${index}: ${"x".repeat(48)} [0.01ms]`);
  }
  return `${lines.join("\n")}\n`;
}

test("the whole captured suite output, through bun's summary line, reaches the tier's log", async () => {
  await withTempDir((dir) => {
    const suite = suiteOutput([filler(), smokeSection(statuses("pass"))], SUMMARY);
    expect(suite.length).toBeGreaterThan(200_000);
    const run = runTier(dir, suite);
    expect({ exitCode: run.exitCode, log: withoutSeconds(run.log) }).toEqual({
      exitCode: 0,
      log: expectedLog(suite, [...rowLines(statuses("pass")), SUMMARY_LINE], ""),
    });
  });
});
