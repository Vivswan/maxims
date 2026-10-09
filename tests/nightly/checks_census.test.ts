// Fails if the scripts `bun run check` chains and the scripts checks.yml runs as steps stop naming
// the same set: a gate added to one side alone passes locally and never runs in CI, or the reverse.
import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { parse } from "yaml";

const repoRoot = resolve(import.meta.dir, "..", "..");
const read = (path: string): string => readFileSync(resolve(repoRoot, path), "utf8");

type Workflow = { jobs: Record<string, { steps: { run?: string }[] }> };

const scripts = (JSON.parse(read("package.json")) as { scripts: Record<string, string> }).scripts;
const workflow = parse(read(".github/workflows/checks.yml")) as Workflow;

// Every link of the chain must be a `bun run <name>`: a link of another shape (a bare `bun x`, a
// shell pipeline) would otherwise drop out of the comparison without failing it.
const chained = scripts.check.split("&&").map((link) => {
  const match = /^bun run (\S+)$/.exec(link.trim());
  if (match === null) throw new Error(`check chains a link that is not "bun run <name>": ${link}`);
  return match[1];
});

const gated = Object.values(workflow.jobs)
  .flatMap((job) => job.steps)
  .flatMap((step) => [...(step.run ?? "").matchAll(/\bbun run (\S+)/g)].map((m) => m[1]));

test("bun run check and checks.yml gate the same scripts", () => {
  expect([...new Set(chained)].sort()).toEqual([...new Set(gated)].sort());
});
