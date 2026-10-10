import { isDeepStrictEqual } from "node:util";
import { findNodeAtLocation, getNodeValue } from "jsonc-parser";
import { ExitCode, MaximsError } from "../../util/exit-codes.ts";
import { assertInsideRoot, type RootedPath } from "../../util/fs.ts";
import { jsonDocument } from "../../util/json.ts";
import {
  appendChild,
  assertParses,
  readConfigText,
  removeChild,
  replaceValue,
} from "../../util/jsonc.ts";
import { PACKAGE_ARGV } from "../../util/package.ts";
import { type HarnessContext, type HarnessDefinition, type Scope, scopeRoot } from "../contract.ts";
import type { HookPlan } from "../hook-writer.ts";

const MCP_SERVER_KEY = "maxims";
const [command, ...packageArgs] = PACKAGE_ARGV;
const MCP_SERVER_ENTRY = { command, args: [...packageArgs, "mcp-serve"] };
export const MCP_SERVER_COMMAND = [command, ...packageArgs, "mcp-serve"].join(" ");

// A definition's servers file at one scope, resolved once: the file inside the scope's root and
// the key path of the servers map inside it.
export type McpRegistration = { path: RootedPath; serversPath: readonly string[] };

// `null` where the definition declares no registry, or starts no servers from this scope.
export function mcpRegistrationAt(
  def: HarnessDefinition,
  scope: Scope,
  ctx: HarnessContext,
): McpRegistration | null {
  if (def.mcp === undefined) return null;
  const path = def.mcp.path(scope, ctx);
  if (path === null) return null;
  return {
    path: assertInsideRoot(scopeRoot(def, scope, ctx), path),
    serversPath: def.mcp.serversPath,
  };
}

// Reads the servers file and hands the text to the pure planner, the way `planHookOnly` does for a
// hook registry.
export async function planMcpOnly(
  registration: McpRegistration,
  wanted: boolean,
): Promise<HookPlan> {
  const currentText = await readConfigText(registration.path);
  return planMcpRegistration({ registration, wanted, currentText });
}

export type McpRegistrationInput = {
  registration: McpRegistration;
  wanted: boolean;
  currentText: string | null;
};

export function planMcpRegistration(input: McpRegistrationInput): HookPlan {
  const { path, serversPath } = input.registration;
  const edit = editServers(input.currentText, path, serversPath, input.wanted);
  if (edit === null) return { changes: [] };
  assertParses(edit.text, path);
  return {
    changes: [{ kind: "write", path, content: edit.text }],
    notice: `${edit.verb} the maxims MCP server ${edit.verb === "removed" ? "from" : "in"} ${path}`,
  };
}

type Edit = { text: string; verb: "registered" | "updated" | "removed" };

// `null` when the file already says what the intent wants.
function editServers(
  text: string | null,
  path: string,
  serversPath: readonly string[],
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
  const root = assertParses(text, path);
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
