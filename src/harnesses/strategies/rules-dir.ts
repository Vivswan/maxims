import { join } from "node:path";
import type { Change } from "../../util/change.ts";
import { ExitCode, MaximsError } from "../../util/exit-codes.ts";
import { assertInsideRoot, type RootedPath } from "../../util/fs.ts";
import {
  byteBudgetFor,
  type HarnessContext,
  type HarnessDefinition,
  type Scope,
  scopeRoot,
  type Target,
} from "../contract.ts";

export type RulesDirTarget = Extract<Target, { kind: "rules-dir" }>;

export type RulesDirLocation = {
  def: HarnessDefinition;
  target: RulesDirTarget;
  scope: Scope;
  ctx: HarnessContext;
  sourceSlug: string;
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
  assertWithinBudget(input.def, input.scope, path, content);
  return [{ kind: "write", path, content }];
}

export function planRulesDirRemove(input: RulesDirLocation): Change[] {
  return [{ kind: "delete", path: rulesDirPath(input) }];
}

// The file name is one path segment or nothing: a segment check is what keeps the file inside the
// rules directory (`maxims-../sibling.md` is inside it lexically and would still plant a
// directory there), and the containment check is judged against the SCOPE root, not the rules
// directory, because a rules directory symlinked out of the project would pass as its own root.
export function rulesDirPath(input: RulesDirLocation): RootedPath {
  const root = scopeRoot(input.def, input.scope, input.ctx);
  const dir = join(root, input.target.dir);
  const name = input.target.fileName(input.sourceSlug);
  if (name === "" || name === "." || name === ".." || /[\\/]/.test(name)) {
    throw new MaximsError(
      ExitCode.DestinationWriteFailed,
      `refusing to write ${JSON.stringify(name)} inside ${dir}: a rule file name is one path segment`,
      { hint: "the source slug must not contain a path separator" },
    );
  }
  return assertInsideRoot(root, join(dir, name));
}

// A target that declares its own frontmatter owns the whole preamble, path filter included; the
// definition-level `scopeFrontmatter` serves harnesses whose always-on form needs none. The
// result ends in a newline or is empty, so a reader can compare a file's opening bytes to it.
export function rulesDirFrontmatter(
  input: Pick<RulesDirWriteInput, "def" | "target" | "paths">,
): string {
  const paths = input.paths === undefined || input.paths.length === 0 ? undefined : input.paths;
  const declared =
    input.target.frontmatter !== undefined
      ? input.target.frontmatter({ paths })
      : paths === undefined
        ? null
        : (input.def.scopeFrontmatter?.(paths) ?? null);
  if (declared === null || declared === "") return "";
  return declared.endsWith("\n") ? declared : `${declared}\n`;
}

export function assertWithinBudget(
  def: Pick<HarnessDefinition, "byteBudget" | "displayName">,
  scope: Scope,
  path: string,
  content: string,
): void {
  const budget = byteBudgetFor(def.byteBudget, scope);
  if (budget === undefined) return;
  const size = Buffer.byteLength(content);
  if (size <= budget) return;
  throw new MaximsError(
    ExitCode.RuleCapExceeded,
    `${path} would be ${size} bytes, over the ${budget}-byte limit ${def.displayName} loads`,
    { hint: "narrow the install with --memory or split the source" },
  );
}
