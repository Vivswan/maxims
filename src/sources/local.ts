import { lstatSync } from "node:fs";
import { join, resolve } from "node:path";
import type { Change } from "../util/change.ts";
import { assertInsideRoot } from "../util/fs.ts";
import { homePaths, storePathFor } from "../util/home.ts";
import type { SourceFrom, SourceResolver } from "./contract.ts";
import { hashFiles, readMemoryTree, type TreeFile, type WarnSink } from "./tree.ts";

export type LocalSourceFrom = Extract<SourceFrom, { type: "local" }>;

export function createLocalResolver(warn: WarnSink): SourceResolver<LocalSourceFrom> {
  return {
    async fetch(from, opts) {
      const tree = await readMemoryTree(from.path, opts, warn);
      return { sha: hashFiles(tree.files), memoryPath: opts.memoryPath, files: tree.files };
    },
  };
}

// The plan replaces the entry wholesale, so a memory deleted upstream or a switch between copied
// and live leaves nothing behind; it is meant for the moment a source changed, not for every sync.
// A live entry is a symlink to the source directory, so deleting it later never reaches the target.
export function materializeLocal(from: LocalSourceFrom, home: string, files: TreeFile[]): Change[] {
  const entry = assertInsideRoot(homePaths(home).store, storePathFor(home, from));
  const changes: Change[] = entryPresent(entry) ? [{ kind: "delete", path: entry }] : [];
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

// The plan is what the run would do, so a first install plans no deletion of the entry it has
// yet to write. Absent is judged as the apply judges it: only "nothing is there" drops the
// deletion, and an entry the probe cannot look at keeps it for the apply to report.
function entryPresent(path: string): boolean {
  try {
    lstatSync(path);
    return true;
  } catch (error) {
    const code = error instanceof Error && "code" in error ? error.code : undefined;
    return code !== "ENOENT" && code !== "ENOTDIR";
  }
}
