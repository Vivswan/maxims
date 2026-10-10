// Guards the MCP registration as a whole-file operation: the entry lands in the harness's config
// under the key that harness reads, leaves it byte-identical on removal, a missing file or key is
// created, and a file that exists but cannot be read or parsed is never replaced.
import { expect, test } from "bun:test";
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { amp } from "../../../src/harnesses/amp/spec.ts";
import { type HarnessDefinition, type Scope, scopeRoot } from "../../../src/harnesses/contract.ts";
import { devin } from "../../../src/harnesses/devin/spec.ts";
import { reconcileMcpServer } from "../../../src/harnesses/mcp-stub/register.ts";
import { pi } from "../../../src/harnesses/pi/spec.ts";
import { HARNESSES } from "../../../src/harnesses/registry.ts";
import { warp } from "../../../src/harnesses/warp/spec.ts";
import { zed } from "../../../src/harnesses/zed/spec.ts";
import { ExitCode } from "../../../src/util/exit-codes.ts";
import { assertInsideRoot } from "../../../src/util/fs.ts";
import { CHMOD_DENIES } from "../../shared/platform.ts";
import { srcPath } from "../../shared/src_path.ts";
import { withTempDir } from "../../shared/temp_dir.ts";

const fixture = readFileSync(srcPath("harnesses", "mcp-stub", "fixtures", "config.jsonc"), "utf8");
const ENTRY =
  '"maxims": {\n      "command": "npx",\n      "args": [\n        "-y",\n        "@vivswan/maxims",\n        "mcp-serve"\n      ]\n    }';

async function roundTrip(
  dir: string,
  initial: string,
): Promise<{ added: string; removed: string }> {
  const registry = { root: dir, path: join(dir, "mcp.json"), serversPath: ["mcpServers"] };
  writeFileSync(registry.path, initial);
  const added = await reconcileMcpServer(registry, true);
  const addedText = added[0]?.kind === "write" ? added[0].content : initial;
  writeFileSync(registry.path, addedText);
  expect(await reconcileMcpServer(registry, true)).toEqual([]);
  const removed = await reconcileMcpServer(registry, false);
  const removedText = removed[0]?.kind === "write" ? removed[0].content : addedText;
  writeFileSync(registry.path, removedText);
  expect(await reconcileMcpServer(registry, false)).toEqual([]);
  return { added: addedText, removed: removedText };
}

test("the entry is appended to the servers and its removal restores the fixture", async () => {
  await withTempDir(async (dir) => {
    const { added, removed } = await roundTrip(dir, fixture);
    expect(added).toBe(
      fixture.replace(
        '      "url": "https://mcp.example.com/docs"\n    }\n',
        `      "url": "https://mcp.example.com/docs"\n    },\n    ${ENTRY}\n`,
      ),
    );
    expect(removed).toBe(fixture);
  });
});

test("a stale entry is rewritten in place in the file's indent and an emptied map stays as {}", async () => {
  await withTempDir(async (dir) => {
    const stale =
      '{\n  "mcpServers": {\n    "maxims": { "command": "npx", "args": ["-y", "maxims@0.1.0", "mcp-serve"] }\n  },\n  "theme": "dark"\n}\n';
    const { added, removed } = await roundTrip(dir, stale);
    expect(added).toBe(`{\n  "mcpServers": {\n    ${ENTRY}\n  },\n  "theme": "dark"\n}\n`);
    expect(removed).toBe('{\n  "mcpServers": {},\n  "theme": "dark"\n}\n');
  });
});

// The separator is found by the tokenizer: a comma inside a comment beside our entry is the
// comment's, and searching for the character would cut the comment instead of the separator.
test("a comma inside a comment beside our entry is not taken for the separator", async () => {
  await withTempDir(async (dir) => {
    const registry = { root: dir, path: join(dir, "mcp.json"), serversPath: ["mcpServers"] };
    writeFileSync(registry.path, '{"mcpServers":{"maxims":{} /* keep, note */,"other":{}}}\n');
    expect(await reconcileMcpServer(registry, false)).toEqual([
      {
        kind: "write",
        path: assertInsideRoot(dir, registry.path),
        content: '{"mcpServers":{ /* keep, note */"other":{}}}\n',
      },
    ]);
  });
});

const creations: [string, string | null, string][] = [
  [
    "a missing file",
    null,
    '{\n  "mcp": {\n    "servers": {\n      "maxims": {\n        "command": "npx",\n        "args": [\n          "-y",\n          "@vivswan/maxims",\n          "mcp-serve"\n        ]\n      }\n    }\n  }\n}\n',
  ],
  [
    "a file holding only whitespace",
    "\n",
    '{\n  "mcp": {\n    "servers": {\n      "maxims": {\n        "command": "npx",\n        "args": [\n          "-y",\n          "@vivswan/maxims",\n          "mcp-serve"\n        ]\n      }\n    }\n  }\n}\n',
  ],
  [
    "a file missing the servers key",
    '{\n  "theme": "dark"\n}\n',
    '{\n  "theme": "dark",\n  "mcp": {\n    "servers": {\n      "maxims": {\n        "command": "npx",\n        "args": [\n          "-y",\n          "@vivswan/maxims",\n          "mcp-serve"\n        ]\n      }\n    }\n  }\n}\n',
  ],
];

test.each(creations)("%s gains exactly one nested entry", async (_, existing, expected) => {
  await withTempDir(async (dir) => {
    const registry = { root: dir, path: join(dir, "new.json"), serversPath: ["mcp", "servers"] };
    if (existing !== null) writeFileSync(registry.path, existing);
    expect(await reconcileMcpServer(registry, true)).toEqual([
      { kind: "write", path: assertInsideRoot(dir, registry.path), content: expected },
    ]);
    expect(await reconcileMcpServer(registry, false)).toEqual([]);
  });
});

// The reason names the guard that refused, so a later check cannot stand in for the named one.
const refusals: [string, (dir: string) => void, string][] = [
  [
    "a servers path that is not an object",
    (dir) => writeFileSync(join(dir, "mcp.json"), '{ "mcp": { "servers": [] } }\n'),
    "mcp.servers is not an object; left untouched",
  ],
  [
    "unparsable JSON",
    (dir) => writeFileSync(join(dir, "mcp.json"), '{ "mcp": {\n'),
    "it is not valid JSON",
  ],
  [
    "a directory where the file should be",
    (dir) => mkdirSync(join(dir, "mcp.json")),
    "cannot read",
  ],
];

async function expectRefused(
  dir: string,
  arrange: (dir: string) => void,
  reason: string,
): Promise<void> {
  arrange(dir);
  const registry = { root: dir, path: join(dir, "mcp.json"), serversPath: ["mcp", "servers"] };
  await expect(reconcileMcpServer(registry, true)).rejects.toMatchObject({
    name: "MaximsError",
    code: ExitCode.DestinationWriteFailed,
    message: expect.stringContaining(reason),
  });
}

test.each(refusals)("%s is refused with exit 4 and no plan", async (_, arrange, reason) => {
  await withTempDir((dir) => expectRefused(dir, arrange, reason));
});

test.skipIf(!CHMOD_DENIES)(
  "an existing file that cannot be read is refused with exit 4 and no plan",
  async () => {
    await withTempDir((dir) =>
      expectRefused(
        dir,
        (root) => {
          writeFileSync(join(root, "mcp.json"), "{}\n");
          chmodSync(join(root, "mcp.json"), 0o000);
        },
        "cannot read",
      ),
    );
  },
);

// Each harness starts servers from a key of its own (Zed's `context_servers`, Amp's dotted
// `amp.mcpServers`), so a declaration naming another key plans a file the harness parses and
// ignores. The object is spelled per row: the key the file gains is pinned, not the declaration.
const SERVER = { command: "npx", args: ["-y", "@vivswan/maxims", "mcp-serve"] };
const declared: { def: HarnessDefinition; written: Partial<Record<Scope, unknown>> }[] = [
  {
    def: amp,
    written: {
      project: { "amp.mcpServers": { maxims: SERVER } },
      global: { "amp.mcpServers": { maxims: SERVER } },
    },
  },
  {
    def: devin,
    written: {
      project: { mcpServers: { maxims: SERVER } },
      global: { mcpServers: { maxims: SERVER } },
    },
  },
  {
    def: pi,
    written: {
      project: { mcpServers: { maxims: SERVER } },
      global: { mcpServers: { maxims: SERVER } },
    },
  },
  { def: warp, written: { global: { mcpServers: { maxims: SERVER } } } },
  {
    def: zed,
    written: {
      project: { context_servers: { maxims: SERVER } },
      global: { context_servers: { maxims: SERVER } },
    },
  },
];

test("every harness that declares an MCP registry has a row in the table", () => {
  expect(
    HARNESSES.filter((def) => def.mcp !== undefined)
      .map((def) => def.id)
      .sort(),
  ).toEqual(declared.map(({ def }) => def.id).sort());
});

test.each(declared)(
  "$def.id: an empty config in each scope that has one gains the entry under the key the harness reads",
  async ({ def, written }) => {
    if (def.mcp === undefined) throw new Error(`${def.id} declares no MCP registry`);
    const mcp = def.mcp;
    await withTempDir(async (dir) => {
      const ctx = {
        home: join(dir, "home"),
        projectRoot: join(dir, "project"),
        cwd: join(dir, "project"),
        env: {},
      };
      const gained: Partial<Record<Scope, unknown>> = {};
      for (const scope of ["project", "global"] as const) {
        const file = mcp.path(scope, ctx);
        if (file === null) continue;
        mkdirSync(dirname(file), { recursive: true });
        writeFileSync(file, "{}\n");
        const registry = {
          root: scopeRoot(def, scope, ctx),
          path: file,
          serversPath: mcp.serversPath,
        };
        const changes = await reconcileMcpServer(registry, true);
        const [change] = changes;
        gained[scope] =
          change?.kind === "write" && changes.length === 1 ? JSON.parse(change.content) : changes;
      }
      expect(gained).toEqual(written);
    });
  },
);
