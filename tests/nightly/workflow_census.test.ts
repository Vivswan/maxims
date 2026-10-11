// Fails if the dispatcher's categories, the workflow's report legs, and the settings' labels stop
// naming the same set, if a tracked category runs twice a night or never (here and again inside
// the release gate), or if a report leg stops deciding on its own category's result.
import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { data, Evaluator, Lexer, Parser } from "@actions/expressions";
import type { FunctionDefinition } from "@actions/expressions/funcs/info";
import { TokenType } from "@actions/expressions/lexer";
import { truthy } from "@actions/expressions/result";
import { parse } from "yaml";
import { CATEGORIES } from "../../scripts/nightly.ts";

const repoRoot = resolve(import.meta.dir, "..", "..");
const read = (path: string): unknown => parse(readFileSync(resolve(repoRoot, path), "utf8"));

// YAML reads a bare `if: true` as a boolean; GitHub reads every condition as its text.
type Condition = string | boolean;
type Step = { if?: Condition; run?: string; uses?: string; with?: Record<string, string> };
type Leg = { category: string; description: string; result: string };
type Job = {
  needs?: string[];
  if?: Condition | null;
  uses?: string;
  outputs?: Record<string, string>;
  steps?: Step[];
  strategy?: { matrix: { include: Leg[] } };
};
type Workflow = { jobs: Record<string, Job> };
type Gate = Workflow & { on: { workflow_call: { outputs: Record<string, { value: string }> } } };
type Settings = { labels: { name: string; color: string; description: string }[] };

const GATE_PATH = ".github/workflows/release-gate.yml";
const workflow = read(".github/workflows/nightly.yml") as Workflow;
const gate = read(GATE_PATH) as Gate;
const settings = read(".github/settings.local.yml") as Settings;

// The container tier runs through its own script rather than the dispatcher and writes no
// failure report, so it is the one tracked category with a report job of its own.
const TRACKED = [...CATEGORIES, "container"].sort();
const report = workflow.jobs.report;
const legs = report?.strategy?.matrix.include ?? [];
const tiers = Object.keys(gate.jobs);

// The job that runs a tracked category: the gate's when the gate declares it, the nightly's own
// otherwise. A category declared in both is caught by the census below, not hidden here.
const tierJob = (category: string): Job | undefined =>
  gate.jobs[category] ?? workflow.jobs[category];

type Result = "success" | "failure" | "cancelled";
type Context = Record<string, unknown>;

function evaluate(
  expression: string,
  context: Context,
  functions: FunctionDefinition[] = [],
): data.ExpressionData {
  const tokens = new Lexer(expression).lex().tokens;
  const tree = new Parser(tokens, Object.keys(context), functions).parse();
  const dictionary = JSON.parse(JSON.stringify(context), data.reviver) as data.Dictionary;
  const table = new Map(functions.map((definition) => [definition.name, definition]));
  return new Evaluator(tree, dictionary, table).evaluate();
}

// The status functions a job-level `if` reads off its needed jobs' results. cancelled() asks
// whether the workflow run was cancelled, which a timed-out category never is, so a simulated
// night keeps it false.
const statusFunctions = (results: Result[]): FunctionDefinition[] =>
  Object.entries({
    always: true,
    success: results.every((result) => result === "success"),
    failure: results.includes("failure"),
    cancelled: false,
  }).map(([name, value]) => ({
    name,
    minArgs: 0,
    maxArgs: 0,
    call: () => new data.BooleanData(value),
  }));

// GitHub guards a job condition that names no status function with an implicit `success()`, so
// `if: true` skips the job on a red night as surely as an empty `if` or none at all.
function jobCondition(condition: Condition | null | undefined): string {
  const expression = String(condition ?? "").trim();
  if (expression === "") return "success()";
  const tokens = new Lexer(expression).lex().tokens;
  const named = tokens.some(
    (token, index) =>
      token.type === TokenType.IDENTIFIER &&
      ["always", "success", "failure", "cancelled"].includes(token.lexeme.toLowerCase()) &&
      tokens[index + 1]?.type === TokenType.LEFT_PAREN,
  );
  return named ? expression : `success() && (${expression})`;
}

const fill = (template: string, context: Context): string =>
  template.replace(/\$\{\{(.*?)\}\}/g, (_, expression: string) =>
    evaluate(expression, context).coerceString(),
  );

// One simulated night: `category` ends with `own`, every other tier and category with `siblings`.
// GitHub reports the gate call as one result for all its tiers, so a tier's own verdict reaches
// the report legs only through two declared mappings, rendered here as the runner would: the
// tier job's outputs from its final `job.status`, then the gate's outputs from those.
function night(category: string, own: Result, siblings: Result): Step[] {
  const leg = legs.find((entry) => entry.category === category);
  const job = leg === undefined ? workflow.jobs[`report-${category}`] : report;
  const verdict = (name: string): Result => (name === category ? own : siblings);
  const gateJobs = Object.fromEntries(
    tiers.map((tier) => [
      tier,
      {
        outputs: Object.fromEntries(
          Object.entries(gate.jobs[tier]?.outputs ?? {}).map(([name, value]) => [
            name,
            fill(value, { job: { status: verdict(tier) } }),
          ]),
        ),
      },
    ]),
  );
  const gateCall = {
    result: tiers.every((tier) => verdict(tier) === "success") ? "success" : "failure",
    outputs: Object.fromEntries(
      Object.entries(gate.on.workflow_call.outputs).map(([name, output]) => [
        name,
        fill(output.value, { jobs: gateJobs }),
      ]),
    ),
  };
  const needs = Object.fromEntries(
    (job?.needs ?? []).map((name) => [
      name,
      name === "release-gate" ? gateCall : { result: verdict(name) },
    ]),
  );
  // A leg's fields are rendered under `needs` before any step reads them, as the runner does.
  const matrix =
    leg === undefined
      ? {}
      : Object.fromEntries(
          Object.entries(leg).map(([key, value]) => [key, fill(value, { needs })]),
        );
  const context: Context = { needs, matrix };
  const results = Object.values(needs).map((need) => need.result as Result);
  // A job-level `if` sees `needs` but not `matrix`; GitHub rejects the workflow otherwise.
  if (!truthy(evaluate(jobCondition(job?.if), { needs }, statusFunctions(results)))) return [];
  return (job?.steps ?? [])
    .filter((step) => step.if === undefined || truthy(evaluate(String(step.if), context)))
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

test("every tracked category has one job a night, here or in the release gate, and nothing else has one", () => {
  const inline = Object.keys(workflow.jobs).filter((name) => TRACKED.includes(name));
  expect([...inline, ...tiers].sort()).toEqual(TRACKED);
  expect(workflow.jobs["release-gate"]?.uses).toBe(`./${GATE_PATH}`);
  expect(Object.keys(workflow.jobs).sort()).toEqual(
    [...inline, "release-gate", "report", "report-container"].sort(),
  );
  expect(legs.map((leg) => leg.category).sort()).toEqual([...CATEGORIES].sort());
});

test.each([...CATEGORIES])("the %s job runs its category through the dispatcher", (category) => {
  const runs = tierJob(category)?.steps?.flatMap((step) => step.run ?? []) ?? [];
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
    const uploaded = tierJob(category)?.steps?.find((step) =>
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
