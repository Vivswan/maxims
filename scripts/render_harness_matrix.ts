#!/usr/bin/env bun
// Renders the harness matrix on docs/harnesses.md from the registry, so the page describes the
// definitions that ship rather than a hand-kept copy of them. `--check` exits 1 when the committed
// block differs from the render; without it the page is rewritten in place.
import { readFileSync, writeFileSync } from "node:fs";
import { join, resolve, sep } from "node:path";
import {
  type HarnessContext,
  type HarnessDefinition,
  type HookShape,
  type Scope,
  scopeRoot,
} from "../src/harnesses/contract.ts";
import { HARNESSES } from "../src/harnesses/registry.ts";

export const MATRIX_PAGE = "docs/harnesses.md";
export const MATRIX_BEGIN = "<!-- BEGIN GENERATED: harness-matrix -->";
export const MATRIX_END = "<!-- END GENERATED: harness-matrix -->";
const REGENERATE = "bun run docs:matrix";

// Paths render as a user would type them: `~` for the home and nothing for the project root.
const DISPLAY_CONTEXT: HarnessContext = { home: "~", projectRoot: ".", env: {} };
const SOURCE_PLACEHOLDER = "<source>";
const SCOPES: readonly Scope[] = ["project", "global"];

const COLUMNS = [
  "id",
  "harness",
  "tier",
  "project target",
  "global target",
  "strategy",
  "hook",
  "stdout",
  "markers",
  "byte budget",
] as const;

const code = (text: string): string => `\`${text}\``;
const display = (path: string): string => path.split(sep).join("/");

function renderTarget(def: HarnessDefinition, scope: Scope): string {
  const target = def.targets[scope];
  if (target === null) return "none";
  const root = scopeRoot(def, scope, DISPLAY_CONTEXT);
  if (target.kind === "rules-dir") {
    return code(display(join(root, target.dir, target.fileName(SOURCE_PLACEHOLDER))));
  }
  return `${code(display(join(root, target.file)))} block`;
}

// Strategy A is a rules directory, B a shared block; a harness may choose one per scope.
function renderStrategy(def: HarnessDefinition): string {
  const letters = SCOPES.flatMap((scope) => {
    const target = def.targets[scope];
    return target === null ? [] : [{ scope, letter: target.kind === "rules-dir" ? "A" : "B" }];
  });
  const distinct = new Set(letters.map(({ letter }) => letter));
  if (distinct.size === 1) return letters[0]?.letter ?? "-";
  return letters.map(({ scope, letter }) => `${letter} ${scope}`).join(", ");
}

// A hook path is shown only for a scope the harness installs into: a definition still declares a
// global path when its global target is null, and the page says that scope is skipped.
function renderHookPaths(
  def: HarnessDefinition,
  path: (scope: Scope, ctx: HarnessContext) => string,
): string {
  return SCOPES.filter((scope) => def.targets[scope] !== null)
    .map((scope) => code(display(path(scope, DISPLAY_CONTEXT))))
    .join(" or ");
}

function renderHook(def: HarnessDefinition): string {
  const hook = def.hook;
  switch (hook.kind) {
    case "none":
      return "none";
    case "custom":
      return "custom";
    case "registry": {
      const event = hook.eventPath[hook.eventPath.length - 1] ?? "";
      const suffix = hook.async ? ", async" : "";
      return `${code(event)} entry in ${renderHookPaths(def, hook.path)}${suffix}`;
    }
    case "file":
      return `maxims-owned ${hook.executable ? "executable" : "file"} ${renderHookPaths(def, hook.path)}`;
  }
}

function renderStdout(hook: HookShape): string {
  return hook.kind === "registry" || hook.kind === "file" ? code(hook.stdout) : "-";
}

// The declared tier, plus the config value that demotes it when the definition names one.
function renderTier(def: HarnessDefinition): string {
  const tierCheck = def.hook.kind === "registry" ? def.hook.tierCheck : undefined;
  if (tierCheck !== undefined) {
    return `${def.tier}, or 2 when ${code(tierCheck.key)} is ${code(String(tierCheck.demotesWhen))}`;
  }
  if (def.achievedTier !== undefined) return `${def.tier}, or 2 by config`;
  return String(def.tier);
}

function renderBudget(def: HarnessDefinition): string {
  return def.byteBudget === undefined ? "-" : `${def.byteBudget.toLocaleString("en-US")} bytes`;
}

export function renderRow(def: HarnessDefinition): string {
  const cells = [
    code(def.id),
    def.displayName,
    renderTier(def),
    renderTarget(def, "project"),
    renderTarget(def, "global"),
    renderStrategy(def),
    renderHook(def),
    renderStdout(def.hook),
    def.markers,
    renderBudget(def),
  ];
  return `| ${cells.join(" | ")} |`;
}

export function renderMatrix(defs: readonly HarnessDefinition[] = HARNESSES): string {
  const header = `| ${COLUMNS.join(" | ")} |`;
  const rule = `|${COLUMNS.map(() => " --- ").join("|")}|`;
  return [header, rule, ...defs.map(renderRow)].join("\n");
}

// The block between the markers is replaced whole, with a blank line on each side: a table glued
// to the marker comment renders as one HTML block, and the docs probe then no longer sees a
// generated region it should skip.
export function renderPage(page: string, defs: readonly HarnessDefinition[] = HARNESSES): string {
  const begin = page.indexOf(MATRIX_BEGIN);
  const end = page.indexOf(MATRIX_END);
  if (begin === -1 || end === -1 || end < begin) {
    throw new Error(`${MATRIX_PAGE} needs ${MATRIX_BEGIN} before ${MATRIX_END}`);
  }
  const head = page.slice(0, begin + MATRIX_BEGIN.length);
  const tail = page.slice(end);
  return `${head}\n\n${renderMatrix(defs)}\n\n${tail}`;
}

function main(argv: string[]): number {
  const check = argv.includes("--check");
  const pagePath = resolve(import.meta.dir, "..", MATRIX_PAGE);
  const current = readFileSync(pagePath, "utf8");
  const next = renderPage(current);
  if (next === current) {
    process.stdout.write(`${MATRIX_PAGE}: matrix up to date (${HARNESSES.length} rows)\n`);
    return 0;
  }
  if (check) {
    process.stderr.write(`${MATRIX_PAGE}: matrix differs from the registry; run ${REGENERATE}\n`);
    return 1;
  }
  writeFileSync(pagePath, next);
  process.stdout.write(`${MATRIX_PAGE}: matrix rewritten (${HARNESSES.length} rows)\n`);
  return 0;
}

if (import.meta.main) process.exit(main(process.argv.slice(2)));
