// Guards the MCP registration as a whole-file operation: the entry lands in the harness's config
// and leaves it byte-identical on removal, a missing file or key is created, and a file that
// exists but cannot be read or parsed is never replaced.
import { expect, test } from "bun:test";
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { withTempDir } from "../../../tests/shared/temp_dir.ts";
import { ExitCode, MaximsError } from "../../util/exit-codes.ts";
import { assertInsideRoot } from "../../util/fs.ts";
import { reconcileMcpServer } from "./register.ts";

const fixture = readFileSync(join(import.meta.dir, "fixtures", "config.jsonc"), "utf8");
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

test("a stale entry is rewritten in place and an emptied map stays as {}", async () => {
  await withTempDir(async (dir) => {
    const stale =
      '{\n  "mcpServers": {\n    "maxims": { "command": "npx", "args": ["-y", "maxims@0.1.0", "mcp-serve"] }\n  },\n  "theme": "dark"\n}\n';
    const { added, removed } = await roundTrip(dir, stale);
    expect(added).toBe(
      '{\n  "mcpServers": {\n    "maxims": {"command":"npx","args":["-y","@vivswan/maxims","mcp-serve"]}\n  },\n  "theme": "dark"\n}\n',
    );
    expect(removed).toBe('{\n  "mcpServers": {},\n  "theme": "dark"\n}\n');
  });
});

const creations: [string, string | null, string][] = [
  [
    "a missing file",
    null,
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

const refusals: [string, (dir: string) => void][] = [
  [
    "a servers path that is not an object",
    (dir) => writeFileSync(join(dir, "mcp.json"), '{ "mcp": { "servers": [] } }\n'),
  ],
  ["unparsable JSON", (dir) => writeFileSync(join(dir, "mcp.json"), '{ "mcp": {\n')],
  [
    "an existing file that cannot be read",
    (dir) => {
      writeFileSync(join(dir, "mcp.json"), "{}\n");
      chmodSync(join(dir, "mcp.json"), 0o000);
    },
  ],
  ["a directory where the file should be", (dir) => mkdirSync(join(dir, "mcp.json"))],
];

test.each(refusals)("%s is refused with exit 4 and no plan", async (_, arrange) => {
  await withTempDir(async (dir) => {
    arrange(dir);
    const registry = { root: dir, path: join(dir, "mcp.json"), serversPath: ["mcp", "servers"] };
    let caught: unknown;
    try {
      await reconcileMcpServer(registry, true);
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(MaximsError);
    expect(caught).toMatchObject({ code: ExitCode.DestinationWriteFailed });
  });
});
