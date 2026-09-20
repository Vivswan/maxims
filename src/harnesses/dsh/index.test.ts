// Guards the dsh bridge pair and budget: a hand-formatted cordis.patch.yml must come back
// byte-identical once our row leaves (dsh's own guide warns the file carries unrelated user
// patches), a row the user merged into a shared insert operation must leave alone, and the
// budget must count bytes below dsh's 64 KiB with room for its framing, since a multi-byte block
// that passes a character count would load truncated.
import { expect, test } from "bun:test";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { withTempDir } from "../../../tests/shared/temp_dir.ts";
import { applyChanges } from "../../util/change.ts";
import { ExitCode, MaximsError } from "../../util/exit-codes.ts";
import { assertInsideRoot } from "../../util/fs.ts";
import { hookSpecFor } from "../contract.ts";
import { BRIDGE_ROW_ID, reconcileBridge } from "./bridge.ts";
import { checkBudget, DSH_FILE_BUDGET, dsh } from "./index.ts";

const fixture = readFileSync(join(import.meta.dir, "fixtures", "config.yml"), "utf8");
const spec = hookSpecFor(dsh);
const rooted = (root: string, ...parts: string[]) => assertInsideRoot(root, join(root, ...parts));

function contextFor(home: string) {
  return { home, projectRoot: join(home, "project"), env: { DSH_HOME: join(home, "dsh-home") } };
}

function ourRow(dshHome: string, indent = ""): string {
  return [
    `- id: ${BRIDGE_ROW_ID}`,
    '  name: "@deepseek-ai/dsh-hooks-claude-code"',
    "  config:",
    `    configPath: ${dshHome}/maxims-hooks.json`,
    "",
  ]
    .map((line) => (line === "" ? line : `${indent}${line}`))
    .join("\n");
}

function ourOperation(dshHome: string): string {
  return `- insert:\n${ourRow(dshHome, "    ")}`;
}

async function apply(home: string, wanted: boolean): Promise<void> {
  const changes = await reconcileBridge("global", contextFor(home), spec, wanted);
  await applyChanges({ changes, notices: [] }, { dryRun: false });
}

test("mounting then unmounting the bridge leaves the patch file byte-identical", async () => {
  await withTempDir(async (home) => {
    const dshHome = join(home, "dsh-home");
    mkdirSync(dshHome);
    writeFileSync(join(dshHome, "cordis.patch.yml"), fixture);

    await apply(home, true);
    expect(readFileSync(join(dshHome, "cordis.patch.yml"), "utf8")).toBe(
      `${fixture}${ourOperation(dshHome)}`,
    );
    expect(JSON.parse(readFileSync(join(dshHome, "maxims-hooks.json"), "utf8"))).toEqual({
      hooks: {
        SessionStart: [
          {
            hooks: [
              { type: "command", command: "npx -y @vivswan/maxims sync --quiet", timeout: 20 },
            ],
          },
        ],
      },
    });
    expect(await reconcileBridge("global", contextFor(home), spec, true)).toEqual([
      {
        kind: "write",
        path: rooted(dshHome, "maxims-hooks.json"),
        content: readFileSync(join(dshHome, "maxims-hooks.json"), "utf8"),
      },
    ]);

    await apply(home, false);
    expect(readFileSync(join(dshHome, "cordis.patch.yml"), "utf8")).toBe(fixture);
    expect(() => readFileSync(join(dshHome, "maxims-hooks.json"))).toThrow();
  });
});

const [head, tail] = fixture.split("# Shrink");
const staleRow = `- id: ${BRIDGE_ROW_ID}\n  name: x\n  config: { configPath: ./old/hooks.json, projectDir: . }\n`;

// [label, patch file before, after mounting, after unmounting]
const layouts: [string, string, (dshHome: string) => string, string][] = [
  [
    "a stale row alone in its operation, mid-file",
    `${head}- insert:\n${staleRow.replace(/^/gm, "    ").replace(/^ {4}$/gm, "")}# Shrink${tail}`,
    (dshHome) => `${head}${ourOperation(dshHome)}# Shrink${tail}`,
    `${head}# Shrink${tail}`,
  ],
  [
    "the disabled layer `[]`, which our operation replaces and an unmount restores",
    "[] # disabled\n",
    (dshHome) => ourOperation(dshHome),
    "[]\n",
  ],
  [
    "a file that is nothing but our operation, which unmounting turns into the disabled layer",
    `- insert:\n${staleRow.replace(/^/gm, "    ").replace(/^ {4}$/gm, "")}`,
    (dshHome) => ourOperation(dshHome),
    "[]\n",
  ],
  [
    "a stale row with a trailing comment, followed by a flow-style sibling that keeps its indent",
    `${head}- insert:\n${staleRow.replace(/^/gm, "    ").replace(/^ {4}$/gm, "")}      # note\n    - { id: other, name: other-plugin }\n# Shrink${tail}`,
    (dshHome) =>
      `${head}- insert:\n${ourRow(dshHome, "    ")}    - { id: other, name: other-plugin }\n# Shrink${tail}`,
    `${head}- insert:\n    - { id: other, name: other-plugin }\n# Shrink${tail}`,
  ],
  [
    "a stale row in an operation aimed at a group by id, whose id must survive",
    `${head}- id: my-group\n  insert:\n${staleRow.replace(/^/gm, "    ").replace(/^ {4}$/gm, "")}# Shrink${tail}`,
    (dshHome) => `${head}- id: my-group\n  insert:\n${ourRow(dshHome, "    ")}# Shrink${tail}`,
    `${head}- id: my-group\n  insert:\n# Shrink${tail}`,
  ],
  [
    "a stale row the user merged into an operation with another plugin",
    `${head}- insert:\n    - id: other\n      name: other-plugin\n${staleRow.replace(/^/gm, "    ").replace(/^ {4}$/gm, "")}# Shrink${tail}`,
    (dshHome) =>
      `${head}- insert:\n    - id: other\n      name: other-plugin\n${ourRow(dshHome, "    ")}# Shrink${tail}`,
    `${head}- insert:\n    - id: other\n      name: other-plugin\n# Shrink${tail}`,
  ],
];

test.each(layouts)(
  "%s is rewritten in place and removed alone",
  async (_, before, mounted, unmounted) => {
    await withTempDir(async (home) => {
      const dshHome = join(home, "dsh-home");
      mkdirSync(dshHome);
      writeFileSync(join(dshHome, "cordis.patch.yml"), before);
      await apply(home, true);
      expect(readFileSync(join(dshHome, "cordis.patch.yml"), "utf8")).toBe(mounted(dshHome));
      await apply(home, false);
      expect(readFileSync(join(dshHome, "cordis.patch.yml"), "utf8")).toBe(unmounted);
    });
  },
);

test("a missing DSH_HOME defaults to ~/.dsh, a missing patch file is created, and a project install mounts the same machine-wide row", async () => {
  await withTempDir(async (home) => {
    const changes = await reconcileBridge(
      "global",
      { home, projectRoot: null, env: {} },
      spec,
      true,
    );
    expect(
      await reconcileBridge("project", { home, projectRoot: join(home, "p"), env: {} }, spec, true),
    ).toEqual(changes);
    expect(changes).toEqual([
      {
        kind: "write",
        path: rooted(join(home, ".dsh"), "maxims-hooks.json"),
        content: `${JSON.stringify(
          {
            hooks: {
              SessionStart: [
                {
                  hooks: [
                    {
                      type: "command",
                      command: "npx -y @vivswan/maxims sync --quiet",
                      timeout: 20,
                    },
                  ],
                },
              ],
            },
          },
          null,
          2,
        )}\n`,
      },
      {
        kind: "write",
        path: rooted(join(home, ".dsh"), "cordis.patch.yml"),
        content: ourOperation(join(home, ".dsh")),
      },
    ]);
    expect(
      await reconcileBridge("global", { home, projectRoot: null, env: {} }, spec, false),
    ).toEqual([{ kind: "delete", path: rooted(join(home, ".dsh"), "maxims-hooks.json") }]);
  });
});

const refusals: [string, string][] = [
  ["a patch file that is a map, not a list", "plugins:\n  - name: x\n"],
  ["unparseable YAML", "- insert:\n  - id: [\n"],
  ["a non-empty flow-style list", "[{ insert: [] }]\n"],
  ["an indented list", "  - insert: []\n"],
  ["a list followed by a document end marker", "- replace: { id: a }\n...\n"],
];

test.each(refusals)("refuses to rewrite %s (exit 4)", async (_, text) => {
  await withTempDir(async (home) => {
    const dshHome = join(home, "dsh-home");
    mkdirSync(dshHome);
    writeFileSync(join(dshHome, "cordis.patch.yml"), text);
    let caught: unknown;
    try {
      await reconcileBridge("global", contextFor(home), spec, true);
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(MaximsError);
    expect(caught).toMatchObject({ code: ExitCode.DestinationWriteFailed });
    expect(readFileSync(join(dshHome, "cordis.patch.yml"), "utf8")).toBe(text);
  });
});

const budgets: [string, string, string, number | null][] = [
  ["exactly at the file budget", "a".repeat(DSH_FILE_BUDGET - 10), "b".repeat(10), 64_512],
  ["one byte over", "a".repeat(DSH_FILE_BUDGET - 10), "b".repeat(11), null],
  [
    "multi-byte characters counted as bytes",
    "a".repeat(DSH_FILE_BUDGET - 10),
    "\u00e9".repeat(6),
    null,
  ],
];

test.each(budgets)("checkBudget with %s", (_, surrounding, block, total) => {
  if (total !== null) {
    expect(checkBudget(surrounding, block)).toBe(total);
    return;
  }
  let caught: unknown;
  try {
    checkBudget(surrounding, block);
  } catch (error) {
    caught = error;
  }
  expect(caught).toBeInstanceOf(MaximsError);
  expect(caught).toMatchObject({ code: ExitCode.RuleCapExceeded });
});
