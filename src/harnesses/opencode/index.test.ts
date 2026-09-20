// Guards the OpenCode artifacts that would drift silently: the plugin file must render the same
// bytes on every sync (a differing render would rewrite it every session start) at the plugins
// path OpenCode scans, the `instructions` edit must leave a hand-formatted opencode.json
// byte-identical outside our entry and name the glob the rule files are written under, and the
// global files must follow `$XDG_CONFIG_HOME/opencode`.
import { expect, test } from "bun:test";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { withTempDir } from "../../../tests/shared/temp_dir.ts";
import { ExitCode, MaximsError } from "../../util/exit-codes.ts";
import { assertInsideRoot } from "../../util/fs.ts";
import type { HarnessContext, Scope } from "../contract.ts";
import { hasHook, planFileHookWrite } from "../hook-writer.ts";
import { planRulesDirWrite } from "../strategies/rules-dir.ts";
import { planSharedBlockWrite } from "../strategies/shared-block.ts";
import { opencode } from "./index.ts";
import { INSTRUCTIONS_GLOB, reconcileInstructions } from "./quirks.ts";

const fixture = readFileSync(join(import.meta.dir, "fixtures", "config.jsonc"), "utf8");
const ctx: HarnessContext = { home: "/home/user", projectRoot: "/home/user/project", env: {} };
const xdg: HarnessContext = { ...ctx, env: { XDG_CONFIG_HOME: "/home/user/xdg" } };
const block =
  "<!-- maxims:begin @example-user/doctrine sha=1 -->\n<!-- maxims:end @example-user/doctrine -->\n";

const pluginPaths: [string, Scope, HarnessContext, string, string][] = [
  [
    "the project",
    "project",
    ctx,
    "/home/user/project",
    "/home/user/project/.opencode/plugins/maxims.ts",
  ],
  [
    "the default config home",
    "global",
    ctx,
    "/home/user",
    "/home/user/.config/opencode/plugins/maxims.ts",
  ],
  ["XDG_CONFIG_HOME", "global", xdg, "/home/user", "/home/user/xdg/opencode/plugins/maxims.ts"],
];

// OpenCode reads nothing back from a plugin and the shell call is `.nothrow().quiet()`, so an
// offline npx can never surface as a plugin error in the session.
test.each(pluginPaths)(
  "the plugin under %s renders the same bytes twice",
  (_, scope, context, root, path) => {
    if (!hasHook(opencode, "file")) throw new Error("OpenCode writes a plugin file");
    const input = { def: opencode, scope, ctx: context, wanted: true, current: null };
    const [first] = planFileHookWrite(input).changes;
    expect(planFileHookWrite(input).changes).toEqual([first]);
    expect(first).toEqual({
      kind: "write",
      path: assertInsideRoot(root, path),
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
  },
);

// The project rule file is bare (OpenCode reads it only through the `instructions` entry, so no
// preamble applies) and lands under the glob that entry names; the user block goes into the one
// AGENTS.md OpenCode always reads, under its XDG home.
test("the project rule file matches the instructions glob and the user block follows XDG_CONFIG_HOME", () => {
  const project = opencode.targets.project;
  if (project?.kind !== "rules-dir") throw new Error("the project target is a rules directory");
  const [rule] = planRulesDirWrite({
    def: opencode,
    target: project,
    scope: "project",
    ctx,
    sourceSlug: "example-user-doctrine",
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
  const global = opencode.targets.global;
  if (global?.kind !== "shared-block") throw new Error("the user target is a shared block");
  expect(
    planSharedBlockWrite({
      def: opencode,
      target: global,
      scope: "global",
      ctx: xdg,
      source: "@example-user/doctrine",
      currentText: null,
      block,
    }),
  ).toEqual([
    {
      kind: "write",
      path: assertInsideRoot("/home/user", "/home/user/xdg/opencode/AGENTS.md"),
      content: block,
    },
  ]);
});

test("detection reads the opencode directory under ~/.config or XDG_CONFIG_HOME", async () => {
  await withTempDir((dir) => {
    const home = join(dir, "home");
    const bare: HarnessContext = { home, projectRoot: null, env: {} };
    mkdirSync(home);
    expect(opencode.detect(bare)).toBe(false);
    mkdirSync(join(dir, "xdg", "opencode"), { recursive: true });
    expect(opencode.detect({ ...bare, env: { XDG_CONFIG_HOME: join(dir, "xdg") } })).toBe(true);
    expect(opencode.detect(bare)).toBe(false);
    mkdirSync(join(home, ".config", "opencode"), { recursive: true });
    expect(opencode.detect(bare)).toBe(true);
  });
});

test("adding then removing the instructions entry returns a hand-formatted opencode.json", async () => {
  await withTempDir(async (dir) => {
    const path = assertInsideRoot(dir, join(dir, "opencode.json"));
    writeFileSync(path, fixture);
    const inProject = { ...ctx, projectRoot: dir };
    const configEdit = opencode.configEdit;
    if (configEdit === undefined) throw new Error("OpenCode lists its rules dir in opencode.json");

    const added = await configEdit("project", inProject, true);
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
    expect(await configEdit("project", inProject, true)).toEqual([]);
    expect(await configEdit("global", inProject, true)).toEqual([]);

    const removed = await configEdit("project", inProject, false);
    expect(removed).toEqual([{ kind: "write", path, content: fixture }]);
    writeFileSync(path, fixture);
    expect(await configEdit("project", inProject, false)).toEqual([]);
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
      { kind: "write", path: assertInsideRoot(dir, join(dir, name)), content: expected },
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
  ["unparsable JSON", '{\n  "instructions": [\n'],
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
