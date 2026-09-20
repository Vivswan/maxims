import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { Parser, type ReadEntry } from "tar";
import { MaximsError } from "../../util/exit-codes.ts";
import { assertInsideRoot, type RootedPath, writeFileAtomic } from "../../util/fs.ts";
import type { WarnSink } from "../tree.ts";

// GitHub wraps every archive in one `<owner>-<repo>-<sha>/` folder; the first segment of every
// entry is dropped so `destDir` holds the repository root itself.
export async function extractTarball(
  bytes: Uint8Array,
  destDir: string,
  warn: WarnSink,
): Promise<void> {
  const root = await mkdir(destDir, { recursive: true }).then(() => destDir);
  const pending: Promise<void>[] = [];
  const reading = new Set<ReadEntry>();
  const parser = new Parser({
    strict: true,
    onReadEntry: (entry) => {
      pending.push(place(entry, root, warn, reading));
    },
  });
  parser.on("ignoredEntry", (entry: ReadEntry) => {
    warn(`skipped tarball entry ${entry.path}: ${entry.type} entries are never extracted`);
  });
  const parsed = new Promise<void>((resolvePromise, reject) => {
    parser.on("error", (error: Error) => {
      // An archive cut off inside a file never ends that file's stream, so its body read would wait
      // forever; failing the read by hand is what lets the ladder move to the next rung. Only an
      // entry whose body is being read has a listener, so only those are failed.
      for (const entry of reading) entry.emit("error", error);
      reject(error);
    });
    parser.on("end", () => resolvePromise());
    parser.end(Buffer.from(bytes));
  });
  try {
    await parsed;
  } finally {
    await Promise.allSettled(pending);
  }
  await Promise.all(pending);
}

// Every rejection drains the entry so the parser moves on; the checks run before `assertInsideRoot`
// so a warning can say which rule the entry broke, and the assertion stays as the last guard.
async function place(
  entry: ReadEntry,
  root: string,
  warn: WarnSink,
  reading: Set<ReadEntry>,
): Promise<void> {
  const rejection = rejectionReason(entry);
  if (rejection !== null) {
    warn(`skipped tarball entry ${entry.path}: ${rejection}`);
    entry.resume();
    return;
  }
  const segments = entry.path.split(/[\\/]+/).filter((part) => part !== "" && part !== ".");
  const inner = segments.slice(1);
  if (inner.length === 0) {
    entry.resume();
    return;
  }
  let target: RootedPath;
  try {
    target = assertInsideRoot(root, join(root, ...inner));
  } catch (cause) {
    if (!(cause instanceof MaximsError)) throw cause;
    warn(`skipped tarball entry ${entry.path}: resolves outside the extraction directory`);
    entry.resume();
    return;
  }
  if (entry.type === "Directory") {
    entry.resume();
    await mkdir(target, { recursive: true });
    return;
  }
  reading.add(entry);
  try {
    writeFileAtomic(target, await entry.concat());
  } finally {
    reading.delete(entry);
  }
}

function rejectionReason(entry: ReadEntry): string | null {
  if (entry.type !== "File" && entry.type !== "Directory") {
    return `${entry.type} entries are never extracted`;
  }
  if (/^([\\/]|[A-Za-z]:)/.test(entry.path)) return "absolute paths are rejected";
  if (entry.path.split(/[\\/]+/).includes("..")) return "path traversal is rejected";
  return null;
}
