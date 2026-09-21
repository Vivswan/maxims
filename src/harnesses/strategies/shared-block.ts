import { join } from "node:path";
import { replaceBlock, stripBlock } from "../../rulefile/block.ts";
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
import { assertWithinBudget } from "./rules-dir.ts";

export type SharedBlockTarget = Extract<Target, { kind: "shared-block" }>;

export type SharedBlockLocation = {
  def: HarnessDefinition;
  target: SharedBlockTarget;
  scope: Scope;
  ctx: HarnessContext;
  source: string;
  currentText: string | null;
};

export type SharedBlockWriteInput = SharedBlockLocation & {
  block: string;
};

// The grammar, the splice and the block order live in src/rulefile/block.ts. Add-then-remove
// leaves three residues by design: a missing final newline on the user's text, which gains one;
// the closer the first block wrote for a construct the user's text left open, which stays; and a
// CRLF or lone-CR line ending that closed a block on disk, which becomes LF.
export function planSharedBlockWrite(input: SharedBlockWriteInput): Change[] {
  const path = sharedBlockPath(input);
  const next = replaceBlock(input.currentText ?? "", input.source, input.block);
  assertWithinBudget(input.def, input.scope, path, next);
  if (next === input.currentText) return [];
  return [{ kind: "write", path, content: next }];
}

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
