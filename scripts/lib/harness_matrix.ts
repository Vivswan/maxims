// The harness matrix on docs/harnesses.md, rendered from the registry so the page describes the
// definitions that ship rather than a hand-kept copy of them. render_docs_tables.ts splices it
// into the page and fails the check while the committed block differs.
import { join, sep } from "node:path";
import {
  byteBudgetFor,
  type HarnessContext,
  type HarnessDefinition,
  parseSourceSlug,
  type Scope,
  type SourceSlug,
  scopeRoot,
} from "../../src/harnesses/contract.ts";
import { HARNESSES } from "../../src/harnesses/registry.ts";
import { markdownTable } from "./markdown_table.ts";

// Paths render as a user would type them: `~` for the home and nothing for the project root.
const DISPLAY_CONTEXT: HarnessContext = { home: "~", projectRoot: ".", cwd: ".", env: {} };
const SOURCE_PLACEHOLDER = "<source>";
// A real slug goes through `fileName`, then gives way to the placeholder the matrix shows.
const SLUG_SENTINEL = sentinelSlug();

function sentinelSlug(): SourceSlug {
  const slug = parseSourceSlug("source");
  if (slug === null) throw new Error("the sentinel is a source slug");
  return slug;
}
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
  "mcp stub",
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
    const name = target.fileName(SLUG_SENTINEL).replaceAll(SLUG_SENTINEL, SOURCE_PLACEHOLDER);
    return code(display(join(root, target.dir, name)));
  }
  const fallbacks = target.precedence?.map((name) => code(display(join(root, name)))) ?? [];
  const first = target.skipsEmpty === undefined ? "first existing" : "first non-empty";
  const written =
    fallbacks.length === 0 ? "" : `, written into the ${first} of ${fallbacks.join(", ")}`;
  return `${code(display(join(root, target.file)))} block${written}`;
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

function renderStdout(def: HarnessDefinition): string {
  const hook = def.hook;
  return hook.kind === "registry" || hook.kind === "file" ? code(hook.stdout) : "-";
}

function renderMcp(def: HarnessDefinition): string {
  const mcp = def.mcp;
  if (mcp === undefined) return "-";
  const paths = SCOPES.map((scope) => mcp.path(scope, DISPLAY_CONTEXT)).filter(
    (path): path is string => path !== null,
  );
  return paths.map((path) => code(display(path))).join(" or ");
}

// The declared tier, plus the config value that demotes it when the definition names one.
function renderTier(def: HarnessDefinition): string {
  const tierCheck = def.hook.kind === "registry" ? def.hook.tierCheck : undefined;
  if (tierCheck !== undefined) {
    return `${def.tier}, or 2 when ${code(tierCheck.key)} is ${code(String(tierCheck.demotesWhen))}`;
  }
  return String(def.tier);
}

function renderBudget(def: HarnessDefinition): string {
  const budgets = SCOPES.map((scope) => ({ scope, bytes: byteBudgetFor(def.byteBudget, scope) }));
  const declared = budgets.filter(
    (entry): entry is { scope: Scope; bytes: number } => entry.bytes !== undefined,
  );
  if (declared.length === 0) return "-";
  const format = (bytes: number) => `${bytes.toLocaleString("en-US")} bytes`;
  const distinct = new Set(declared.map(({ bytes }) => bytes));
  if (distinct.size === 1 && declared.length === SCOPES.length) {
    return format(declared[0]?.bytes ?? 0);
  }
  return declared.map(({ scope, bytes }) => `${scope} ${format(bytes)}`).join(", ");
}

export function renderRow(def: HarnessDefinition): readonly string[] {
  return [
    code(def.id),
    def.displayName,
    renderTier(def),
    renderTarget(def, "project"),
    renderTarget(def, "global"),
    renderStrategy(def),
    renderHook(def),
    renderStdout(def),
    renderMcp(def),
    def.markers,
    renderBudget(def),
  ];
}

export function renderMatrix(defs: readonly HarnessDefinition[] = HARNESSES): string {
  return markdownTable(COLUMNS, defs.map(renderRow));
}
