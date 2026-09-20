import { join } from "node:path";
import { parseBlocks, replaceBlock, stripBlock } from "../../rulefile/block.ts";
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

// The block grammar and the splice live in src/rulefile/block.ts: replacing covers the old span
// so every byte outside the pair survives, and appending closes whatever construct the user's
// text left open (a fence would otherwise swallow the markers, and every later sync would append
// again) before one blank line and the block. Add-then-remove leaves two residues by design: a
// missing final newline on the user's text, which gains one, and that closer, which stays.
export function planSharedBlockWrite(input: SharedBlockWriteInput): Change[] {
  const path = sharedBlockPath(input);
  const next = replaceBlock(input.currentText ?? "", input.source, input.block);
  assertWithinBudget(input.def, input.scope, path, next);
  if (next === input.currentText) return [];
  return [{ kind: "write", path, content: next }];
}

// Removal takes back the blank line the append wrote. stripBlock takes the one before the block;
// a block that opens the file has that line after it instead, where a later block's append put
// it, so the leading line ending goes too.
export function planSharedBlockRemove(input: SharedBlockLocation): Change[] {
  const path = sharedBlockPath(input);
  if (input.currentText === null) return [];
  const block = parseBlocks(input.currentText).blocks.find((b) => b.source === input.source);
  if (block === undefined) return [];
  const stripped = stripBlock(input.currentText, input.source);
  const rest = block.start === 0 ? stripped.text.replace(/^(\r\n|\r|\n)/, "") : stripped.text;
  if (rest.trim() === "") return [{ kind: "delete", path }];
  return [{ kind: "write", path, content: rest }];
}

export function sharedBlockPath(
  input: Pick<SharedBlockLocation, "def" | "target" | "scope" | "ctx">,
): RootedPath {
  const root = scopeRoot(input.def, input.scope, input.ctx);
  return assertInsideRoot(root, join(root, sharedBlockFile(input.target, root)));
}
