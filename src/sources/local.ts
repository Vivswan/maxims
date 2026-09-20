import { join, resolve } from "node:path";
import type { SourceFrom } from "../state/schema.ts";
import type { Change } from "../util/change.ts";
import { assertInsideRoot } from "../util/fs.ts";
import { storePathFor } from "../util/home.ts";
import type { SourceResolver } from "./contract.ts";
import { hashFiles, readMemoryTree, type TreeFile, type WarnSink } from "./tree.ts";

export type LocalSourceFrom = Extract<SourceFrom, { type: "local" }>;

export function createLocalResolver(warn: WarnSink): SourceResolver {
  return {
    async fetch(from, opts) {
      const tree = await readMemoryTree(expectLocal(from).path, opts, warn);
      return { sha: hashFiles(tree.files), memoryPath: opts.memoryPath, files: tree.files };
    },
  };
}

// The plan replaces the entry wholesale, so a memory deleted upstream or a switch between copied
// and live leaves nothing behind; it is meant for the moment a source changed, not for every sync.
// A live entry is a symlink to the source directory, so deleting it later never reaches the target.
export function materializeLocal(from: LocalSourceFrom, home: string, files: TreeFile[]): Change[] {
  const entry = storePathFor(home, from);
  const changes: Change[] = [{ kind: "delete", path: entry }];
  if (from.live === true) {
    changes.push({ kind: "symlink", path: entry, target: resolve(from.path) });
    return changes;
  }
  changes.push({ kind: "mkdir", path: entry });
  for (const file of files) {
    changes.push({
      kind: "write",
      path: assertInsideRoot(entry, join(entry, ...file.relPath.split("/"))),
      content: file.text,
    });
  }
  return changes;
}

function expectLocal(from: SourceFrom): LocalSourceFrom {
  if (from.type !== "local") throw new Error(`the local resolver cannot fetch @${from.repo}`);
  return from;
}
