import { type Stats, statSync } from "node:fs";

// ENOTDIR reads as absent because Bun throws it for a path under a regular file even with
// throwIfNoEntry off. Every other failure surfaces, EACCES on a locked parent among them, so
// "could not look" never passes for "not there".
export function statOrAbsent(path: string): Stats | null {
  try {
    return statSync(path, { throwIfNoEntry: false }) ?? null;
  } catch (cause) {
    if (cause instanceof Error && "code" in cause && cause.code === "ENOTDIR") return null;
    throw cause;
  }
}

export function configDirExists(path: string): boolean {
  return statOrAbsent(path)?.isDirectory() === true;
}
