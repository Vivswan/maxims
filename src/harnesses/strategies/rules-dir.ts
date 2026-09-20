import { join } from "node:path";
import type { Change } from "../../util/change.ts";
import { ExitCode, MaximsError } from "../../util/exit-codes.ts";
import { assertInsideRoot } from "../../util/fs.ts";
import type { HarnessContext, HarnessDefinition, Scope, Target } from "../contract.ts";
import { destinationRoot } from "./destination.ts";

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
  assertWithinBudget(input.def, path, content);
  return [{ kind: "write", path, content }];
}

export function planRulesDirRemove(input: RulesDirLocation): Change[] {
  return [{ kind: "delete", path: rulesDirPath(input) }];
}

export function rulesDirPath(input: RulesDirLocation): string {
  const root = destinationRoot(input.scope, input.ctx);
  return assertInsideRoot(
    root,
    join(root, input.target.dir, input.target.fileName(input.sourceSlug)),
  );
}

// A target that declares its own frontmatter owns the whole preamble, path filter included; the
// definition-level `scopeFrontmatter` serves harnesses whose always-on form needs none.
function rulesDirFrontmatter(input: RulesDirWriteInput): string {
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
  path: string,
  content: string,
): void {
  if (def.byteBudget === undefined) return;
  const size = Buffer.byteLength(content);
  if (size <= def.byteBudget) return;
  throw new MaximsError(
    ExitCode.RuleCapExceeded,
    `${path} would be ${size} bytes, over the ${def.byteBudget}-byte limit ${def.displayName} loads`,
    { hint: "narrow the install with --memory or split the source" },
  );
}
