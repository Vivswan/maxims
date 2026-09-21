// Fails if the dispatcher's categories, the workflow's jobs, and the settings' labels stop naming
// the same set, or if a report job files its issue under a label worded unlike the one created.
import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { parse } from "yaml";
import { CATEGORIES } from "../../scripts/nightly.ts";

const repoRoot = resolve(import.meta.dir, "..", "..");
const read = (path: string): unknown => parse(readFileSync(resolve(repoRoot, path), "utf8"));

type Step = { if?: string; run?: string; uses?: string; with?: Record<string, string> };
type Job = { steps: Step[] };
type Workflow = { jobs: Record<string, Job> };
type Settings = { labels: { name: string; color: string; description: string }[] };

const workflow = read(".github/workflows/nightly.yml") as Workflow;
const settings = read(".github/settings.local.yml") as Settings;

// The container tier runs through its own script rather than the dispatcher, so it is the one
// tracked category the dispatcher does not list.
const TRACKED = [...CATEGORIES, "container"].sort();

const reportJobs = Object.keys(workflow.jobs)
  .filter((name) => name.startsWith("report-"))
  .map((name) => name.slice("report-".length))
  .sort();

test("every tracked category has one job and one report job, and nothing else does", () => {
  expect(reportJobs).toEqual(TRACKED);
  expect(Object.keys(workflow.jobs).sort()).toEqual(
    [...TRACKED, ...TRACKED.map((category) => `report-${category}`)].sort(),
  );
});

test.each([...CATEGORIES])("the %s job runs its category through the dispatcher", (category) => {
  const runs = workflow.jobs[category]?.steps.flatMap((step) => step.run ?? []) ?? [];
  expect(runs.some((line) => line.startsWith(`bun run nightly ${category} `))).toBe(true);
});

test.each(TRACKED)("the report-%s job files and resolves under its own label", (category) => {
  const issueSteps = (workflow.jobs[`report-${category}`]?.steps ?? []).filter((step) =>
    step.uses?.startsWith("Vivswan/repo-platform/actions/fuzz-issue@"),
  );
  expect(issueSteps.map((step) => step.with?.mode).sort()).toEqual(["report", "resolve"]);
  for (const step of issueSteps) expect(step.with?.label).toBe(`nightly-${category}`);
});

test("the settings create exactly one nightly label per tracked category, worded as the report job words it", () => {
  const labels = settings.labels.filter((label) => label.name.startsWith("nightly-"));
  expect(labels.map((label) => label.name).sort()).toEqual(
    TRACKED.map((category) => `nightly-${category}`),
  );
  for (const label of labels) {
    const category = label.name.slice("nightly-".length);
    const report = workflow.jobs[`report-${category}`]?.steps.find(
      (step) => step.with?.mode === "report",
    );
    expect(report?.with).toMatchObject({
      title: label.description,
      "label-description": label.description,
      "label-color": label.color,
    });
  }
});
