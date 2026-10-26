import { join } from "node:path";
import type { HarnessId } from "../../contracts/harness-id.ts";
import type { Change } from "../../util/change.ts";
import { ExitCode, MaximsError } from "../../util/exit-codes.ts";
import { assertInsideRoot, type RootedPath } from "../../util/fs.ts";
import {
  type HarnessContext,
  type HarnessDefinition,
  ruleFileBudget,
  type Scope,
  type SourceSlug,
  scopeRoot,
  type Target,
} from "../contract.ts";

export type RulesDirTarget = Extract<Target, { kind: "rules-dir" }>;

export type RulesDirLocation = {
  def: HarnessDefinition;
  target: RulesDirTarget;
  scope: Scope;
  ctx: HarnessContext;
  sourceSlug: SourceSlug;
};

export type RulesDirWriteInput = RulesDirLocation & {
  block: string;
  paths?: string[];
};

// The rule file is always a real file: the plan never carries a `symlink` change for it, and a
// `write` renames a regular file over a symlink left at the path whenever the content differs.
export function planRulesDirWrite(input: RulesDirWriteInput): Change[] {
  const path = rulesDirPath(input);
  const content = `${rulesDirFrontmatter(input)}${input.block}`;
  assertWithinBudget(input.def, input.scope, path, content, scopedPaths(input.paths) !== undefined);
  return [{ kind: "write", path, content }];
}

export function planRulesDirRemove(input: RulesDirLocation): Change[] {
  return [{ kind: "delete", path: rulesDirPath(input) }];
}

// The file name is one path segment by construction: a `SourceSlug` holds nothing a path builder
// could misread and the spec admits no separator in the template. The containment check is judged
// against the SCOPE root, not the rules directory, because a rules directory symlinked out of the
// project would pass as its own root.
export function rulesDirPath(input: RulesDirLocation): RootedPath {
  const root = scopeRoot(input.def, input.scope, input.ctx);
  const dir = join(root, input.target.dir);
  return assertInsideRoot(root, join(dir, input.target.fileName(input.sourceSlug)));
}

// The preamble a target declares for itself, else the definition's path filter; `null` when the
// file opens with neither.
function declaredFrontmatter(
  input: Pick<RulesDirWriteInput, "def" | "target">,
  paths: string[] | undefined,
): string | null {
  if (input.target.frontmatter !== undefined) return input.target.frontmatter({ paths });
  if (paths === undefined) return null;
  return input.def.scopeFrontmatter?.render(paths) ?? null;
}

// A target that declares its own frontmatter owns the whole preamble, path filter included; the
// definition-level `scopeFrontmatter` serves harnesses whose always-on form needs none. The
// result ends in a newline or is empty, so a reader can compare a file's opening bytes to it.
export function rulesDirFrontmatter(
  input: Pick<RulesDirWriteInput, "def" | "target" | "paths">,
): string {
  const declared = declaredFrontmatter(input, scopedPaths(input.paths));
  if (declared === null || declared === "") return "";
  return declared.endsWith("\n") ? declared : `${declared}\n`;
}

// A rule file over a harness's byte budget. The planner reads the overage and the reader off it
// to decide which source to hold and how to name the way out.
export class BudgetExceeded extends MaximsError {
  constructor(
    readonly path: string,
    readonly size: number,
    readonly budget: number,
    readonly displayName: string,
    readonly harnessId: HarnessId,
  ) {
    super(
      ExitCode.RuleCapExceeded,
      `${path} would be ${size} bytes, over the ${budget}-byte budget kept for ${displayName}`,
      { hint: "narrow the install with --memory or split the source" },
    );
  }
}

// An empty paths list is no scoping, so a file with none loads at launch like one with no list.
function scopedPaths(paths: string[] | undefined): string[] | undefined {
  return paths === undefined || paths.length === 0 ? undefined : paths;
}

// `onDemand` says the file carries a path filter, so the harness reads it on demand and its
// smaller limit, where declared, is the one that holds.
export function assertWithinBudget(
  def: Pick<HarnessDefinition, "byteBudget" | "displayName" | "id" | "scopeFrontmatter">,
  scope: Scope,
  path: string,
  content: string,
  onDemand = false,
): void {
  const budget = ruleFileBudget(def, scope, onDemand);
  if (budget === undefined) return;
  const size = Buffer.byteLength(content);
  if (size <= budget) return;
  throw new BudgetExceeded(path, size, budget, def.displayName, def.id);
}
