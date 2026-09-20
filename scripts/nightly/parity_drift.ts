// Re-captures `npx skills@latest --help` and diffs it against the committed fixture the per-PR
// parity test compares maxims against; upstream moving is invisible to that test by construction.
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { createTwoFilesPatch } from "diff";
import { captureSkillsHelp, SKILLS_HELP_ENV } from "../lib/skills_help.ts";
import type { Outcome } from "./report.ts";
import { withScratchDir } from "./scratch.ts";

const repoRoot = resolve(import.meta.dir, "..", "..");
export const FIXTURE_PATH = join(repoRoot, "tests", "fixtures", "golden", "skills-help.txt");
const FIXTURE_LABEL = "tests/fixtures/golden/skills-help.txt";
const LATEST_LABEL = "npx skills@latest --help";

export type Capture = { kind: "help"; text: string } | { kind: "failed"; message: string };

export type ParityInputs = {
  fixture: string | null;
  latest: Capture;
  publishedVersion: string;
};

const TITLE = "npx skills --help drifted from the parity fixture";

export function renderDiff(fixture: string, latest: string): string {
  return createTwoFilesPatch(FIXTURE_LABEL, LATEST_LABEL, fixture, latest, undefined, undefined, {
    context: 2,
  });
}

// The fixture is the contract the per-PR test enforces; with it gone that test compares against
// nothing, so the run says so rather than passing empty.
export function judgeParity(inputs: ParityInputs): Outcome {
  const version = `\`npm view skills version\`: ${inputs.publishedVersion}`;
  if (inputs.fixture === null) {
    const body = `${version}\n\nThe fixture ${FIXTURE_LABEL} is missing, so there is nothing to diff against.\n`;
    return {
      status: "fail",
      summary: `## Parity drift\n\n${body}`,
      report: { title: TITLE, body },
    };
  }
  if (inputs.latest.kind === "failed") {
    const body = `${version}\n\nThe capture failed: ${inputs.latest.message}\n`;
    return {
      status: "fail",
      summary: `## Parity drift\n\n${body}`,
      report: { title: TITLE, body },
    };
  }
  if (inputs.latest.text === inputs.fixture) {
    return {
      status: "pass",
      summary: `## Parity drift\n\n${version}\n\n\`${LATEST_LABEL}\` matches the fixture.\n`,
    };
  }
  const body = [
    version,
    "",
    "```diff",
    // Only the final newline goes: a trailing context line for a blank line is one space.
    renderDiff(inputs.fixture, inputs.latest.text).replace(/\n$/, ""),
    "```",
    "",
    "Update the fixture and the flag parity table together when maxims mirrors the change.",
    "",
  ].join("\n");
  return { status: "fail", summary: `## Parity drift\n\n${body}`, report: { title: TITLE, body } };
}

// The same registry pin and a throwaway npm cache as the help capture, so the version named in
// the report is the one the capture saw and nothing lands in the developer's ~/.npm.
async function publishedVersion(): Promise<string> {
  return withScratchDir("maxims-npm-view-", async (scratch) => {
    const env: Record<string, string> = { npm_config_cache: join(scratch, "npm-cache") };
    for (const key of ["PATH", "HOME", "TMPDIR", "LANG"]) {
      const value = process.env[key];
      if (value !== undefined) env[key] = value;
    }
    const proc = Bun.spawn(["npm", "view", "skills", "version"], {
      cwd: scratch,
      env: { ...env, ...SKILLS_HELP_ENV },
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
    });
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    return exitCode === 0 ? stdout.trim() : `exit ${exitCode}: ${stderr.trim()}`;
  });
}

async function captureLatest(): Promise<Capture> {
  try {
    return { kind: "help", text: await captureSkillsHelp("latest") };
  } catch (error) {
    return { kind: "failed", message: error instanceof Error ? error.message : String(error) };
  }
}

export async function runParityDrift(
  fixturePath: string = FIXTURE_PATH,
  capture: () => Promise<Capture> = captureLatest,
  version: () => Promise<string> = publishedVersion,
): Promise<Outcome> {
  const fixture = existsSync(fixturePath) ? readFileSync(fixturePath, "utf8") : null;
  const [latest, published] = await Promise.all([capture(), version()]);
  return judgeParity({ fixture, latest, publishedVersion: published });
}
