// Guards the OpenCode artifacts that would drift silently: the plugin file's bytes, the
// `instructions` edit that must leave a hand-formatted opencode.json byte-identical outside our
// entry and name the glob the rule files are written under.
import { expect, test } from "bun:test";
import {
  chmodSync,
  mkdirSync,
  readFileSync,
  readlinkSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import type { ConfigRewrite, SourceSlug } from "../../../src/harnesses/contract.ts";
import { hasHook, mintRewrites, planFileHookWrite } from "../../../src/harnesses/hook-writer.ts";
import {
  INSTRUCTIONS_GLOB,
  reconcileInstructions as planInstructions,
} from "../../../src/harnesses/opencode/quirks.ts";
import { opencode } from "../../../src/harnesses/opencode/spec.ts";
import { planRulesDirWrite } from "../../../src/harnesses/strategies/rules-dir.ts";
import { applyChanges, type Change } from "../../../src/util/change.ts";
import { ExitCode } from "../../../src/util/exit-codes.ts";
import { assertInsideRoot } from "../../../src/util/fs.ts";
import { asyncOutcome } from "../../shared/outcome.ts";
import { CHMOD_DENIES } from "../../shared/platform.ts";
import { srcPath } from "../../shared/src_path.ts";
import { withTempDir } from "../../shared/temp_dir.ts";
import { exampleContext as ctx } from "../context.ts";

const fixture = readFileSync(srcPath("harnesses", "opencode", "fixtures", "config.jsonc"), "utf8");
const block =
  "<!-- maxims:begin @example-user/doctrine sha=1 version=1 -->\n<!-- maxims:end @example-user/doctrine -->\n";

// The instructions edit as the changes it comes to, its rewrites minted over the files on disk,
// as `list` and `doctor` plan one harness alone.
const minted = async (rewrites: Promise<ConfigRewrite[]>): Promise<Change[]> =>
  mintRewrites(await rewrites);
const reconcileInstructions = (root: string, wanted: boolean) =>
  minted(planInstructions(root, wanted));

// OpenCode reads nothing back from a plugin and the shell call is `.nothrow().quiet()`, so an
// offline npx can never surface as a plugin error in the session.
test("the plugin file is written byte for byte as OpenCode loads it", () => {
  if (!hasHook(opencode, "file")) throw new Error("OpenCode writes a plugin file");
  const [written] = planFileHookWrite({
    def: opencode,
    scope: "project",
    ctx,
    wanted: true,
    current: null,
  }).changes;
  expect(written).toEqual({
    kind: "write",
    path: assertInsideRoot("/home/user/project", "/home/user/project/.opencode/plugins/maxims.ts"),
    content: [
      "// Written by maxims. It runs the maxims sync whenever an OpenCode session is created so the",
      "// rule files stay current. maxims rewrites this file on every sync while a source in its",
      "// state still wants a hook for OpenCode; removing the last such source deletes it.",
      'import type { Plugin } from "@opencode-ai/plugin";',
      "",
      "export const MaximsSync: Plugin = async ({ $ }) => ({",
      "  event: async ({ event }) => {",
      '    if (event.type === "session.created") await $`npx -y @vivswan/maxims sync --quiet`.nothrow().quiet();',
      "  },",
      "});",
      "",
    ].join("\n"),
  });
});

// The project rule file is bare (OpenCode reads it only through the `instructions` entry, so no
// preamble applies) and lands under the glob that entry names.
test("the project rule file is bare and matches the instructions glob", () => {
  const project = opencode.targets.project;
  if (project?.kind !== "rules-dir") throw new Error("the project target is a rules directory");
  const [rule] = planRulesDirWrite({
    def: opencode,
    target: project,
    scope: "project",
    ctx,
    sourceSlug: "example-user-doctrine" as SourceSlug,
    block,
  });
  expect(rule).toEqual({
    kind: "write",
    path: assertInsideRoot(
      "/home/user/project",
      "/home/user/project/.opencode/memories/maxims-example-user-doctrine.md",
    ),
    content: block,
  });
  expect(
    new Bun.Glob(INSTRUCTIONS_GLOB).match(".opencode/memories/maxims-example-user-doctrine.md"),
  ).toBe(true);
});

test("adding then removing the instructions entry returns a hand-formatted opencode.json", async () => {
  await withTempDir(async (dir) => {
    const path = assertInsideRoot(dir, join(dir, "opencode.json"));
    writeFileSync(path, fixture);
    const inProject = { ...ctx, projectRoot: dir, cwd: dir };
    const planned = opencode.configEdit;
    if (planned === undefined) throw new Error("OpenCode lists its rules dir in opencode.json");
    const configEdit = (...args: Parameters<typeof planned>) => minted(planned(...args));

    const added = await configEdit("project", inProject, true);
    expect(added).toEqual([
      {
        kind: "edit",
        path,
        target: path,
        content: fixture.replace(
          '"docs/guidelines.md"]',
          '"docs/guidelines.md", ".opencode/memories/maxims-*.md"]',
        ),
      },
    ]);
    writeFileSync(path, added[0]?.kind === "edit" ? added[0].content : "");
    expect(await configEdit("project", inProject, true)).toEqual([]);
    expect(await configEdit("global", inProject, true)).toEqual([]);

    const removed = await configEdit("project", inProject, false);
    expect(removed).toEqual([{ kind: "edit", path, target: path, content: fixture }]);
    writeFileSync(path, fixture);
    expect(await configEdit("project", inProject, false)).toEqual([]);
  });
});

// The config is the user's file: one kept in a dotfiles checkout inside the project and linked
// into place is edited in the checkout, the link surviving, where a plain write would have put a
// real file over the link. A link out of the project is refused by name with the fix, and nothing
// is written on either side of it.
test("an opencode.json that is a link is edited behind the link inside the project, and refused out of it", async () => {
  await withTempDir(async (dir) => {
    const root = join(dir, "project");
    const inside = assertInsideRoot(root, join(root, "dotfiles", "opencode.json"));
    const outside = join(dir, "elsewhere", "opencode.json");
    for (const file of [inside, outside]) {
      mkdirSync(dirname(file), { recursive: true });
      writeFileSync(file, fixture);
    }
    const link = assertInsideRoot(root, join(root, "opencode.json"));
    symlinkSync(inside, link);
    const changes = await reconcileInstructions(root, true);
    expect(changes).toEqual([
      {
        kind: "edit",
        path: link,
        target: inside,
        content: expect.stringContaining(INSTRUCTIONS_GLOB),
      },
    ]);
    await applyChanges({ changes, notices: [] }, { dryRun: false });
    expect([readlinkSync(link), readFileSync(inside, "utf8").includes(INSTRUCTIONS_GLOB)]).toEqual([
      inside,
      true,
    ]);
    expect(await reconcileInstructions(root, true)).toEqual([]);

    unlinkSync(link);
    symlinkSync(outside, link);
    expect(await asyncOutcome(() => reconcileInstructions(root, true))).toMatchObject({
      kind: "threw",
      error: {
        name: "MaximsError",
        code: ExitCode.DestinationWriteFailed,
        message: `cannot edit ${link}: it is a symlink to ${outside}, outside ${root}`,
        hint: `move the file the link points to under ${root}, or replace the link with a real file, then run maxims sync`,
      },
    });
    expect([readlinkSync(link), readFileSync(outside, "utf8")]).toEqual([outside, fixture]);
  });
});

const creations: [string, string | null, string][] = [
  ["a missing file", null, `{\n  "instructions": [\n    "${INSTRUCTIONS_GLOB}"\n  ]\n}\n`],
  ["a touched, empty file", "", `{\n  "instructions": [\n    "${INSTRUCTIONS_GLOB}"\n  ]\n}\n`],
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
  [
    "an opencode.jsonc holding only whitespace, which is filled rather than left beside a new opencode.json",
    " \n",
    `{\n  "instructions": [\n    "${INSTRUCTIONS_GLOB}"\n  ]\n}\n`,
  ],
];

test.each(creations)("writes the entry into %s", async (label, existing, expected) => {
  await withTempDir(async (dir) => {
    const name = label.startsWith("an opencode.jsonc") ? "opencode.jsonc" : "opencode.json";
    if (existing !== null) writeFileSync(join(dir, name), existing);
    const path = assertInsideRoot(dir, join(dir, name));
    expect(await reconcileInstructions(dir, true)).toEqual([
      { kind: "edit", path, target: path, content: expected },
    ]);
  });
});

test("both config names count: no second entry is added and removal clears every copy", async () => {
  await withTempDir(async (dir) => {
    const json = assertInsideRoot(dir, join(dir, "opencode.json"));
    const jsonc = join(dir, "opencode.jsonc");
    writeFileSync(
      json,
      `{ "instructions": ["${INSTRUCTIONS_GLOB}", "user.md", "${INSTRUCTIONS_GLOB}"] }\n`,
    );
    writeFileSync(jsonc, '{ "model": "x" }\n');
    expect(await reconcileInstructions(dir, true)).toEqual([]);
    expect(await reconcileInstructions(dir, false)).toEqual([
      { kind: "edit", path: json, target: json, content: '{ "instructions": ["user.md"] }\n' },
    ]);

    writeFileSync(jsonc, `{ "instructions": ["${INSTRUCTIONS_GLOB}"] }\n`);
    writeFileSync(json, "{");
    await expect(reconcileInstructions(dir, true)).rejects.toMatchObject({
      name: "MaximsError",
      code: ExitCode.DestinationWriteFailed,
    });
  });
});

const refusals: [string, string][] = [
  ["unparsable JSON", '{\n  "instructions": [\n'],
  ["an instructions value that is not an array", '{\n  "instructions": "AGENTS.md"\n}\n'],
];

// Refused on the way out as on the way in: a removal that read a non-array `instructions` as
// "nothing of ours here" would leave a file OpenCode rejects with nothing said.
test.each(refusals)("refuses to rewrite %s (exit 4), wanted or not", async (_, text) => {
  await withTempDir(async (dir) => {
    writeFileSync(join(dir, "opencode.json"), text);
    for (const wanted of [true, false]) {
      expect([wanted, await asyncOutcome(() => reconcileInstructions(dir, wanted))]).toMatchObject([
        wanted,
        { kind: "threw", error: { name: "MaximsError", code: ExitCode.DestinationWriteFailed } },
      ]);
    }
    expect(readFileSync(join(dir, "opencode.json"), "utf8")).toBe(text);
  });
});

// A project root the process may not search is a config it could not look at, which is the
// destination's failure (exit 4, reported for this harness while the sync goes on), never a raw
// error that aborts the run.
test.skipIf(!CHMOD_DENIES)(
  "a config directory that cannot be searched is exit 4 with the reason",
  async () => {
    await withTempDir(async (dir) => {
      const locked = join(dir, "project");
      mkdirSync(locked);
      chmodSync(locked, 0o000);
      try {
        const verdict = await asyncOutcome(() => reconcileInstructions(locked, true));
        // Which look trips first is the platform's: Linux resolves a directory it cannot search
        // and refuses at the config read inside it, macOS refuses the realpath of the project.
        const project = RegExp.escape(locked);
        expect(verdict).toMatchObject({
          kind: "threw",
          error: {
            name: "MaximsError",
            code: ExitCode.DestinationWriteFailed,
            message: expect.stringMatching(
              new RegExp(
                `^cannot (read ${project}/[^:]+|inspect ${project}): EACCES: permission denied, `,
              ),
            ),
          },
        });
      } finally {
        chmodSync(locked, 0o700);
      }
    });
  },
);
