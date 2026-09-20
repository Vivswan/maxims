import { type Memory, parseMemory } from "../../memory/contract.ts";
import {
  hashFiles,
  readMemoryTree,
  type TreeFile,
  type TreeScope,
  type WarnSink,
} from "../../sources/tree.ts";
import { sha256 } from "../../util/fs.ts";

export type SourceMemory = {
  memory: Memory;
  relPath: string;
  text: string;
};

export type SourceTree = {
  sha: string;
  memories: SourceMemory[];
  invalid: { relPath: string; reason: string }[];
};

// Reads a source's memory files from `root` (a store entry, or a live source's own directory)
// and keeps the ones that pass the contract; the sha is the tree hash, which is what a copied
// local source records and what a live one is compared by.
export async function readSourceMemories(
  root: string,
  scope: TreeScope,
  warn: WarnSink,
): Promise<SourceTree> {
  const tree = await readMemoryTree(root, scope, warn);
  return { sha: hashFiles(tree.files), ...validateMemoryFiles(tree.files) };
}

export function validateMemoryFiles(
  files: readonly TreeFile[],
): Pick<SourceTree, "memories" | "invalid"> {
  const memories: SourceMemory[] = [];
  const invalid: SourceTree["invalid"] = [];
  for (const file of files) {
    const parsed = parseMemory(file.relPath, file.text);
    if (parsed.ok) memories.push({ memory: parsed.memory, relPath: file.relPath, text: file.text });
    else invalid.push({ relPath: file.relPath, reason: parsed.reason });
  }
  return { memories, invalid };
}

// Hashes are over text with CRLF folded to LF, so the same memory checked out on two platforms
// records one content hash; the bytes written to the store are the file's own.
export function contentHash(text: string): string {
  return sha256(text.replaceAll("\r\n", "\n"));
}
