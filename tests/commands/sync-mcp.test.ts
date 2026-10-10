// What would drift silently: a sync that leaves a harness with no hook shape and an MCP registry
// without the stub server entry its session start runs, a second sync that rewrites the servers
// file it already settled, a dry run that writes it, or a remove that leaves the entry behind once
// the last source at the scope is gone.
import { expect, test } from "bun:test";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { runRemove } from "../../src/commands/remove.ts";
import { runSync } from "../../src/commands/sync.ts";
import type { RemoveOptions } from "../../src/engine/types.ts";
import {
  entryFor,
  FIXTURE_MCP_FILE,
  fakeIo,
  localFrom,
  mcpHarness,
  stateWith,
  writeSource,
  writeState,
} from "../engine/fakes.ts";
import { TWO_MEMORIES, world } from "../engine/world.ts";
import { SYNC } from "../shared/sync_support.ts";

const REMOVE: RemoveOptions = {
  quiet: false,
  dryRun: false,
  json: false,
  targets: [],
  all: false,
  confirmed: true,
};

const SEEDED =
  '{\n  "mcpServers": {\n    "docs": { "type": "http", "url": "https://mcp.example.com/docs" }\n  }\n}\n';
const REGISTERED =
  '{\n  "mcpServers": {\n    "docs": { "type": "http", "url": "https://mcp.example.com/docs" },\n' +
  '    "maxims": {\n      "command": "npx",\n      "args": [\n        "-y",\n        "@vivswan/maxims",\n        "mcp-serve"\n      ]\n    }\n  }\n}\n';

test("sync registers the stub where the hook is wanted, settles on the second run, and remove takes it back", async () => {
  await world(async ({ home, dir, userHome }) => {
    const source = writeSource(join(dir, "src"), TWO_MEMORIES);
    const servers = join(userHome, FIXTURE_MCP_FILE);
    writeFileSync(servers, SEEDED);
    const entry = entryFor(localFrom(source), { harnesses: ["zed"] });
    writeState(home, stateWith({ [source]: entry }, { global: ["zed"] }));
    const io = fakeIo({ home, userHome, cwd: dir, harnesses: [mcpHarness] });

    const preview = await runSync({ ...SYNC, dryRun: true }, io);
    expect<unknown[]>(preview.plan.changes.filter((change) => change.path === servers)).toEqual([
      { kind: "write", path: servers, content: REGISTERED },
    ]);
    expect(readFileSync(servers, "utf8")).toBe(SEEDED);

    const first = await runSync(SYNC, io);
    expect(readFileSync(servers, "utf8")).toBe(REGISTERED);
    expect(first.notices).toContain(`maxims: registered the maxims MCP server in ${servers}`);

    const second = await runSync(SYNC, io);
    expect(second.plan.changes.filter((change) => change.path === servers)).toEqual([]);
    expect(readFileSync(servers, "utf8")).toBe(REGISTERED);

    const removed = await runRemove({ ...REMOVE, targets: [source] }, io);
    expect(readFileSync(servers, "utf8")).toBe(SEEDED);
    expect(removed.notices).toContain(`maxims: removed the maxims MCP server from ${servers}`);
  });
});

test("without --add-hook at the scope the servers file is left alone", async () => {
  await world(async ({ home, dir, userHome }) => {
    const source = writeSource(join(dir, "src"), TWO_MEMORIES);
    const servers = join(userHome, FIXTURE_MCP_FILE);
    writeFileSync(servers, SEEDED);
    writeState(home, stateWith({ [source]: entryFor(localFrom(source), { harnesses: ["zed"] }) }));
    await runSync(SYNC, fakeIo({ home, userHome, cwd: dir, harnesses: [mcpHarness] }));
    expect(readFileSync(servers, "utf8")).toBe(SEEDED);
  });
});
