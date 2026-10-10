// Guards the dsh bridge pair: a hand-formatted cordis.patch.yml must come back byte-identical
// once our row leaves (dsh's own guide warns the file carries unrelated user patches), a sibling
// plugin the user merged into our insert operation must survive both mount and unmount, and a row
// the user duplicated by hand must converge to one on mount and to none on unmount. Also pins the
// byte line past which dsh truncates an AGENTS.md.
import { expect, test } from "bun:test";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { hookSpecFor } from "../../../src/harnesses/contract.ts";
import { BRIDGE_ROW_ID } from "../../../src/harnesses/dsh/quirks.ts";
import { dsh } from "../../../src/harnesses/dsh/spec.ts";
import { assertWithinBudget } from "../../../src/harnesses/strategies/rules-dir.ts";
import { sharedBlockPath } from "../../../src/harnesses/strategies/shared-block.ts";
import { applyChanges } from "../../../src/util/change.ts";
import { ExitCode } from "../../../src/util/exit-codes.ts";
import { assertInsideRoot } from "../../../src/util/fs.ts";
import { asyncOutcome, outcome } from "../../shared/outcome.ts";
import { srcPath } from "../../shared/src_path.ts";
import { withTempDir } from "../../shared/temp_dir.ts";
import { exampleContext as ctx } from "../context.ts";

const fixture = readFileSync(srcPath("harnesses", "dsh", "fixtures", "config.yml"), "utf8");
const spec = hookSpecFor(dsh);
if (dsh.hook.kind !== "custom") throw new Error("dsh mounts a bridge through a custom hook");
const reconcileBridge = dsh.hook.reconcile;
const rooted = (root: string, ...parts: string[]) => assertInsideRoot(root, join(root, ...parts));

function contextFor(home: string) {
  return {
    home,
    projectRoot: join(home, "project"),
    cwd: join(home, "project"),
    env: { DSH_HOME: join(home, "dsh-home") },
  };
}

function ourRow(dshHome: string, indent = ""): string {
  return [
    `- id: ${BRIDGE_ROW_ID}`,
    '  name: "@deepseek-ai/dsh-hooks-claude-code"',
    "  config:",
    `    configPath: ${join(dshHome, "maxims-hooks.json")}`,
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
const staleItem = staleRow.replace(/^/gm, "    ").replace(/^ {4}$/gm, "");
const otherItem = "    - id: other\n      name: other-plugin\n";

// [label, patch file before, after mounting, after unmounting]
const layouts: [string, string, (dshHome: string) => string, string][] = [
  [
    "a stale row alone in its operation, mid-file",
    `${head}- insert:\n${staleItem}# Shrink${tail}`,
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
    `- insert:\n${staleItem}`,
    (dshHome) => ourOperation(dshHome),
    "[]\n",
  ],
  [
    "a stale row with a trailing comment, followed by a flow-style sibling that keeps its indent",
    `${head}- insert:\n${staleItem}      # note\n    - { id: other, name: other-plugin }\n# Shrink${tail}`,
    (dshHome) =>
      `${head}- insert:\n${ourRow(dshHome, "    ")}    - { id: other, name: other-plugin }\n# Shrink${tail}`,
    `${head}- insert:\n    - { id: other, name: other-plugin }\n# Shrink${tail}`,
  ],
  [
    "a stale row in an operation aimed at a group by id, whose id must survive",
    `${head}- id: my-group\n  insert:\n${staleItem}# Shrink${tail}`,
    (dshHome) => `${head}- id: my-group\n  insert:\n${ourRow(dshHome, "    ")}# Shrink${tail}`,
    `${head}- id: my-group\n  insert:\n# Shrink${tail}`,
  ],
  [
    "a stale row the user merged into an operation with another plugin",
    `${head}- insert:\n${otherItem}${staleItem}# Shrink${tail}`,
    (dshHome) => `${head}- insert:\n${otherItem}${ourRow(dshHome, "    ")}# Shrink${tail}`,
    `${head}- insert:\n${otherItem}# Shrink${tail}`,
  ],
  [
    "two copies of our row duplicated by hand inside one operation",
    `${head}- insert:\n${staleItem}${staleItem}# Shrink${tail}`,
    (dshHome) => `${head}${ourOperation(dshHome)}# Shrink${tail}`,
    `${head}# Shrink${tail}`,
  ],
  [
    "our row repeated in two operations",
    `${head}- insert:\n${staleItem}- insert:\n${staleItem}# Shrink${tail}`,
    (dshHome) => `${head}${ourOperation(dshHome)}# Shrink${tail}`,
    `${head}# Shrink${tail}`,
  ],
  [
    "our row beside another plugin and again in an operation of its own",
    `${head}- insert:\n${otherItem}${staleItem}- insert:\n${staleItem}# Shrink${tail}`,
    (dshHome) => `${head}- insert:\n${otherItem}${ourRow(dshHome, "    ")}# Shrink${tail}`,
    `${head}- insert:\n${otherItem}# Shrink${tail}`,
  ],
];

// An unmount straight from the "before" layout takes the same path as one after a mount, so a
// file that already holds a stale or duplicated row is cleaned without a mount in between.
test.each(layouts)(
  "%s is rewritten in place and removed alone",
  async (_, before, mounted, unmounted) => {
    await withTempDir(async (home) => {
      const dshHome = join(home, "dsh-home");
      const patch = join(dshHome, "cordis.patch.yml");
      mkdirSync(dshHome);
      writeFileSync(patch, before);
      await apply(home, true);
      expect(readFileSync(patch, "utf8")).toBe(mounted(dshHome));
      await apply(home, false);
      expect(readFileSync(patch, "utf8")).toBe(unmounted);
      if (!before.includes(BRIDGE_ROW_ID)) return;
      writeFileSync(patch, before);
      await apply(home, false);
      expect(readFileSync(patch, "utf8")).toBe(unmounted);
    });
  },
);

test("a missing DSH_HOME defaults to ~/.dsh, a missing patch file is created, a project install mounts the same machine-wide row, and an unmount takes back only what is there", async () => {
  await withTempDir(async (home) => {
    const changes = await reconcileBridge(
      "global",
      { home, projectRoot: null, cwd: home, env: {} },
      spec,
      true,
    );
    expect(
      await reconcileBridge(
        "project",
        { home, projectRoot: join(home, "p"), cwd: join(home, "p"), env: {} },
        spec,
        true,
      ),
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
    // Nothing is mounted and no hooks file exists, so there is nothing to take back: a plan that
    // named the file would report a deletion on every sync of a machine without dsh.
    expect(
      await reconcileBridge("global", { home, projectRoot: null, cwd: home, env: {} }, spec, false),
    ).toEqual([]);
    await applyChanges({ changes, notices: [] }, { dryRun: false });
    expect(
      await reconcileBridge("global", { home, projectRoot: null, cwd: home, env: {} }, spec, false),
    ).toEqual([
      { kind: "delete", path: rooted(join(home, ".dsh"), "maxims-hooks.json") },
      { kind: "write", path: rooted(join(home, ".dsh"), "cordis.patch.yml"), content: "[]\n" },
    ]);
    // A row the user removed by hand leaves the hooks file orphaned; the unmount still takes it.
    writeFileSync(join(home, ".dsh", "cordis.patch.yml"), "[]\n");
    expect(
      await reconcileBridge("global", { home, projectRoot: null, cwd: home, env: {} }, spec, false),
    ).toEqual([{ kind: "delete", path: rooted(join(home, ".dsh"), "maxims-hooks.json") }]);
  });
});

// The reason names the guard that refused: the shape check, or the parse that precedes it.
const refusals: [string, string, string][] = [
  [
    "a patch file that is a map, not a list",
    "plugins:\n  - name: x\n",
    "is not a block list of patch operations; left untouched",
  ],
  ["unparsable YAML", "- insert:\n  - id: [\n", "cannot parse"],
  [
    "a non-empty flow-style list",
    "[{ insert: [] }]\n",
    "is not a block list of patch operations; left untouched",
  ],
  [
    "an indented list",
    "  - insert: []\n",
    "is not a block list of patch operations; left untouched",
  ],
  ["a list followed by a document end marker", "- replace: { id: a }\n...\n", "cannot parse"],
];

test.each(refusals)("refuses to rewrite %s (exit 4)", async (_, text, reason) => {
  await withTempDir(async (home) => {
    const dshHome = join(home, "dsh-home");
    mkdirSync(dshHome);
    writeFileSync(join(dshHome, "cordis.patch.yml"), text);
    const verdict = await asyncOutcome(() =>
      reconcileBridge("global", contextFor(home), spec, true),
    );
    expect(verdict).toMatchObject({
      kind: "threw",
      error: {
        name: "MaximsError",
        code: ExitCode.DestinationWriteFailed,
        message: expect.stringContaining(reason),
      },
    });
    expect(readFileSync(join(dshHome, "cordis.patch.yml"), "utf8")).toBe(text);
  });
});

// dsh renders every instruction file into one 65,536-byte block and truncates the most specific
// file past it; the frame it adds around a file is allowed for, so a rule file may reach 64,512
// bytes and no further.
test("a block at the dsh line passes the budget and one byte past it is refused", () => {
  const target = dsh.targets.project;
  if (target?.kind !== "shared-block") throw new Error("dsh reads an AGENTS.md block");
  const frame =
    "<!-- maxims:begin @example-user/doctrine sha=1 -->\n\n<!-- maxims:end @example-user/doctrine -->\n";
  const atLine = frame.replace("\n\n", `\n${"x".repeat(64_512 - frame.length)}\n`);
  const path = sharedBlockPath({ def: dsh, target, scope: "project", ctx });
  const budget = (content: string) => assertWithinBudget(dsh, "project", path, content);
  expect(Buffer.byteLength(atLine)).toBe(64_512);
  expect(outcome(() => budget(atLine))).toEqual({ kind: "value", value: undefined });
  expect(outcome(() => budget(atLine.replace("xx", "xxx")))).toMatchObject({
    kind: "threw",
    error: {
      name: "MaximsError",
      code: ExitCode.RuleCapExceeded,
      message: expect.stringContaining("64512-byte limit DeepSeek Harness loads"),
    },
  });
});
