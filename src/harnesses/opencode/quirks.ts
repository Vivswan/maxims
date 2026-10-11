import { join } from "node:path";
import { findNodeAtLocation, getNodeValue, type Node } from "jsonc-parser";
import { ExitCode, MaximsError } from "../../util/exit-codes.ts";
import { assertInsideRoot, type RootedPath } from "../../util/fs.ts";
import { jsonDocument } from "../../util/json.ts";
import {
  appendChild,
  assertParses,
  type ConfigRead,
  readConfigFile,
  removeChild,
} from "../../util/jsonc.ts";
import { type ConfigRewrite, type HarnessContext, type Scope, scopeRoot } from "../contract.ts";

// OpenCode reads only AGENTS.md by default and never expands `@file`, so the per-source rule
// files load only when `opencode.json` lists them. One glob over the rules directory covers every
// source, so adding the tenth source edits nothing here, and removal is the single entry coming
// back out. The two literals sit here rather than in the spec because the spec imports this file.
export const RULES_DIR = ".opencode/memories";
export const RULE_FILE_NAME = "maxims-{{slug}}.md";
export const INSTRUCTIONS_GLOB = `${RULES_DIR}/${RULE_FILE_NAME.replaceAll("{{slug}}", "*")}`;

// OpenCode loads both names when both exist and merges their `instructions`, so the entry is
// added to one file (the `.jsonc` when present) only if neither already lists it, and removed
// from every file that does.
const CONFIG_NAMES = ["opencode.jsonc", "opencode.json"] as const;

type ConfigFile = ConfigRead & { path: RootedPath };

export function configEdit(
  scope: Scope,
  ctx: HarnessContext,
  wanted: boolean,
): Promise<ConfigRewrite[]> {
  return scope === "project"
    ? reconcileInstructions(scopeRoot({}, scope, ctx), wanted)
    : Promise.resolve([]);
}

// Which file to rewrite is decided from the files on disk; the rewrite itself runs over the text
// the sync planner holds, so a settled config plans nothing and one another harness's registry
// is linked at takes both edits in one.
export async function reconcileInstructions(
  projectRoot: string,
  wanted: boolean,
): Promise<ConfigRewrite[]> {
  const files = await readConfigs(projectRoot);
  if (!wanted) {
    return files
      .filter((file) => file.text !== null && hasEntry(file.text, file.path))
      .map((file) => rewriteOf(projectRoot, file.path, false));
  }
  // Every file is read for the entry, since OpenCode loads both: one that does not parse is
  // refused however the other reads.
  const listed = files
    .map((file) => file.text !== null && hasEntry(file.text, file.path))
    .includes(true);
  if (listed) return [];
  // The entry goes into a file that is on disk, blank or not: a blank `opencode.jsonc` beside no
  // `opencode.json` is filled rather than left for OpenCode to choke on next to a new file.
  const target = files.find((file) => file.present) ?? files[files.length - 1];
  if (target === undefined) return [];
  return [rewriteOf(projectRoot, target.path, true)];
}

function rewriteOf(projectRoot: string, path: RootedPath, wanted: boolean): ConfigRewrite {
  return {
    root: projectRoot,
    path,
    entry: ["instructions"],
    rewrite: (text) => {
      if (text === null) {
        return wanted ? { text: jsonDocument({ instructions: [INSTRUCTIONS_GLOB] }) } : null;
      }
      const next = editInstructions(text, path, wanted);
      if (next === text) return null;
      assertParses(next, path);
      return { text: next };
    },
  };
}

async function readConfigs(projectRoot: string): Promise<ConfigFile[]> {
  return Promise.all(
    CONFIG_NAMES.map(async (name) => {
      const path = assertInsideRoot(projectRoot, join(projectRoot, name));
      return { path, ...(await readConfigFile(path)) };
    }),
  );
}

function hasEntry(text: string, path: string): boolean {
  const instructions = instructionsOf(assertParses(text, path), path);
  return (instructions?.children ?? []).some((child) => getNodeValue(child) === INSTRUCTIONS_GLOB);
}

// The key as OpenCode reads it, or `undefined` for a file without it; any other value is the
// user's error, refused by name on the way in and on the way out alike.
function instructionsOf(root: Node, path: string): Node | undefined {
  const instructions = findNodeAtLocation(root, ["instructions"]);
  if (instructions !== undefined && instructions.type !== "array") {
    throw new MaximsError(
      ExitCode.DestinationWriteFailed,
      `${path}: "instructions" is not an array; left untouched`,
    );
  }
  return instructions;
}

function editInstructions(text: string, path: string, wanted: boolean): string {
  const root = assertParses(text, path);
  const instructions = instructionsOf(root, path);
  if (instructions === undefined) {
    if (!wanted) return text;
    return appendChild(text, root, "instructions", [INSTRUCTIONS_GLOB]);
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
