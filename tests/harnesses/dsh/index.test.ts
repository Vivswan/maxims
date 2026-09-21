// Guards the dsh bridge pair: a hand-formatted cordis.patch.yml must come back byte-identical
// once our row leaves (dsh's own guide warns the file carries unrelated user patches), a sibling
// plugin the user merged into our insert operation must survive both mount and unmount, and a row
// the user duplicated by hand must converge to one on mount and to none on unmount. Also pins the
// AGENTS.md dsh reads per scope under $DSH_HOME, the byte line past which dsh truncates it, and
// that only a directory at the dsh home counts as an install.
import { expect, test } from "bun:test";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { type HarnessContext, hookSpecFor, type Scope } from "../../../src/harnesses/contract.ts";
import { dsh } from "../../../src/harnesses/dsh/index.ts";
import { BRIDGE_ROW_ID } from "../../../src/harnesses/dsh/quirks.ts";
import { planSharedBlockWrite } from "../../../src/harnesses/strategies/shared-block.ts";
import { applyChanges } from "../../../src/util/change.ts";
import { ExitCode, MaximsError } from "../../../src/util/exit-codes.ts";
import { assertInsideRoot } from "../../../src/util/fs.ts";
import { srcPath } from "../../shared/src_path.ts";
import { withTempDir } from "../../shared/temp_dir.ts";

const fixture = readFileSync(srcPath("harnesses", "dsh", "fixtures", "config.yml"), "utf8");
const spec = hookSpecFor(dsh);
if (dsh.hook.kind !== "custom") throw new Error("dsh mounts a bridge through a custom hook");
const reconcileBridge = dsh.hook.reconcile;
const rooted = (root: string, ...parts: string[]) => assertInsideRoot(root, join(root, ...parts));

function contextFor(home: string) {
  return { home, projectRoot: join(home, "project"), env: { DSH_HOME: join(home, "dsh-home") } };
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
    // Nothing is mounted and no hooks file exists, so there is nothing to take back: a plan that
    // named the file would report a deletion on every sync of a machine without dsh.
    expect(
      await reconcileBridge("global", { home, projectRoot: null, env: {} }, spec, false),
    ).toEqual([]);
    await applyChanges({ changes, notices: [] }, { dryRun: false });
    expect(
      await reconcileBridge("global", { home, projectRoot: null, env: {} }, spec, false),
    ).toEqual([
      { kind: "delete", path: rooted(join(home, ".dsh"), "maxims-hooks.json") },
      { kind: "write", path: rooted(join(home, ".dsh"), "cordis.patch.yml"), content: "[]\n" },
    ]);
  });
});

const refusals: [string, string][] = [
  ["a patch file that is a map, not a list", "plugins:\n  - name: x\n"],
  ["unparsable YAML", "- insert:\n  - id: [\n"],
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

const ctx: HarnessContext = {
  home: "/home/user",
  projectRoot: "/home/user/project",
  env: { DSH_HOME: "/home/user/dsh-home" },
};
const block =
  "<!-- maxims:begin @example-user/doctrine sha=1 -->\n<!-- maxims:end @example-user/doctrine -->\n";

function sharedBlock(scope: Scope) {
  const target = dsh.targets[scope];
  if (target?.kind !== "shared-block") throw new Error("dsh reads an AGENTS.md block");
  return target;
}

const blocks: [Scope, string, string][] = [
  ["project", "/home/user/project", "/home/user/project/AGENTS.md"],
  ["global", "/home/user/dsh-home", "/home/user/dsh-home/AGENTS.md"],
];

test.each(blocks)(
  "the %s block is written to the AGENTS.md dsh reads, under $DSH_HOME for the user",
  (scope, root, path) => {
    expect(
      planSharedBlockWrite({
        def: dsh,
        target: sharedBlock(scope),
        scope,
        ctx,
        source: "@example-user/doctrine",
        currentText: null,
        block,
      }),
    ).toEqual([{ kind: "write", path: assertInsideRoot(root, path), content: block }]);
  },
);

// dsh renders every instruction file into one 65,536-byte block and truncates the most specific
// file past it; the frame it adds around a file is allowed for, so a rule file may reach 64,512
// bytes and no further.
test("a block at the dsh line is written and one byte past it is refused", () => {
  const frame =
    "<!-- maxims:begin @example-user/doctrine sha=1 -->\n\n<!-- maxims:end @example-user/doctrine -->\n";
  const atLine = frame.replace("\n\n", `\n${"x".repeat(64_512 - frame.length)}\n`);
  const write = (content: string) =>
    planSharedBlockWrite({
      def: dsh,
      target: sharedBlock("project"),
      scope: "project",
      ctx,
      source: "@example-user/doctrine",
      currentText: null,
      block: content,
    });
  expect(
    write(atLine).map((change) => change.kind === "write" && Buffer.byteLength(change.content)),
  ).toEqual([64_512]);
  let caught: unknown;
  try {
    write(atLine.replace("xx", "xxx"));
  } catch (error) {
    caught = error;
  }
  expect(caught).toBeInstanceOf(MaximsError);
  expect(caught).toMatchObject({ code: ExitCode.RuleCapExceeded });
  expect(String((caught as MaximsError).message)).toContain(
    "64512-byte limit DeepSeek Harness loads",
  );
});

test("detection reads a directory at ~/.dsh or $DSH_HOME, never a stray file there", async () => {
  await withTempDir((dir) => {
    const home = join(dir, "home");
    mkdirSync(home);
    const bare: HarnessContext = { home, projectRoot: null, env: {} };
    expect(dsh.detect(bare)).toBe(false);
    writeFileSync(join(dir, "elsewhere"), "");
    expect(dsh.detect({ ...bare, env: { DSH_HOME: join(dir, "elsewhere") } })).toBe(false);
    mkdirSync(join(dir, "dsh-home"));
    expect(dsh.detect({ ...bare, env: { DSH_HOME: join(dir, "dsh-home") } })).toBe(true);
    expect(dsh.detect(bare)).toBe(false);
    mkdirSync(join(home, ".dsh"));
    expect(dsh.detect(bare)).toBe(true);
  });
});
