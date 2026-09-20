// Guards the two OpenCode artifacts that would drift silently: the plugin file must render the
// same bytes on every sync (a differing render would rewrite it every session start), and the
// `instructions` edit must leave a hand-formatted opencode.json byte-identical outside our entry.
import { expect, test } from "bun:test";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { withTempDir } from "../../../tests/shared/temp_dir.ts";
import { ExitCode, MaximsError } from "../../util/exit-codes.ts";
import { hookSpecFor } from "../contract.ts";
import { opencode } from "./index.ts";
import { INSTRUCTIONS_GLOB, reconcileInstructions } from "./instructions.ts";

const fixture = readFileSync(join(import.meta.dir, "fixtures", "config.jsonc"), "utf8");
const ctx = { home: "/home/user", projectRoot: "/home/user/project", env: {} };

test("the plugin renders byte-identically twice and calls the hook command on session.created", () => {
  if (opencode.hook.kind !== "file") throw new Error("OpenCode writes a plugin file");
  const first = opencode.hook.render(hookSpecFor(opencode));
  expect(opencode.hook.render(hookSpecFor(opencode))).toBe(first);
  expect(first).toContain(
    'if (event.type === "session.created") await $`npx -y maxims sync --quiet`.nothrow().quiet();',
  );
  expect(opencode.hook.path("project", ctx)).toBe("/home/user/project/.opencode/plugins/maxims.ts");
  expect(opencode.hook.path("global", ctx)).toBe("/home/user/.config/opencode/plugins/maxims.ts");
  expect(opencode.hook.path("global", { ...ctx, env: { XDG_CONFIG_HOME: "/home/user/xdg" } })).toBe(
    "/home/user/xdg/opencode/plugins/maxims.ts",
  );
});

test("adding then removing the instructions entry returns a hand-formatted opencode.json", async () => {
  await withTempDir(async (dir) => {
    const path = join(dir, "opencode.json");
    writeFileSync(path, fixture);

    const added = await reconcileInstructions(dir, true);
    expect(added).toEqual([
      {
        kind: "write",
        path,
        content: fixture.replace(
          '"docs/guidelines.md"]',
          `"docs/guidelines.md", "${INSTRUCTIONS_GLOB}"]`,
        ),
      },
    ]);
    writeFileSync(path, added[0]?.kind === "write" ? added[0].content : "");
    expect(await reconcileInstructions(dir, true)).toEqual([]);

    const removed = await reconcileInstructions(dir, false);
    expect(removed).toEqual([{ kind: "write", path, content: fixture }]);
    writeFileSync(path, fixture);
    expect(await reconcileInstructions(dir, false)).toEqual([]);
  });
});

const creations: [string, string | null, string][] = [
  ["a missing file", null, `{\n  "instructions": [\n    "${INSTRUCTIONS_GLOB}"\n  ]\n}\n`],
  [
    "a file without the key, keeping its tab indentation",
    '{\n\t"model": "x"\n}\n',
    `{\n\t"model": "x",\n\t"instructions": [\n\t\t"${INSTRUCTIONS_GLOB}"\n\t]\n}\n`,
  ],
  [
    "a file with a trailing comma, which OpenCode accepts",
    '{\n  "instructions": [\n    "a.md",\n  ]\n}\n',
    `{\n  "instructions": [\n    "a.md",\n    "${INSTRUCTIONS_GLOB}",\n  ]\n}\n`,
  ],
  [
    "an opencode.jsonc, which wins over a missing opencode.json",
    "// comment\n{}\n",
    `// comment\n{\n  "instructions": [\n    "${INSTRUCTIONS_GLOB}"\n  ]\n}\n`,
  ],
];

test.each(creations)("writes the entry into %s", async (label, existing, expected) => {
  await withTempDir(async (dir) => {
    const name = label.startsWith("an opencode.jsonc") ? "opencode.jsonc" : "opencode.json";
    if (existing !== null) writeFileSync(join(dir, name), existing);
    expect(await reconcileInstructions(dir, true)).toEqual([
      { kind: "write", path: join(dir, name), content: expected },
    ]);
  });
});

test("both config names count: no second entry is added and removal clears every copy", async () => {
  await withTempDir(async (dir) => {
    const json = join(dir, "opencode.json");
    const jsonc = join(dir, "opencode.jsonc");
    writeFileSync(
      json,
      `{ "instructions": ["${INSTRUCTIONS_GLOB}", "user.md", "${INSTRUCTIONS_GLOB}"] }\n`,
    );
    writeFileSync(jsonc, '{ "model": "x" }\n');
    expect(await reconcileInstructions(dir, true)).toEqual([]);
    expect(await reconcileInstructions(dir, false)).toEqual([
      { kind: "write", path: json, content: '{ "instructions": ["user.md"] }\n' },
    ]);

    writeFileSync(jsonc, `{ "instructions": ["${INSTRUCTIONS_GLOB}"] }\n`);
    writeFileSync(json, "{");
    let caught: unknown;
    try {
      await reconcileInstructions(dir, true);
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(MaximsError);
    expect(caught).toMatchObject({ code: ExitCode.DestinationWriteFailed });
  });
});

const refusals: [string, string][] = [
  ["unparseable JSON", '{\n  "instructions": [\n'],
  ["an instructions value that is not an array", '{\n  "instructions": "AGENTS.md"\n}\n'],
];

test.each(refusals)("refuses to rewrite %s (exit 4)", async (_, text) => {
  await withTempDir(async (dir) => {
    writeFileSync(join(dir, "opencode.json"), text);
    let caught: unknown;
    try {
      await reconcileInstructions(dir, true);
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(MaximsError);
    expect(caught).toMatchObject({ code: ExitCode.DestinationWriteFailed });
    expect(readFileSync(join(dir, "opencode.json"), "utf8")).toBe(text);
  });
});
