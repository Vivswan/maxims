// Guards the property that keeps the stub a trigger and not an API: it exposes zero tools, runs
// the injected sync exactly once per process however the client talks to it, and keeps
// answering when that sync fails in either of the two ways a function can.
import { expect, test } from "bun:test";
import { PassThrough } from "node:stream";
import { VERSION } from "../../version.ts";
import { serveMcpStub } from "./server.ts";

type Served = { responses: unknown[]; stderr: string };

async function run(runSync: () => Promise<unknown>, lines: string[]): Promise<Served> {
  const input = new PassThrough();
  const output = new PassThrough();
  const stderr = new PassThrough();
  const out: string[] = [];
  const err: string[] = [];
  output.on("data", (chunk: Buffer) => out.push(chunk.toString("utf8")));
  stderr.on("data", (chunk: Buffer) => err.push(chunk.toString("utf8")));
  const served = serveMcpStub({ runSync, input, output, stderr });
  for (const line of lines) input.write(`${line}\n`);
  input.end();
  await served;
  const responses = out
    .join("")
    .split("\n")
    .filter((line) => line !== "")
    .map((line) => JSON.parse(line));
  return { responses, stderr: err.join("") };
}

const initialized = (protocolVersion: string) => ({
  protocolVersion,
  capabilities: { tools: {} },
  serverInfo: { name: "maxims", version: VERSION },
  instructions: "maxims runs its sync when this server starts; it offers no tools.",
});

const session = [
  {
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "t" } },
  },
  { jsonrpc: "2.0", method: "notifications/initialized" },
  { jsonrpc: "2.0", id: 2, method: "tools/list" },
  { jsonrpc: "2.0", id: 3, method: "ping" },
  { jsonrpc: "2.0", id: 4, method: "tools/call", params: { name: "anything" } },
  { jsonrpc: "2.0", id: 5, method: "initialize", params: { protocolVersion: "1999-01-01" } },
];

const sessionResponses = [
  { jsonrpc: "2.0", id: 1, result: initialized("2025-06-18") },
  { jsonrpc: "2.0", id: 2, result: { tools: [] } },
  { jsonrpc: "2.0", id: 3, result: {} },
  { jsonrpc: "2.0", id: 4, error: { code: -32601, message: "method not found" } },
  { jsonrpc: "2.0", id: 5, result: initialized("2025-11-25") },
];

test("a full session lists zero tools, rejects every other method, and syncs once", async () => {
  let syncs = 0;
  const served = await run(
    async () => {
      syncs += 1;
    },
    session.map((message) => JSON.stringify(message)),
  );
  expect(served.responses).toEqual(sessionResponses);
  expect(syncs).toBe(1);
  expect(served.stderr).toBe("");
});

const failures: [string, () => Promise<unknown>][] = [
  ["rejects", () => Promise.reject(new Error("offline"))],
  [
    "throws before returning a promise",
    () => {
      throw new Error("offline");
    },
  ],
];

test.each(failures)(
  "a sync that %s is reported on stderr and the protocol keeps answering malformed input",
  async (_, runSync) => {
    const served = await run(runSync, [
      "not json",
      "",
      JSON.stringify([
        { jsonrpc: "2.0", id: "a", method: "ping" },
        { jsonrpc: "2.0", method: "notifications/cancelled" },
      ]),
      "42",
    ]);
    expect(served.responses).toEqual([
      { jsonrpc: "2.0", id: null, error: { code: -32700, message: "parse error" } },
      [{ jsonrpc: "2.0", id: "a", result: {} }],
      { jsonrpc: "2.0", id: null, error: { code: -32600, message: "invalid request" } },
    ]);
    expect(served.stderr).toBe("maxims mcp-serve: sync failed: offline\n");
  },
);
