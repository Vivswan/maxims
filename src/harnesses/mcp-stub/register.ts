import { isDeepStrictEqual } from "node:util";
import { findNodeAtLocation, getNodeValue, type Node } from "jsonc-parser";
import { ExitCode, MaximsError } from "../../util/exit-codes.ts";
import { assertInsideRoot, type RootedPath } from "../../util/fs.ts";
import { jsonDocument } from "../../util/json.ts";
import {
  appendChild,
  assertParses,
  droppedBomNotice,
  type JsonReader,
  jsonReader,
  removeChild,
  replaceValue,
  withoutBom,
} from "../../util/jsonc.ts";
import { PACKAGE_ARGV } from "../../util/package.ts";
import {
  type HarnessContext,
  type HarnessDefinition,
  type RegistryRewrite,
  type Scope,
  scopeRoot,
} from "../contract.ts";

const MCP_SERVER_KEY = "maxims";
const [command, ...packageArgs] = PACKAGE_ARGV;
const MCP_SERVER_ENTRY = { command, args: [...packageArgs, "mcp-serve"] };
export const MCP_SERVER_COMMAND = [command, ...packageArgs, "mcp-serve"].join(" ");

// A definition's servers file at one scope, resolved once; `root` is what `path` was asserted
// under, `reader` the dialect the vendor loads the file in.
export type McpRegistration = {
  root: string;
  path: RootedPath;
  serversPath: readonly string[];
  reader: JsonReader;
};

// `null` where the definition declares no registry, or starts no servers from this scope.
export function mcpRegistrationAt(
  def: HarnessDefinition,
  scope: Scope,
  ctx: HarnessContext,
): McpRegistration | null {
  if (def.mcp === undefined) return null;
  const path = def.mcp.path(scope, ctx);
  if (path === null) return null;
  const root = scopeRoot(def, scope, ctx);
  return {
    root,
    path: assertInsideRoot(root, path),
    serversPath: def.mcp.serversPath,
    reader: jsonReader(def.mcp.format, def.displayName),
  };
}

export type McpRegistrationInput = {
  registration: McpRegistration;
  wanted: boolean;
  currentText: string | null;
};

export function rewriteServers(input: McpRegistrationInput): RegistryRewrite | null {
  const { path, serversPath, reader } = input.registration;
  const currentText = input.currentText === null ? null : withoutBom(input.currentText);
  const planned = editServers(currentText, path, serversPath, reader, input.wanted);
  if (planned === null) {
    // A current entry behind a BOM still earns the write that drops it; a file holding nothing of
    // ours to remove is left as it is.
    if (!input.wanted || currentText === null || currentText === input.currentText) return null;
    return { text: currentText, notice: droppedBomNotice(path) };
  }
  assertParses(planned.text, path, reader);
  const { verb } = planned;
  return {
    text: planned.text,
    notice: `${verb} the maxims MCP server ${verb === "removed" ? "from" : "in"} ${path}`,
  };
}

type Edit = { text: string; verb: "registered" | "updated" | "removed" };

// The entry at the servers object: taken out, registered, updated, or `null` when the file
// already says what the intent wants.
function entryEdit(text: string, container: Node, wanted: boolean): Edit | null {
  const current = findNodeAtLocation(container, [MCP_SERVER_KEY]);
  const property = current?.parent;
  if (!wanted) {
    if (property === undefined) return null;
    return { text: removeChild(text, container, property), verb: "removed" };
  }
  if (current === undefined) {
    return {
      text: appendChild(text, container, MCP_SERVER_KEY, MCP_SERVER_ENTRY),
      verb: "registered",
    };
  }
  if (isDeepStrictEqual(JSON.parse(JSON.stringify(getNodeValue(current))), MCP_SERVER_ENTRY)) {
    return null;
  }
  return { text: replaceValue(text, current, MCP_SERVER_ENTRY), verb: "updated" };
}

// `null` when the file already says what the intent wants.
function editServers(
  text: string | null,
  path: string,
  serversPath: readonly string[],
  reader: JsonReader,
  wanted: boolean,
): Edit | null {
  const entryPath = [...serversPath, MCP_SERVER_KEY];
  if (text === null) {
    if (!wanted) return null;
    const nested = entryPath.reduceRight<unknown>(
      (inner, key) => ({ [key]: inner }),
      MCP_SERVER_ENTRY,
    );
    return { text: jsonDocument(nested), verb: "registered" };
  }
  const root = assertParses(text, path, reader);
  // A missing level of the servers path is created with the rest nested inside it, so a file
  // without the key gains exactly one new property.
  let container = root;
  for (const [depth, key] of serversPath.entries()) {
    const child = findNodeAtLocation(container, [key]);
    if (child === undefined) {
      if (!wanted) return null;
      const rest = entryPath.slice(depth + 1);
      const value = rest.reduceRight<unknown>((inner, k) => ({ [k]: inner }), MCP_SERVER_ENTRY);
      return { text: appendChild(text, container, key, value), verb: "registered" };
    }
    if (child.type !== "object") {
      throw new MaximsError(
        ExitCode.DestinationWriteFailed,
        `${path}: ${serversPath.slice(0, depth + 1).join(".")} is not an object; left untouched`,
      );
    }
    container = child;
  }
  return entryEdit(text, container, wanted);
}
