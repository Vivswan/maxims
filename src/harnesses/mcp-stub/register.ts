import { findNodeAtLocation, getNodeValue } from "jsonc-parser";
import type { Change } from "../../util/change.ts";
import { ExitCode, MaximsError } from "../../util/exit-codes.ts";
import { assertInsideRoot } from "../../util/fs.ts";
import {
  appendChild,
  assertParses,
  detectFormatting,
  parseObjectRoot,
  propertyNamed,
  readConfigText,
  removeChild,
  replaceValue,
} from "./jsonc-edit.ts";

export const MCP_SERVER_KEY = "maxims";
export const MCP_SERVER_ENTRY = { command: "npx", args: ["-y", "@vivswan/maxims", "mcp-serve"] };

// Where a harness keeps its MCP servers: the config file and the key path of the servers map
// inside it (`["mcpServers"]` for the Claude Code family). `root` is the scope directory the
// file must stay inside.
export type McpRegistry = {
  root: string;
  path: string;
  serversPath: string[];
};

export async function reconcileMcpServer(
  registry: McpRegistry,
  wanted: boolean,
): Promise<Change[]> {
  const path = assertInsideRoot(registry.root, registry.path);
  const text = await readConfigText(path);
  const next = editServers(text, path, registry.serversPath, wanted);
  if (next === null || next === text) return [];
  return [{ kind: "write", path, content: next }];
}

function editServers(
  text: string | null,
  path: string,
  serversPath: string[],
  wanted: boolean,
): string | null {
  const entryPath = [...serversPath, MCP_SERVER_KEY];
  if (text === null || text.trim() === "") {
    if (!wanted) return text;
    const nested = entryPath.reduceRight<unknown>(
      (inner, key) => ({ [key]: inner }),
      MCP_SERVER_ENTRY,
    );
    return `${JSON.stringify(nested, null, 2)}\n`;
  }
  const fmt = detectFormatting(text);
  const root = parseObjectRoot(text, path);
  // A missing level of the servers path is created with the rest nested inside it, so a file
  // without the key gains exactly one new property.
  let container = root;
  for (const [depth, key] of serversPath.entries()) {
    const child = findNodeAtLocation(container, [key]);
    if (child === undefined) {
      if (!wanted) return text;
      const rest = entryPath.slice(depth + 1);
      const value = rest.reduceRight<unknown>((inner, k) => ({ [k]: inner }), MCP_SERVER_ENTRY);
      return assertParses(appendChild(text, container, key, value, fmt), path);
    }
    if (child.type !== "object") {
      throw new MaximsError(
        ExitCode.DestinationWriteFailed,
        `${path}: ${serversPath.slice(0, depth + 1).join(".")} is not an object; left untouched`,
      );
    }
    container = child;
  }
  const property = propertyNamed(container, MCP_SERVER_KEY);
  const current = property?.children?.[1];
  if (!wanted) {
    if (property === undefined) return text;
    return assertParses(removeChild(text, container, property), path);
  }
  if (current === undefined) {
    return assertParses(appendChild(text, container, MCP_SERVER_KEY, MCP_SERVER_ENTRY, fmt), path);
  }
  if (JSON.stringify(getNodeValue(current)) === JSON.stringify(MCP_SERVER_ENTRY)) return text;
  return assertParses(replaceValue(text, current, MCP_SERVER_ENTRY, fmt), path);
}
