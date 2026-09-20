import { join } from "node:path";
import type { Change } from "../../util/change.ts";
import { assertInsideRoot, type RootedPath } from "../../util/fs.ts";
import {
  type HarnessContext,
  type HarnessDefinition,
  type Scope,
  scopeRoot,
  type Target,
} from "../contract.ts";
import { assertWithinBudget } from "./rules-dir.ts";

export type SharedBlockTarget = Extract<Target, { kind: "shared-block" }>;

// The byte span one managed block occupies in a file, begin marker through the end marker's line
// break, as the marker-grammar parser in src/rulefile/block.ts reports it.
export type ManagedBlockSpan = {
  source: string;
  start: number;
  end: number;
};

export type BlockParser = (text: string) => ManagedBlockSpan[];

export type SharedBlockLocation = {
  def: HarnessDefinition;
  target: SharedBlockTarget;
  scope: Scope;
  ctx: HarnessContext;
  source: string;
  currentText: string | null;
  parseBlocks: BlockParser;
};

export type SharedBlockWriteInput = SharedBlockLocation & {
  block: string;
};

// Replacing splices the new block over the old span, so every byte outside the pair survives
// verbatim. Appending puts one blank line between the user's text and the block and remove
// strips it again; the one byte add-then-remove does not restore is a missing final newline on
// the user's text, which gains one.
export function planSharedBlockWrite(input: SharedBlockWriteInput): Change[] {
  const path = sharedBlockPath(input);
  const block = withTrailingNewline(input.block);
  const current = input.currentText ?? "";
  const span = findSpan(input);
  const next =
    span === undefined
      ? `${separated(current)}${block}`
      : `${current.slice(0, span.start)}${block}${current.slice(span.end)}`;
  assertWithinBudget(input.def, path, next);
  if (next === input.currentText) return [];
  return [{ kind: "write", path, content: next }];
}

export function planSharedBlockRemove(input: SharedBlockLocation): Change[] {
  const path = sharedBlockPath(input);
  const span = findSpan(input);
  if (span === undefined || input.currentText === null) return [];
  const before = input.currentText.slice(0, span.start);
  const after = input.currentText.slice(span.end);
  const rest =
    before === "" ? after.replace(/^\n/, "") : `${before.replace(/\n\n$/, "\n")}${after}`;
  if (rest.trim() === "") return [{ kind: "delete", path }];
  return [{ kind: "write", path, content: rest }];
}

export function sharedBlockPath(
  input: Pick<SharedBlockLocation, "def" | "target" | "scope" | "ctx">,
): RootedPath {
  const root = scopeRoot(input.def, input.scope, input.ctx);
  return assertInsideRoot(root, join(root, input.target.file));
}

function findSpan(input: SharedBlockLocation): ManagedBlockSpan | undefined {
  if (input.currentText === null) return undefined;
  return input.parseBlocks(input.currentText).find((span) => span.source === input.source);
}

function separated(text: string): string {
  if (text === "") return "";
  return `${withTrailingNewline(text)}\n`;
}

function withTrailingNewline(text: string): string {
  return text.endsWith("\n") ? text : `${text}\n`;
}
