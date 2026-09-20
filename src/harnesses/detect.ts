import { statSync } from "node:fs";

// ENOTDIR reads as absent because Bun throws it for a path under a regular file even with
// throwIfNoEntry off. Every other failure surfaces, EACCES on a locked parent among them, so
// "could not look" never passes for "not installed".
export function configDirExists(path: string): boolean {
  try {
    return statSync(path, { throwIfNoEntry: false })?.isDirectory() === true;
  } catch (cause) {
    if (cause instanceof Error && "code" in cause && cause.code === "ENOTDIR") return false;
    throw cause;
  }
}
