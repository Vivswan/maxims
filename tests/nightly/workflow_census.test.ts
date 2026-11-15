// Fails if the dispatcher's categories, the workflow's report legs, and the settings' labels stop
// naming the same set, if a tracked category runs twice a night or never (here and again inside
// the release gate), or if a report leg stops deciding on its own category's result.
import { expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { data, Evaluator, Lexer, Parser } from "@actions/expressions";
import type { FunctionDefinition } from "@actions/expressions/funcs/info";
import { truthy } from "@actions/expressions/result";
import {
  convertWorkflowTemplate,
  isBasicExpression,
  NoOperationTraceWriter,
  parseWorkflow,
} from "@actions/workflow-parser";
import {
  isActionStep,
  isJob,
  isReusableWorkflowJob,
  isRunStep,
} from "@actions/workflow-parser/model/type-guards";
import type { WorkflowJob } from "@actions/workflow-parser/model/workflow-template";
import type { TemplateToken } from "@actions/workflow-parser/templates/tokens/index";
import { parseFileReference } from "@actions/workflow-parser/workflows/file-reference";
import { parse } from "yaml";
import { CATEGORIES } from "../../scripts/nightly.ts";

const repoRoot = resolve(import.meta.dir, "..", "..");
const WORKFLOWS = ".github/workflows";
const GATE_PATH = `${WORKFLOWS}/release-gate.yml`;
const TRACKED = [...CATEGORIES, "container"].sort();

const DECISIONS: Record<Result, string[]> = {
  failure: ["download", "report"],
  cancelled: ["report"],
  success: ["resolve"],
};

const REPOSITORY = "Vivswan/maxims";

const SPELLINGS = `
on: push
jobs:
  a:
    runs-on: ubuntu-latest
    steps: [{ run: "true" }]
  b:
    needs: a
    if: \${{ needs.a.result == 'success' }}
    runs-on: ubuntu-latest
    outputs:
      two-lines: \${{ needs.a.result ==
        'success' }}
      braces: \${{ '}}' }}
    steps: [{ run: "true" }]
`;

type Result = "success" | "failure" | "cancelled";
type Context = Record<string, unknown>;
type Settings = { labels: { name: string; color: string; description: string }[] };
// `root` is the file as GitHub's parser read it, for the keys its typed jobs do not carry.
type Workflow = { root: TemplateToken; jobs: Record<string, WorkflowJob> };
type Step = { condition: string; run?: string; uses?: string; inputs?: TemplateToken };
type Ran = { uses?: string; with: Partial<Record<string, string>> };

// The conditions of the typed jobs and steps already carry GitHub's implicit `success()`.
async function load(name: string, content: string): Promise<Workflow> {
  const parsed = parseWorkflow({ name, content }, new NoOperationTraceWriter());
  const template = parsed.value && (await convertWorkflowTemplate(parsed.context, parsed.value));
  const errors = parsed.context.errors.getErrors().map((error) => error.message);

  if (parsed.value === undefined || template === undefined || errors.length > 0) {
    throw new Error(`${name} is not a workflow GitHub accepts:\n${errors.join("\n")}`);
  }

  return {
    root: parsed.value,
    jobs: Object.fromEntries(template.jobs.map((job) => [job.id.value, job])),
  };
}

const read = (file: string): Promise<Workflow> =>
  load(file, readFileSync(resolve(repoRoot, WORKFLOWS, file), "utf8"));

const at = (token: TemplateToken | undefined, ...keys: string[]): TemplateToken | undefined =>
  keys.reduce((node, key) => node?.assertMapping(`the parent of ${key}`).find(key), token);

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

const statusFunctions = (results: Result[]): FunctionDefinition[] =>
  Object.entries({
    always: true,
    success: results.every((result) => result === "success"),
    failure: results.includes("failure"),
    // Asks whether the workflow run was cancelled, which a timed-out category never is, so a simulated night keeps it false.
    cancelled: false,
  }).map(([name, value]) => ({
    name,
    minArgs: 0,
    maxArgs: 0,
    call: () => new data.BooleanData(value),
  }));

// The parser has already joined a value's expression parts into one expression; a value without any is its own text.
function text(token: TemplateToken | undefined, context: Context = {}): string {
  if (token === undefined) throw new Error("the workflow holds no value where one is read");
  if (isBasicExpression(token)) return evaluate(token.expression, context).coerceString();
  return token.assertScalar("a rendered value").toString();
}

const texts = (mapping: TemplateToken | undefined, context: Context = {}): Record<string, string> =>
  Object.fromEntries(
    [...(mapping?.assertMapping("a mapping of rendered values") ?? [])].map(({ key, value }) => [
      key.toString(),
      text(value, context),
    ]),
  );

const calls = (job: WorkflowJob | undefined): string | undefined =>
  job !== undefined && isReusableWorkflowJob(job) ? job.ref.value : undefined;

// A call names the gate by a local path, by the `$/` shorthand, or by this repository's coordinate with a ref.
function callsGate(job: WorkflowJob | undefined): boolean {
  const called = calls(job);
  if (called === undefined) return false;

  const file = parseFileReference(called);
  // GitHub reads an owner and a repository name without regard to case.
  const here =
    !("repository" in file) ||
    `${file.owner}/${file.repository}`.toLowerCase() === REPOSITORY.toLowerCase();
  return here && file.path === GATE_PATH;
}

// The typed step carries no `with`, so each step is paired with its own entry in the file.
function stepsOf({ root, jobs }: Workflow, id: string): Step[] {
  const job = jobs[id];
  if (job === undefined || !isJob(job)) return [];

  const entries = at(root, "jobs", id, "steps")?.assertSequence(`the steps of ${id}`);

  return job.steps.map((step, index) => ({
    condition: step.if?.expression ?? "success()",
    run: isRunStep(step) ? step.run.toString() : undefined,
    uses: isActionStep(step) ? step.uses.value : undefined,
    inputs: at(entries?.get(index), "with"),
  }));
}

const workflow = await read("nightly.yml");
const gate = await read("release-gate.yml");
const settings = parse(
  readFileSync(resolve(repoRoot, ".github/settings.local.yml"), "utf8"),
) as Settings;

const tiers = Object.keys(gate.jobs);
const include = at(workflow.jobs.report?.strategy, "matrix", "include");
const legs = [...(include?.assertSequence("the report legs") ?? [])].map((fields) => ({
  category: text(at(fields, "category")),
  fields,
}));

const tierSteps = (category: string): Step[] =>
  stepsOf(category in gate.jobs ? gate : workflow, category);

// One simulated night: `category` ends with `own`, every other tier and category with `siblings`.
// GitHub reports the gate call as one result for all its tiers, so a tier's own verdict reaches
// the report legs only through two declared mappings, rendered here as the runner would: the
// tier job's outputs from its final `job.status`, then the gate's outputs from those.
function night(category: string, own: Result, siblings: Result): Ran[] {
  const leg = legs.find((entry) => entry.category === category);
  const id = leg === undefined ? `report-${category}` : "report";
  const job = workflow.jobs[id];
  if (job === undefined) return [];

  const verdict = (name: string): Result => (name === category ? own : siblings);
  const gateJobs = Object.fromEntries(
    tiers.map((tier) => [
      tier,
      { outputs: texts(gate.jobs[tier]?.outputs, { job: { status: verdict(tier) } }) },
    ]),
  );
  const declared = at(gate.root, "on", "workflow_call", "outputs");
  const gateCall = {
    result: tiers.every((tier) => verdict(tier) === "success") ? "success" : "failure",
    outputs: Object.fromEntries(
      [...(declared?.assertMapping("the gate's outputs") ?? [])].map(({ key, value }) => [
        key.toString(),
        text(at(value, "value"), { jobs: gateJobs }),
      ]),
    ),
  };
  const needs = Object.fromEntries(
    (job.needs ?? []).map(({ value: name }) => [
      name,
      name === "release-gate" ? gateCall : { result: verdict(name) },
    ]),
  );
  // A leg's fields are rendered under `needs` before any step reads them, as the runner does.
  const matrix = leg === undefined ? {} : texts(leg.fields, { needs });
  const context: Context = { needs, matrix };
  const results = Object.values(needs).map((need) => need.result as Result);

  // A job-level `if` sees `needs` but not `matrix`; GitHub rejects the workflow otherwise.
  if (!truthy(evaluate(job.if.expression, { needs }, statusFunctions(results)))) return [];

  // Every earlier step of a simulated job passed, so a step's own status functions see no failure.
  return stepsOf(workflow, id)
    .filter((step) => truthy(evaluate(step.condition, context, statusFunctions([]))))
    .map((step) => ({ uses: step.uses, with: texts(step.inputs, context) }));
}

const kind = (step: Ran): string | undefined => {
  if (step.uses?.startsWith("actions/download-artifact@")) return "download";
  if (step.uses?.startsWith("Vivswan/repo-platform/actions/fuzz-issue@")) return step.with.mode;
  return undefined;
};

const nights = TRACKED.flatMap((category) =>
  (["failure", "cancelled", "success"] as const).flatMap((own) =>
    (["success", "failure"] as const).map((siblings) => [category, own, siblings] as const),
  ),
);

// The container tier runs through its own script rather than the dispatcher and writes no
// failure report, so it is the one tracked category with a report job of its own. A category
// declared in both files fails here rather than hiding behind the gate-first lookup of its steps.
test("every tracked category has one job a night, here or in the release gate, and nothing else has one", () => {
  const inline = Object.keys(workflow.jobs).filter((name) => TRACKED.includes(name));
  expect([...inline, ...tiers].sort()).toEqual(TRACKED);
  expect(calls(workflow.jobs["release-gate"])).toBe(`./${GATE_PATH}`);
  expect(Object.keys(workflow.jobs).sort()).toEqual(
    [...inline, "release-gate", "report", "report-container"].sort(),
  );
  expect(legs.map((leg) => leg.category).sort()).toEqual([...CATEGORIES].sort());
});

// GitHub's default job timeout is six hours and nothing reports its absence.
test("every release-gate job carries its own timeout", () => {
  const missing = tiers.filter(
    (tier) => at(gate.root, "jobs", tier, "timeout-minutes") === undefined,
  );
  expect(missing).toEqual([]);
});

// A second caller runs every tier twice per release with no error from GitHub. The managed
// ci.yml is the platform's caller and is left out: it changes by sync, never here.
test("nightly.yml is the one repository-owned caller of the release gate", async () => {
  const files = readdirSync(resolve(repoRoot, WORKFLOWS)).filter(
    (file) => /\.ya?ml$/.test(file) && file !== "ci.yml",
  );
  const owned = await Promise.all(files.map(async (file) => ({ file, ...(await read(file)) })));
  const callers = owned.flatMap(({ file, jobs }) =>
    Object.keys(jobs)
      .filter((name) => callsGate(jobs[name]))
      .map((name) => `${file}:${name}`),
  );

  expect(callers).toEqual(["nightly.yml:release-gate"]);
});

test.each([...CATEGORIES])("the %s job runs its category through the dispatcher", (category) => {
  const runs = tierSteps(category).flatMap((step) => step.run ?? []);
  expect(runs.some((line) => line.startsWith(`bun run nightly ${category} `))).toBe(true);
});

test.each(nights)(
  "a night where %s is %s and its siblings %s decides on its own result, under its own label and artifact",
  (category, own, siblings) => {
    const steps = night(category, own, siblings);
    const upload = tierSteps(category).find((step) =>
      step.uses?.startsWith("actions/upload-artifact@"),
    );
    const uploaded = upload && text(at(upload.inputs, "name"));
    // The container tier uploads no report, so its red night has nothing to download.
    const decided = DECISIONS[own].filter(
      (step) => step !== "download" || category !== "container",
    );
    if (category !== "container") expect(uploaded).toBeString();
    expect(steps.map(kind)).toEqual(decided);
    for (const step of steps) {
      if (kind(step) === "download") expect(step.with.name).toBe(uploaded);
      else expect(step.with.label).toBe(`nightly-${category}`);
      if (kind(step) === "report") expect(step.with["artifact-name"]).toBe(uploaded);
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

// The fixture holds a job condition wrapped in an expression marker, an expression broken over
// two lines, and a closing brace pair inside a string literal; the report jobs use none yet.
// Without this, an edit into one of them stops the census with a parse error, or leaves an
// unrendered expression that compares as plain text.
test("a condition and an output in the spellings GitHub also accepts read as GitHub reads them", async () => {
  const { jobs } = await load("spellings.yml", SPELLINGS);
  const ran = (result: Result): unknown => {
    const needs = { a: { result } };
    const condition = jobs.b?.if.expression ?? "";
    const runs = truthy(evaluate(condition, { needs }, statusFunctions([result])));
    return { runs, ...texts(jobs.b?.outputs, { needs }) };
  };

  expect(ran("success")).toEqual({ runs: true, "two-lines": "true", braces: "}}" });
  expect(ran("failure")).toEqual({ runs: false, "two-lines": "false", braces: "}}" });
});
