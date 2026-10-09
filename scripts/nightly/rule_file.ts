import { readFileSync } from "node:fs";
import { join } from "node:path";

// A missing file and one that cannot be read are different defects, and the second keeps its
// reason: a package that left a directory at the path must not read as "gone".
export type RuleFile = { text: string } | { problem: string };

/** `file` is HOME-relative, with forward slashes. */
export function readRuleFile(home: string, file: string, absent: string): RuleFile {
  const shown = `~/${file}`;
  try {
    return { text: readFileSync(join(home, file), "utf8") };
  } catch (error) {
    const code = error instanceof Error && "code" in error ? error.code : undefined;
    if (code === "ENOENT") return { problem: `${shown} ${absent}` };
    const message = error instanceof Error ? error.message : String(error);
    return { problem: `${shown} could not be read: ${message}` };
  }
}
