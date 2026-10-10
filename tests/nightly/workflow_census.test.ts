// Fails if the dispatcher's categories, the workflow's report legs, and the settings' labels stop
// naming the same set, or if a report leg stops deciding on its own category's result.
import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { data, Evaluator, Lexer, Parser } from "@actions/expressions";
import { truthy } from "@actions/expressions/result";
import { parse } from "yaml";
import { CATEGORIES } from "../../scripts/nightly.ts";

const repoRoot = resolve(import.meta.dir, "..", "..");
const read = (path: string): unknown => parse(readFileSync(resolve(repoRoot, path), "utf8"));

type Step = { if?: string; run?: string; uses?: string; with?: Record<string, string> };
type Leg = { category: string; description: string };
type Job = { needs?: string[]; steps: Step[]; strategy?: { matrix: { include: Leg[] } } };
type Workflow = { jobs: Record<string, Job> };
type Settings = { labels: { name: string; color: string; description: string }[] };

const workflow = read(".github/workflows/nightly.yml") as Workflow;
const settings = read(".github/settings.local.yml") as Settings;

// The container tier runs through its own script rather than the dispatcher and writes no
// failure report, so it is the one tracked category with a report job of its own.
const TRACKED = [...CATEGORIES, "container"].sort();
const report = workflow.jobs.report;
const legs = report?.strategy?.matrix.include ?? [];

type Result = "success" | "failure" | "cancelled";
type Context = Record<string, unknown>;

function evaluate(expression: string, context: Context): data.ExpressionData {
  const tokens = new Lexer(expression).lex().tokens;
  const tree = new Parser(tokens, Object.keys(context), []).parse();
  const dictionary = JSON.parse(JSON.stringify(context), data.reviver) as data.Dictionary;
  return new Evaluator(tree, dictionary).evaluate();
}

const fill = (template: string, context: Context): string =>
  template.replace(/\$\{\{(.*?)\}\}/g, (_, expression: string) =>
    evaluate(expression, context).coerceString(),
  );

function night(category: string, own: Result, siblings: Result): Step[] {
  const leg = legs.find((entry) => entry.category === category);
  const job = leg === undefined ? workflow.jobs[`report-${category}`] : report;
  const needs = Object.fromEntries(
    (job?.needs ?? []).map((name) => [name, { result: name === category ? own : siblings }]),
  );
  const context: Context = { needs, matrix: leg ?? {} };
  return (job?.steps ?? [])
    .filter((step) => step.if === undefined || truthy(evaluate(step.if, context)))
    .map((step) => ({
      ...step,
      with:
        step.with &&
        Object.fromEntries(
          Object.entries(step.with).map(([key, value]) => [key, fill(value, context)]),
        ),
    }));
}

const kind = (step: Step): string | undefined => {
  if (step.uses?.startsWith("actions/download-artifact@")) return "download";
  if (step.uses?.startsWith("Vivswan/repo-platform/actions/fuzz-issue@")) return step.with?.mode;
  return undefined;
};

const DECISIONS: Record<Result, string[]> = {
  failure: ["download", "report"],
  cancelled: ["report"],
  success: ["resolve"],
};

test("the report legs are the dispatcher's categories, and nothing else has a job", () => {
  expect(legs.map((leg) => leg.category).sort()).toEqual([...CATEGORIES].sort());
  expect(Object.keys(workflow.jobs).sort()).toEqual(
    [...TRACKED, "report", "report-container"].sort(),
  );
});

test.each([...CATEGORIES])("the %s job runs its category through the dispatcher", (category) => {
  const runs = workflow.jobs[category]?.steps.flatMap((step) => step.run ?? []) ?? [];
  expect(runs.some((line) => line.startsWith(`bun run nightly ${category} `))).toBe(true);
});

const nights = TRACKED.flatMap((category) =>
  (["failure", "cancelled", "success"] as const).flatMap((own) =>
    (["success", "failure"] as const).map((siblings) => [category, own, siblings] as const),
  ),
);

test.each(nights)(
  "a night where %s is %s and its siblings %s decides on its own result, under its own label and artifact",
  (category, own, siblings) => {
    const steps = night(category, own, siblings);
    const uploaded = workflow.jobs[category]?.steps.find((step) =>
      step.uses?.startsWith("actions/upload-artifact@"),
    )?.with?.name;
    // The container tier uploads no report, so its red night has nothing to download.
    const decided = DECISIONS[own].filter(
      (step) => step !== "download" || category !== "container",
    );
    if (category !== "container") expect(uploaded).toBeString();
    expect(steps.map(kind)).toEqual(decided);
    for (const step of steps) {
      if (kind(step) === "download") expect(step.with?.name).toBe(uploaded);
      else expect(step.with?.label).toBe(`nightly-${category}`);
      if (kind(step) === "report") expect(step.with?.["artifact-name"]).toBe(uploaded);
    }
  },
);

test("the settings create exactly one nightly label per tracked category, worded as the report words it", () => {
  const labels = settings.labels.filter((label) => label.name.startsWith("nightly-"));
  expect(labels.map((label) => label.name).sort()).toEqual(
    TRACKED.map((category) => `nightly-${category}`),
  );
  for (const label of labels) {
    const category = label.name.slice("nightly-".length);
    const filing = night(category, "failure", "success").find((step) => kind(step) === "report");
    expect(filing?.with).toMatchObject({
      title: label.description,
      "label-description": label.description,
      "label-color": label.color,
    });
  }
});
