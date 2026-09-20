import { join } from "node:path";
import { findNodeAtLocation, getNodeValue } from "jsonc-parser";
import type { Change } from "../../util/change.ts";
import { ExitCode, MaximsError } from "../../util/exit-codes.ts";
import { assertInsideRoot, type RootedPath } from "../../util/fs.ts";
import { appendChild, assertParses, readConfigText, removeChild } from "../mcp-stub/jsonc-edit.ts";

// OpenCode reads only AGENTS.md by default and never expands `@file`, so the per-source rule
// files load only when `opencode.json` lists them. One glob covers every source, so adding the
// tenth source edits nothing here, and removal is the single entry coming back out.
export const INSTRUCTIONS_GLOB = ".opencode/memories/maxims-*.md";

// OpenCode loads both names when both exist and merges their `instructions`, so the entry is
// added to one file (the `.jsonc` when present) only if neither already lists it, and removed
// from every file that does.
const CONFIG_NAMES = ["opencode.jsonc", "opencode.json"] as const;

type ConfigFile = { path: RootedPath; text: string | null };

export async function reconcileInstructions(
  projectRoot: string,
  wanted: boolean,
): Promise<Change[]> {
  const files = await readConfigs(projectRoot);
  if (!wanted) {
    return files.flatMap((file) =>
      file.text === null ? [] : writeIfChanged(file, editInstructions(file.text, file.path, false)),
    );
  }
  const listed = files.map((file) => file.text !== null && hasEntry(file.text, file.path));
  if (listed.includes(true)) return [];
  const target = files.find((file) => file.text !== null) ?? files[files.length - 1];
  if (target === undefined) return [];
  return writeIfChanged(target, editInstructions(target.text ?? "", target.path, true));
}

function writeIfChanged(file: ConfigFile, next: string): Change[] {
  if (next === file.text) return [];
  assertParses(next, file.path);
  return [{ kind: "write", path: file.path, content: next }];
}

async function readConfigs(projectRoot: string): Promise<ConfigFile[]> {
  return Promise.all(
    CONFIG_NAMES.map(async (name) => {
      const path = assertInsideRoot(projectRoot, join(projectRoot, name));
      return { path, text: await readConfigText(path) };
    }),
  );
}

function hasEntry(text: string, path: string): boolean {
  if (text.trim() === "") return false;
  const instructions = findNodeAtLocation(assertParses(text, path), ["instructions"]);
  return (instructions?.children ?? []).some((child) => getNodeValue(child) === INSTRUCTIONS_GLOB);
}

function editInstructions(text: string, path: string, wanted: boolean): string {
  if (text.trim() === "") {
    if (!wanted) return text;
    return `${JSON.stringify({ instructions: [INSTRUCTIONS_GLOB] }, null, 2)}\n`;
  }
  const root = assertParses(text, path);
  const instructions = findNodeAtLocation(root, ["instructions"]);
  if (instructions === undefined) {
    if (!wanted) return text;
    return appendChild(text, root, "instructions", [INSTRUCTIONS_GLOB]);
  }
  if (instructions.type !== "array") {
    throw new MaximsError(
      ExitCode.DestinationWriteFailed,
      `${path}: "instructions" is not an array; left untouched`,
    );
  }
  const entry = (instructions.children ?? []).find(
    (child) => getNodeValue(child) === INSTRUCTIONS_GLOB,
  );
  if (wanted) {
    if (entry !== undefined) return text;
    return appendChild(text, instructions, null, INSTRUCTIONS_GLOB);
  }
  if (entry === undefined) return text;
  // A hand-duplicated entry leaves after one pass too: each removal re-parses what is left.
  return editInstructions(removeChild(text, instructions, entry), path, false);
}
