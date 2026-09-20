import { appendFile, mkdir, readFile, stat } from "node:fs/promises";
import { dirname } from "node:path";
import { ExitCode, MaximsError } from "./exit-codes.ts";
import { assertInsideRoot, writeFileAtomic } from "./fs.ts";
import { homePaths } from "./home.ts";

export const MAX_LOG_BYTES = 256 * 1024;

export async function appendRefreshLog(home: string, line: string): Promise<void> {
  const path = homePaths(home).log;
  try {
    await mkdir(dirname(path), { recursive: true });
    await appendFile(path, `${line.replace(/\r?\n$/, "")}\n`);
    const size = (await stat(path)).size;
    if (size > MAX_LOG_BYTES) {
      writeFileAtomic(assertInsideRoot(home, path), trimOldest(await readFile(path, "utf8")));
    }
  } catch (cause) {
    if (cause instanceof MaximsError) throw cause;
    throw new MaximsError(ExitCode.DestinationWriteFailed, `cannot append to ${path}`, { cause });
  }
}

function trimOldest(text: string): string {
  let start = 0;
  let size = Buffer.byteLength(text);
  while (size > MAX_LOG_BYTES) {
    const newline = text.indexOf("\n", start);
    if (newline === -1) return "";
    size -= Buffer.byteLength(text.slice(start, newline + 1));
    start = newline + 1;
  }
  return text.slice(start);
}
