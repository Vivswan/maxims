import { mkdir } from "node:fs/promises";
import { extract, type ReadEntry } from "tar";
import type { WarnSink } from "../tree.ts";

// GitHub wraps every archive in one `<owner>-<repo>-<sha>/` folder; `strip` drops it so `destDir`
// holds the repository root itself. `strict` turns anything tar would only warn about into a
// failed extraction, so an entry is either written, skipped here with a warning, or fatal. `sync`
// leaves no write in flight when that failure throws: the next rung empties and reuses `destDir`.
export async function extractTarball(
  bytes: Uint8Array,
  destDir: string,
  warn: WarnSink,
): Promise<void> {
  await mkdir(destDir, { recursive: true });
  const unpack = extract({
    sync: true,
    cwd: destDir,
    strip: 1,
    strict: true,
    filter: (_path, entry) => rejectionReason(entry as ReadEntry) === null,
  });
  unpack.on("ignoredEntry", (entry: ReadEntry) => {
    warn(`skipped tarball entry ${entry.path}: ${rejectionReason(entry)}`);
  });
  unpack.end(Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength));
}

// tar would strip an absolute root and extract the rest; the store takes neither that nor a link.
// The root is looked for after the top folder too: `top/c:d` is drive `c:` once `strip` has run.
function rejectionReason(entry: ReadEntry): string | null {
  if (entry.type !== "File" && entry.type !== "Directory") {
    return `${entry.type} entries are never extracted`;
  }
  if (/^([^\\/]*[\\/])?([\\/]|[A-Za-z]:)/.test(entry.path)) return "absolute paths are rejected";
  if (entry.path.split(/[\\/]+/).includes("..")) return "path traversal is rejected";
  return null;
}
