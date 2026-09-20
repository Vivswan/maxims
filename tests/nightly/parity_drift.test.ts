// Fails if the parity report stops showing the lines that changed, since an issue saying only
// "drifted" sends the reader to re-run the capture; also if a missing fixture or a failed capture
// passes as parity, or if an identical capture is reported as drift.
import { expect, test } from "bun:test";
import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  FIXTURE_PATH,
  judgeParity,
  type ParityInputs,
  runParityDrift,
} from "../../scripts/nightly/parity_drift.ts";
import type { Outcome } from "../../scripts/nightly/report.ts";
import { withTempDir } from "../shared/temp_dir.ts";

const FIXTURE = [
  "Usage: skills <command> [options]",
  "",
  "Manage Skills:",
  "  add <package>        Add a skill package (alias: a)",
  "  remove <name>        Remove a skill (alias: rm)",
  "  list                 List installed skills (alias: ls)",
  "",
  "Options:",
  "  -g, --global         Install globally",
  "  -y, --yes            Skip prompts",
  "",
].join("\n");

const LATEST = FIXTURE.replace(
  "  list                 List installed skills (alias: ls)",
  "  list                 List installed skills (alias: ls)\n  update               Update installed skills (alias: up)",
).replace("  -y, --yes            Skip prompts", "  -y, --yes            Skip every prompt");

const TITLE = "npx skills --help drifted from the parity fixture";
const VERSION = "`npm view skills version`: 1.9.0";

const DRIFT_BODY = [
  VERSION,
  "",
  "```diff",
  "===================================================================",
  "--- tests/fixtures/golden/skills-help.txt",
  "+++ npx skills@latest --help",
  "@@ -5,6 +5,7 @@",
  "   remove <name>        Remove a skill (alias: rm)",
  "   list                 List installed skills (alias: ls)",
  "+  update               Update installed skills (alias: up)",
  " ",
  " Options:",
  "   -g, --global         Install globally",
  "-  -y, --yes            Skip prompts",
  "+  -y, --yes            Skip every prompt",
  "```",
  "",
  "Update the fixture and the flag parity table together when maxims mirrors the change.",
  "",
].join("\n");

const fail = (body: string): Outcome => ({
  status: "fail",
  summary: `## Parity drift\n\n${body}`,
  report: { title: TITLE, body },
});

const cases: [string, ParityInputs, Outcome][] = [
  [
    "an identical capture passes",
    { fixture: FIXTURE, latest: { kind: "help", text: FIXTURE }, publishedVersion: "1.9.0" },
    {
      status: "pass",
      summary: `## Parity drift\n\n${VERSION}\n\n\`npx skills@latest --help\` matches the fixture.\n`,
    },
  ],
  [
    "a changed page fails with the added and changed lines in the diff",
    { fixture: FIXTURE, latest: { kind: "help", text: LATEST }, publishedVersion: "1.9.0" },
    fail(DRIFT_BODY),
  ],
  [
    "a missing fixture fails and says so",
    { fixture: null, latest: { kind: "help", text: LATEST }, publishedVersion: "1.9.0" },
    fail(
      `${VERSION}\n\nThe fixture tests/fixtures/golden/skills-help.txt is missing, so there is nothing to diff against.\n`,
    ),
  ],
  [
    "a failed capture fails with the error",
    {
      fixture: FIXTURE,
      latest: { kind: "failed", message: "npx -y skills@latest --help exited with code 1" },
      publishedVersion: "exit 1: npm ERR! network",
    },
    fail(
      "`npm view skills version`: exit 1: npm ERR! network\n\nThe capture failed: npx -y skills@latest --help exited with code 1\n",
    ),
  ],
];

test.each(cases)("%s", (_name, inputs, expected) => {
  expect(judgeParity(inputs)).toEqual(expected);
});

test("the run reads the fixture from disk and reports its absence", async () => {
  expect(existsSync(FIXTURE_PATH)).toBe(true);
  await withTempDir(async (dir) => {
    const fixture = join(dir, "skills-help.txt");
    writeFileSync(fixture, FIXTURE);
    const capture = async () => ({ kind: "help", text: FIXTURE }) as const;
    const version = async () => "1.9.0";
    expect((await runParityDrift(fixture, capture, version)).status).toBe("pass");
    expect(await runParityDrift(join(dir, "absent.txt"), capture, version)).toEqual(
      fail(
        `${VERSION}\n\nThe fixture tests/fixtures/golden/skills-help.txt is missing, so there is nothing to diff against.\n`,
      ),
    );
  });
});
