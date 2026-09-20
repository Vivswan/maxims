import { createInterface } from "node:readline";
import type { Readable, Writable } from "node:stream";
import { VERSION } from "../../version.ts";

// A harness that starts its MCP servers eagerly spawns this process before the agent reads a
// word, which is the whole point: the sync is under way by then. It exposes ZERO tools, so a prompt
// can reach nothing through it; `tools/list` answering an empty array is the property the test
// pins. The protocol is newline-delimited JSON-RPC over stdio, implemented here rather than with
// the MCP SDK because that package pulls in an HTTP stack (express, hono, cors, jose) the bundle
// would otherwise never carry.
export type McpStubOptions = {
  runSync: () => Promise<unknown>;
  input: Readable;
  output: Writable;
  stderr: Writable;
};

const SUPPORTED_PROTOCOL_VERSIONS = ["2025-11-25", "2025-06-18", "2025-03-26", "2024-11-05"];

type JsonRpcId = string | number | null;

type Response = { jsonrpc: "2.0"; id: JsonRpcId } & (
  | { result: unknown }
  | { error: { code: number; message: string } }
);

// Resolves when the harness closes stdin. The sync is started exactly once, before the first
// request is read, and never awaited by the protocol loop: a slow npx must not delay the
// `initialize` reply past the client's handshake timeout, and a failed sync, whether it rejects
// or throws before returning a promise, must not kill the server the harness is talking to.
export async function serveMcpStub(options: McpStubOptions): Promise<void> {
  const syncDone = Promise.resolve()
    .then(() => options.runSync())
    .then(
      () => undefined,
      (cause: unknown) => {
        const detail = cause instanceof Error ? cause.message : String(cause);
        options.stderr.write(`maxims mcp-serve: sync failed: ${detail}\n`);
      },
    );
  const lines = createInterface({ input: options.input, crlfDelay: Number.POSITIVE_INFINITY });
  for await (const line of lines) {
    if (line.trim() === "") continue;
    const response = respondToLine(line);
    if (response !== null) options.output.write(`${JSON.stringify(response)}\n`);
  }
  await syncDone;
}

function respondToLine(line: string): Response | Response[] | null {
  let message: unknown;
  try {
    message = JSON.parse(line);
  } catch {
    return { jsonrpc: "2.0", id: null, error: { code: -32700, message: "parse error" } };
  }
  if (Array.isArray(message)) {
    const responses = message.map(respondTo).filter((item): item is Response => item !== null);
    return responses.length === 0 ? null : responses;
  }
  return respondTo(message);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function respondTo(message: unknown): Response | null {
  if (!isRecord(message)) {
    return { jsonrpc: "2.0", id: null, error: { code: -32600, message: "invalid request" } };
  }
  const { id, method, params } = message;
  if (typeof id !== "string" && typeof id !== "number") return null;
  switch (method) {
    case "initialize":
      return { jsonrpc: "2.0", id, result: initializeResult(params) };
    case "ping":
      return { jsonrpc: "2.0", id, result: {} };
    case "tools/list":
      return { jsonrpc: "2.0", id, result: { tools: [] } };
    default:
      return { jsonrpc: "2.0", id, error: { code: -32601, message: "method not found" } };
  }
}

function initializeResult(params: unknown): Record<string, unknown> {
  const requested = isRecord(params) ? params.protocolVersion : undefined;
  const protocolVersion =
    typeof requested === "string" && SUPPORTED_PROTOCOL_VERSIONS.includes(requested)
      ? requested
      : SUPPORTED_PROTOCOL_VERSIONS[0];
  return {
    protocolVersion,
    capabilities: { tools: {} },
    serverInfo: { name: "maxims", version: VERSION },
    instructions: "maxims runs its sync when this server starts; it offers no tools.",
  };
}
