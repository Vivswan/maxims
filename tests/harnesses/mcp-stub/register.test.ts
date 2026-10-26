// Guards the MCP registration as a whole-file operation: the entry lands in the harness's config
// under the key that harness reads, leaves it byte-identical on removal, a missing file or key is
// created, and a file that exists but cannot be read or parsed is never replaced.
import { expect, test } from "bun:test";
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { amp } from "../../../src/harnesses/amp/spec.ts";
import type { HarnessDefinition, Scope } from "../../../src/harnesses/contract.ts";
import { devin } from "../../../src/harnesses/devin/spec.ts";
import {
  type McpRegistration,
  mcpRegistrationAt,
  rewriteServers,
} from "../../../src/harnesses/mcp-stub/register.ts";
import { pi } from "../../../src/harnesses/pi/spec.ts";
import { HARNESSES } from "../../../src/harnesses/registry.ts";
import { warp } from "../../../src/harnesses/warp/spec.ts";
import { zed } from "../../../src/harnesses/zed/spec.ts";
import { ExitCode } from "../../../src/util/exit-codes.ts";
import { assertInsideRoot } from "../../../src/util/fs.ts";
import { JSONC, readConfigText } from "../../../src/util/jsonc.ts";
import { asyncOutcome } from "../../shared/outcome.ts";
import { CHMOD_DENIES } from "../../shared/platform.ts";
import { srcPath } from "../../shared/src_path.ts";
import { withTempDir } from "../../shared/temp_dir.ts";

const fixture = readFileSync(srcPath("harnesses", "mcp-stub", "fixtures", "config.jsonc"), "utf8");
const ENTRY =
  '"maxims": {\n      "command": "npx",\n      "args": [\n        "-y",\n        "@vivswan/maxims",\n        "mcp-serve"\n      ]\n    }';

function registration(dir: string, file: string, serversPath: string[]): McpRegistration {
  return { root: dir, path: assertInsideRoot(dir, join(dir, file)), serversPath, reader: JSONC };
}

async function plan(registration: McpRegistration, wanted: boolean): Promise<string | null> {
  const currentText = await readConfigText(registration.path);
  return rewriteServers({ registration, wanted, currentText })?.text ?? null;
}

async function roundTrip(
  dir: string,
  initial: string,
): Promise<{ added: string; removed: string }> {
  const registry = registration(dir, "mcp.json", ["mcpServers"]);
  writeFileSync(registry.path, initial);
  const addedText = (await plan(registry, true)) ?? initial;
  writeFileSync(registry.path, addedText);
  expect(await plan(registry, true)).toBeNull();
  const removedText = (await plan(registry, false)) ?? addedText;
  writeFileSync(registry.path, removedText);
  expect(await plan(registry, false)).toBeNull();
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

// jsonc-parser hands back null-prototype objects in file order; an entry a user spelled with the
// keys the other way round is the same server and is left as written.
test("an entry spelled in another key order is current", async () => {
  await withTempDir(async (dir) => {
    const registry = registration(dir, "mcp.json", ["mcpServers"]);
    writeFileSync(
      registry.path,
      '{"mcpServers":{"maxims":{"args":["-y","@vivswan/maxims","mcp-serve"],"command":"npx"}}}\n',
    );
    expect(await plan(registry, true)).toBeNull();
  });
});

// Pi strips a UTF-8 BOM before JSON.parse where a bare JSON.parse rejects one, so a file an editor
// saved with a BOM is written back without it even when our entry is current, and left as it is
// when nothing of ours is in it to remove.
test("a BOM ahead of a current entry earns the write that drops it; one ahead of nothing of ours is left", async () => {
  await withTempDir(async (dir) => {
    const registry = registration(dir, "mcp.json", ["mcpServers"]);
    const current = `{\n  "mcpServers": {\n    ${ENTRY}\n  }\n}\n`;
    writeFileSync(registry.path, `\uFEFF${current}`);
    const currentText = await readConfigText(registry.path);
    expect(rewriteServers({ registration: registry, wanted: true, currentText })).toEqual({
      text: current,
      notice: `dropped the UTF-8 BOM from ${registry.path}`,
    });
    writeFileSync(registry.path, '\uFEFF{\n  "mcpServers": {}\n}\n');
    expect(await plan(registry, false)).toBeNull();
  });
});

// The separator is found by the tokenizer: a comma inside a comment beside our entry is the
// comment's, and searching for the character would cut the comment instead of the separator.
test("a comma inside a comment beside our entry is not taken for the separator", async () => {
  await withTempDir(async (dir) => {
    const registry = registration(dir, "mcp.json", ["mcpServers"]);
    writeFileSync(registry.path, '{"mcpServers":{"maxims":{} /* keep, note */,"other":{}}}\n');
    expect(await plan(registry, false)).toBe('{"mcpServers":{ /* keep, note */"other":{}}}\n');
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
  [
    "a file with a UTF-8 BOM ahead of the JSON",
    '\uFEFF{\n  "theme": "dark"\n}\n',
    '{\n  "theme": "dark",\n  "mcp": {\n    "servers": {\n      "maxims": {\n        "command": "npx",\n        "args": [\n          "-y",\n          "@vivswan/maxims",\n          "mcp-serve"\n        ]\n      }\n    }\n  }\n}\n',
  ],
];

test.each(creations)("%s gains exactly one nested entry", async (_, existing, expected) => {
  await withTempDir(async (dir) => {
    const registry = registration(dir, "new.json", ["mcp", "servers"]);
    if (existing !== null) writeFileSync(registry.path, existing);
    expect(await plan(registry, true)).toBe(expected);
    expect(await plan(registry, false)).toBeNull();
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
  await expect(plan(registration(dir, "mcp.json", ["mcp", "servers"]), true)).rejects.toMatchObject(
    {
      name: "MaximsError",
      code: ExitCode.DestinationWriteFailed,
      message: expect.stringContaining(reason),
    },
  );
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

const SERVER = { command: "npx", args: ["-y", "@vivswan/maxims", "mcp-serve"] };
const declared: {
  def: HarnessDefinition;
  written: Partial<Record<Scope, unknown>>;
  comments: "accepted" | "refused" | "unverified";
}[] = [
  {
    def: amp,
    written: {
      project: { "amp.mcpServers": { maxims: SERVER } },
      global: { "amp.mcpServers": { maxims: SERVER } },
    },
    comments: "accepted",
  },
  {
    def: devin,
    written: {
      project: { mcpServers: { maxims: SERVER } },
      global: { mcpServers: { maxims: SERVER } },
    },
    comments: "accepted",
  },
  {
    def: pi,
    written: {
      project: { mcpServers: { maxims: SERVER } },
      global: { mcpServers: { maxims: SERVER } },
    },
    comments: "refused",
  },
  { def: warp, written: { global: { mcpServers: { maxims: SERVER } } }, comments: "unverified" },
  {
    def: zed,
    written: {
      project: { context_servers: { maxims: SERVER } },
      global: { context_servers: { maxims: SERVER } },
    },
    comments: "accepted",
  },
];

// The `declared` table: each harness starts servers from a key of its own, so a declaration naming
// another key plans a file the harness parses and ignores. The object is spelled per row: the key
// the file gains is pinned, not the declaration, and `comments` is the vendor's own parser.
//
//   Zed    -> `context_servers`; documents comments
//   Amp    -> dotted `amp.mcpServers`; documents comments
//   Devin  -> documents comments
//   Pi     -> loads the file with `JSON.parse`, so a comment is refused by name rather than edited into a file Pi would then drop whole
//   Warp   -> documents neither, so its `jsonc` is maxims's tolerant default, not a vendor fact, and the dialect row leaves it out
test("every harness that declares an MCP registry has a row in the table", () => {
  expect(
    HARNESSES.filter((def) => def.mcp !== undefined)
      .map((def) => def.id)
      .sort(),
  ).toEqual(declared.map(({ def }) => def.id).sort());
});

function perScope<T>(def: HarnessDefinition, value: T): Partial<Record<Scope, T>> {
  const ctx = { home: "/home/user", projectRoot: "/home/user/p", cwd: "/home/user/p", env: {} };
  const scopes = (["project", "global"] as const).filter((scope) => def.mcp?.path(scope, ctx));
  return Object.fromEntries(scopes.map((scope) => [scope, value]));
}

test.each(declared)(
  "$def.id: an empty config in each scope that has one gains the entry under the key the harness reads",
  async ({ def, written }) => {
    await withTempDir(async (dir) => {
      const ctx = {
        home: join(dir, "home"),
        projectRoot: join(dir, "project"),
        cwd: join(dir, "project"),
        env: {},
      };
      const gained: Partial<Record<Scope, unknown>> = {};
      for (const scope of ["project", "global"] as const) {
        const registry = mcpRegistrationAt(def, scope, ctx);
        if (registry === null) continue;
        mkdirSync(dirname(registry.path), { recursive: true });
        writeFileSync(registry.path, "{}\n");
        const text = await plan(registry, true);
        gained[scope] = text === null ? null : JSON.parse(text);
      }
      expect(gained).toEqual(written);
    });
  },
);

// The comment sits at line 3, column 5 of the file as written here; the refusal names it so the
// user can take it out, and names the vendor so they know who would skip the file.
test.each(declared.filter((row) => row.comments !== "unverified"))(
  "$def.id: a comment in the servers map is $comments, as the vendor's parser takes it",
  async ({ def, comments }) => {
    await withTempDir(async (dir) => {
      const ctx = {
        home: join(dir, "home"),
        projectRoot: join(dir, "project"),
        cwd: join(dir, "project"),
        env: {},
      };
      const [key] = def.mcp?.serversPath ?? [];
      const seen: Partial<Record<Scope, unknown>> = {};
      for (const scope of ["project", "global"] as const) {
        const registry = mcpRegistrationAt(def, scope, ctx);
        if (registry === null) continue;
        mkdirSync(dirname(registry.path), { recursive: true });
        writeFileSync(registry.path, `{\n  ${JSON.stringify(key)}: {\n    // keep\n  }\n}\n`);
        const verdict = await asyncOutcome(() => plan(registry, true));
        seen[scope] =
          verdict.kind === "threw"
            ? { refused: verdict.error instanceof Error ? verdict.error.message : verdict.error }
            : {
                keepsComment: verdict.value?.includes("// keep") ?? false,
                registers: verdict.value?.includes('"mcp-serve"') ?? false,
              };
      }
      const expected =
        comments === "refused"
          ? {
              refused: expect.stringMatching(
                new RegExp(
                  `^cannot edit .*: a comment at line 3, column 5; ${RegExp.escape(def.displayName)} reads strict JSON$`,
                ),
              ),
            }
          : { keepsComment: true, registers: true };
      expect(seen).toEqual(perScope(def, expected));
    });
  },
);
