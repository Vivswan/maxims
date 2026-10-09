import { join } from "node:path";
import { stripBlock } from "../../rulefile/block.ts";
import type { Change } from "../../util/change.ts";
import { assertInsideRoot, type RootedPath } from "../../util/fs.ts";
import {
  type HarnessContext,
  type HarnessDefinition,
  type Scope,
  scopeRoot,
  sharedBlockFile,
  type Target,
} from "../contract.ts";

export type SharedBlockTarget = Extract<Target, { kind: "shared-block" }>;

export type SharedBlockLocation = {
  def: HarnessDefinition;
  target: SharedBlockTarget;
  scope: Scope;
  ctx: HarnessContext;
  source: string;
  currentText: string | null;
};

// Writing a block is the engine's: it splices every block of a file with the grammar's own
// `replaceBlock` and judges the byte budget once on the finished text. Only the removal, which
// decides between a rewrite and deleting an emptied file, is a strategy of its own.
export function planSharedBlockRemove(input: SharedBlockLocation): Change[] {
  const path = sharedBlockPath(input);
  if (input.currentText === null) return [];
  const stripped = stripBlock(input.currentText, input.source);
  if (stripped.text === input.currentText) return [];
  if (stripped.emptied) return [{ kind: "delete", path }];
  return [{ kind: "write", path, content: stripped.text }];
}

export function sharedBlockPath(
  input: Pick<SharedBlockLocation, "def" | "target" | "scope" | "ctx">,
): RootedPath {
  const root = scopeRoot(input.def, input.scope, input.ctx);
  return assertInsideRoot(root, join(root, sharedBlockFile(input.target, root)));
}
