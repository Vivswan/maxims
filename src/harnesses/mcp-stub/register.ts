import { findNodeAtLocation, getNodeValue } from "jsonc-parser";
import type { Change } from "../../util/change.ts";
import { ExitCode, MaximsError } from "../../util/exit-codes.ts";
import { assertInsideRoot } from "../../util/fs.ts";
import {
  appendChild,
  assertParses,
  readConfigText,
  removeChild,
  replaceValue,
} from "../../util/jsonc.ts";
import { PACKAGE_ARGV } from "../../util/package.ts";

export const MCP_SERVER_KEY = "maxims";
const [command, ...packageArgs] = PACKAGE_ARGV;
export const MCP_SERVER_ENTRY = { command, args: [...packageArgs, "mcp-serve"] };

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
  assertParses(next, path);
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
  const root = assertParses(text, path);
  // A missing level of the servers path is created with the rest nested inside it, so a file
  // without the key gains exactly one new property.
  let container = root;
  for (const [depth, key] of serversPath.entries()) {
    const child = findNodeAtLocation(container, [key]);
    if (child === undefined) {
      if (!wanted) return text;
      const rest = entryPath.slice(depth + 1);
      const value = rest.reduceRight<unknown>((inner, k) => ({ [k]: inner }), MCP_SERVER_ENTRY);
      return appendChild(text, container, key, value);
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
    return property === undefined ? text : removeChild(text, container, property);
  }
  if (current === undefined) return appendChild(text, container, MCP_SERVER_KEY, MCP_SERVER_ENTRY);
  if (JSON.stringify(getNodeValue(current)) === JSON.stringify(MCP_SERVER_ENTRY)) return text;
  return replaceValue(text, current, MCP_SERVER_ENTRY);
}
