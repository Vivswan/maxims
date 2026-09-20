// The hook writer edits files the user also owns: a clobbered comment or key, a stale entry left
// behind, an orphan matcher group after removal, or a rewrite of a file we cannot parse would each
// pass a shape check and still wreck the user's settings.
import { describe, expect, test } from "bun:test";
import { mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parse } from "jsonc-parser";
import { withTempDir } from "../../tests/shared/temp_dir.ts";
import { applyChanges, type Change } from "../util/change.ts";
import { ExitCode, MaximsError } from "../util/exit-codes.ts";
import { assertInsideRoot } from "../util/fs.ts";
import {
  type HarnessContext,
  type HarnessDefinition,
  HOOK_COMMAND,
  hookSpecFor,
  type RegistryHook,
  type Scope,
} from "./contract.ts";
import {
  achievedTier,
  type HarnessWithHook,
  planFileHookWrite,
  planHookRegistryWrite,
  planHookWrite,
} from "./hook-writer.ts";

const projectRoot = "/home/user/project";
const ctx: HarnessContext = { home: "/home/user", projectRoot, env: {} };
const rooted = (path: string) => assertInsideRoot(projectRoot, path);
const settingsPath = rooted(`${projectRoot}/.claude/settings.json`);

const base: Omit<HarnessDefinition, "hook"> = {
  id: "claude-code",
  displayName: "Example",
  tier: 1,
  targets: { project: null, global: null },
  bodiesDir: () => null,
  markers: "counted",
  expands: ["none"],
  detect: () => false,
  verifiedAgainst: { url: "https://example.com/docs", date: "2026-09-20" },
};

function registryDef(hook: Partial<RegistryHook> = {}): HarnessWithHook<"registry"> {
  return {
    ...base,
    hook: {
      kind: "registry",
      path: (scope, ctx) =>
        join(scope === "global" ? ctx.home : (ctx.projectRoot ?? ""), ".claude", "settings.json"),
      format: "json",
      eventPath: ["hooks", "SessionStart"],
      grouped: true,
      handler: (spec) => ({
        type: "command",
        command: [spec.command, ...spec.args].join(" "),
        async: spec.async,
        timeout: spec.timeoutSeconds,
      }),
      commandKey: "command",
      stdout: "plain",
      async: true,
      ...hook,
    },
  };
}

const grouped = registryDef();
const flat = registryDef({
  path: (_, ctx) => join(ctx.projectRoot ?? "", ".github", "hooks", "maxims.json"),
  eventPath: ["hooks", "sessionStart"],
  grouped: false,
  wrapper: { version: 1 },
  handler: (spec) => ({
    type: "command",
    bash: [spec.command, ...spec.args].join(" "),
    timeoutSec: spec.timeoutSeconds,
  }),
  commandKey: "bash",
  async: false,
});

const oursJson = `{ "type": "command", "command": "${HOOK_COMMAND}", "async": true, "timeout": 20 }`;
const theirsJson = `{ "type": "command", "command": "python3 /home/user/notes.py", "timeout": 30 }`;

function plan(def: HarnessWithHook<"registry">, wanted: boolean, currentText: string | null) {
  return planHookRegistryWrite({ def, scope: "project", ctx, wanted, currentText });
}

function textOf(result: ReturnType<typeof plan>): string {
  const [change] = result.changes;
  if (change?.kind !== "write") throw new Error(`expected a write, got ${JSON.stringify(result)}`);
  return change.content;
}

describe("planHookRegistryWrite on JSON registries", () => {
  test("a missing file becomes a two-space file holding only the event and our group", () => {
    const result = plan(grouped, true, null);
    expect(result.notice).toBe(`registered the maxims hook in ${settingsPath}`);
    expect(textOf(result)).toBe(
      [
        "{",
        '  "hooks": {',
        '    "SessionStart": [',
        "      {",
        '        "hooks": [',
        "          {",
        '            "type": "command",',
        `            "command": "${HOOK_COMMAND}",`,
        '            "async": true,',
        '            "timeout": 20',
        "          }",
        "        ]",
        "      }",
        "    ]",
        "  }",
        "}",
        "",
      ].join("\n"),
    );
  });

  test("a missing ungrouped file gains the wrapper keys and the handler directly in the event", () => {
    expect(textOf(plan(flat, true, null))).toBe(
      [
        "{",
        '  "version": 1,',
        '  "hooks": {',
        '    "sessionStart": [',
        "      {",
        '        "type": "command",',
        `        "bash": "${HOOK_COMMAND}",`,
        '        "timeoutSec": 20',
        "      }",
        "    ]",
        "  }",
        "}",
        "",
      ].join("\n"),
    );
  });

  const untouched = [
    "// hand-maintained; keep the odd spacing",
    "{",
    '  "model":   "opus",',
    '\t"hooks": {',
    '    "SessionStart": [ { "matcher": "startup|resume",',
    `        "hooks": [ ${theirsJson} ] } ],`,
    '    "PreToolUse": [{ "matcher": "Bash", "hooks": [{ "type": "command", "command": "/home/user/guard.sh" }] }]',
    "  },",
    '  "permissions": { "allow": ["Bash(git status)",], },',
    "}",
    "",
  ].join("\n");

  test("add then remove hands a hand-formatted file back byte-identical; a second add is a no-op", () => {
    const added = textOf(plan(grouped, true, untouched));
    expect(added).toContain(theirsJson);
    expect(added).toContain('"permissions": { "allow": ["Bash(git status)",], },');
    const parsed = parse(added, [], { allowTrailingComma: true });
    expect(parsed.hooks.SessionStart).toHaveLength(2);
    expect(parsed.hooks.SessionStart[1]).toEqual({
      hooks: [grouped.hook.handler(hookSpecFor(grouped))],
    });
    expect(plan(grouped, true, added)).toEqual({ changes: [] });
    expect(plan(grouped, false, added)).toEqual({
      changes: [{ kind: "write", path: settingsPath, content: untouched }],
      notice: `removed the maxims hook from ${settingsPath}`,
    });
    expect(plan(grouped, false, untouched)).toEqual({ changes: [] });
  });

  test("an entry with an outdated command is rewritten in place inside the user's matcher group", () => {
    const stale = [
      "{",
      '  "hooks": {',
      '    "SessionStart": [',
      '      { "matcher": "startup", "hooks": [',
      '        { "type": "command", "command": "npx -y @vivswan/maxims sync --quiet --agent claude", "async": false }',
      "      ] }",
      "    ]",
      "  }",
      "}",
      "",
    ].join("\n");
    const result = plan(grouped, true, stale);
    expect(result.notice).toBe(`updated the maxims hook in ${settingsPath}`);
    const parsed = parse(textOf(result));
    expect(parsed).toEqual({
      hooks: {
        SessionStart: [{ matcher: "startup", hooks: [grouped.hook.handler(hookSpecFor(grouped))] }],
      },
    });
  });

  const pruning: { name: string; before: string; after: unknown }[] = [
    {
      name: "only our handler leaves a shared group; the neighbour and its matcher stay",
      before: `{"model":"opus","hooks":{"SessionStart":[{"matcher":"startup","hooks":[${theirsJson}, ${oursJson}]}]}}`,
      after: {
        model: "opus",
        hooks: { SessionStart: [{ matcher: "startup", hooks: [parse(theirsJson)] }] },
      },
    },
    {
      name: "our own group is pruned when it empties; other groups stay",
      before: `{"hooks":{"SessionStart":[{"hooks":[${oursJson}]},{"matcher":"resume","hooks":[${theirsJson}]}]}}`,
      after: { hooks: { SessionStart: [{ matcher: "resume", hooks: [parse(theirsJson)] }] } },
    },
    {
      name: "a matcher group emptied of handlers is pruned whole, not left as a bare matcher",
      before: `{"hooks":{"SessionStart":[{"matcher":"startup","hooks":[${oursJson}]},{"hooks":[${theirsJson}]}]}}`,
      after: { hooks: { SessionStart: [{ hooks: [parse(theirsJson)] }] } },
    },
    {
      name: "the event is pruned when its last group empties; other events stay",
      before: `{"hooks":{"SessionStart":[{"hooks":[${oursJson}]}],"Stop":[{"hooks":[${theirsJson}]}]}}`,
      after: { hooks: { Stop: [{ hooks: [parse(theirsJson)] }] } },
    },
    {
      name: "the object holding the events stays, emptied, when its last event goes",
      before: `{"model":"opus","hooks":{"SessionStart":[{"hooks":[${oursJson}]}]}}`,
      after: { model: "opus", hooks: {} },
    },
  ];

  test.each(pruning)("removal: $name", ({ before, after }) => {
    expect(parse(textOf(plan(grouped, false, before)))).toEqual(after);
  });

  const emptied: { name: string; before: string; after: string }[] = [
    {
      name: "a file that held nothing but our entry keeps an empty object, never deleted",
      before: `{"hooks":{"SessionStart":[{"hooks":[${oursJson}]}]}}`,
      after: "{}",
    },
    {
      name: "a pre-existing empty object comes back with its line ending",
      before: "{}\n",
      after: "{}\n",
    },
    { name: "a pre-existing CRLF empty object keeps CRLF", before: "{}\r\n", after: "{}\r\n" },
    {
      name: "a pre-existing empty event list collapses to an empty object",
      before: `{"hooks":{"SessionStart":[]}}\n`,
      after: "{}\n",
    },
  ];

  test.each(emptied)("add then remove: $name", ({ before, after }) => {
    const added = before.includes(HOOK_COMMAND) ? before : textOf(plan(grouped, true, before));
    expect(plan(grouped, false, added)).toEqual({
      changes: [{ kind: "write", path: settingsPath, content: after }],
      notice: `removed the maxims hook from ${settingsPath}`,
    });
  });

  test("an ungrouped registry finds, keeps and prunes the handler directly in the event list", () => {
    const shared = `{"version":1,"hooks":{"sessionStart":[${theirsJson}, ${flatOurs}]}}`;
    expect(plan(flat, true, shared)).toEqual({ changes: [] });
    expect(parse(textOf(plan(flat, false, shared)))).toEqual({
      version: 1,
      hooks: { sessionStart: [parse(theirsJson)] },
    });
    const alone = `{"version":1,"hooks":{"sessionStart":[${flatOurs}]}}`;
    expect(plan(flat, false, alone).changes).toEqual([
      { kind: "write", path: rooted(`${projectRoot}/.github/hooks/maxims.json`), content: "{}" },
    ]);
  });

  const commands: { command: string; ours: boolean }[] = [
    { command: "npx -y @vivswan/maxims sync --quiet", ours: true },
    { command: "npx -y @vivswan/maxims sync", ours: true },
    { command: "npx -y @vivswan/maxims sync\t--quiet --agent x", ours: true },
    { command: "npx -y @vivswan/maxims syncthing", ours: false },
    { command: "npx -y @vivswan/maxims sync-all", ours: false },
    { command: "echo npx -y @vivswan/maxims sync", ours: false },
  ];

  test.each(commands)(
    "the prefix match on $command is $ours: only ours is pruned",
    ({ command, ours }) => {
      const entry = `{ "type": "command", "command": ${JSON.stringify(command)} }`;
      const before = `{"model":"opus","hooks":{"SessionStart":[{"hooks":[${entry}]}]}}`;
      const result = plan(grouped, false, before);
      if (ours) expect(parse(textOf(result))).toEqual({ model: "opus", hooks: {} });
      else expect(result).toEqual({ changes: [] });
    },
  );

  const flatOurs = `{ "type": "command", "bash": "${HOOK_COMMAND}", "timeoutSec": 20 }`;
  const comments: { name: string; before: string; after: string }[] = [
    {
      name: "ours first keeps the comment introducing the next handler",
      before: `{"hooks":{"sessionStart":[${flatOurs}, /* user */ ${theirsJson}]}}`,
      after: `{"hooks":{"sessionStart":[/* user */ ${theirsJson}]}}`,
    },
    {
      name: "ours in the middle keeps the comments on both neighbours",
      before: `{"hooks":{"sessionStart":[${theirsJson} /* a */, ${flatOurs}, /* b */ ${theirsJson}]}}`,
      after: `{"hooks":{"sessionStart":[${theirsJson} /* a */, /* b */ ${theirsJson}]}}`,
    },
    {
      name: "ours last keeps the trailing comment of the previous handler",
      before: `{"hooks":{"sessionStart":[${theirsJson}, /* c */ ${flatOurs}]}}`,
      after: `{"hooks":{"sessionStart":[${theirsJson} /* c */]}}`,
    },
    {
      name: "a line comment before ours keeps its line break so the next handler stays live",
      before: `{"hooks":{"sessionStart":[${theirsJson}, // keep
${flatOurs},${theirsJson}
]}}`,
      after: `{"hooks":{"sessionStart":[${theirsJson}, // keep
${theirsJson}
]}}`,
    },
    {
      name: "a line comment before ours at the end of the list keeps its line break",
      before: `{"hooks":{"sessionStart":[${theirsJson}, // keep
${flatOurs}
]}}`,
      after: `{"hooks":{"sessionStart":[${theirsJson} // keep
]}}`,
    },
    {
      name: "a line comment before ours with the closing bracket on our line stays terminated",
      before: `{"hooks":{"sessionStart":[${theirsJson}, // keep
${flatOurs} ]}}`,
      after: `{"hooks":{"sessionStart":[${theirsJson} // keep
 ]}}`,
    },
    {
      name: "a comment between ours and its comma stays when ours goes first",
      before: `{"hooks":{"sessionStart":[${flatOurs} /* keep */, ${theirsJson}]}}`,
      after: `{"hooks":{"sessionStart":[ /* keep */ ${theirsJson}]}}`,
    },
  ];

  test.each(comments)("removal: $name", ({ before, after }) => {
    expect(textOf(plan(flat, false, before))).toBe(after);
  });

  const annotated: { before: string; after: string }[] = [
    {
      before: `{"hooks":{"SessionStart":[ /* keep */ ]}}`,
      after: `{"hooks":{"SessionStart":[ /* keep */ ]}}`,
    },
    {
      before: `{"hooks":{"SessionStart":[\n/* keep */\n]}}`,
      after: `{"hooks":{"SessionStart":[\n/* keep */\n]}}`,
    },
    {
      before: `{"model":"opus","hooks": /* keep */ {}}`,
      after: `{"model":"opus","hooks": /* keep */ {}}`,
    },
    { before: `{"hooks":{/* keep */}}`, after: `{"hooks":{/* keep */}}` },
    { before: `{\n  // keep\n  "hooks": {}\n}\n`, after: `{\n  // keep\n  "hooks": {}\n}\n` },
    { before: `{/* keep */}`, after: `{/* keep */\n  "hooks": {}\n}` },
    { before: `// keep\n{}\n`, after: `// keep\n{\n  "hooks": {}\n}\n` },
    {
      before: `{"hooks":{"SessionStart":[\n// keep\n]}}`,
      after: `{"hooks":{"SessionStart":[\n// keep\n]}}`,
    },
    {
      before: `{"url":"https://example.com","hooks":{"SessionStart":[/* keep */]}}`,
      after: `{"url":"https://example.com","hooks":{"SessionStart":[/* keep */]}}`,
    },
    {
      before: `{ "$schema": "https://json.schemastore.org/x.json", "hooks": { /* keep */ } }`,
      after: `{ "$schema": "https://json.schemastore.org/x.json", "hooks": { /* keep */ } }`,
    },
  ];

  test.each(annotated)("add then remove of %j keeps the user's comment", ({ before, after }) => {
    const added = textOf(plan(grouped, true, before));
    expect(added).toContain("keep");
    expect(parse(added, [], { allowTrailingComma: true }).hooks.SessionStart).toEqual([
      { hooks: [grouped.hook.handler(hookSpecFor(grouped))] },
    ]);
    expect(textOf(plan(grouped, false, added))).toBe(after);
  });

  test("a comment between an event key and its list pins the list; it is emptied, not cut", () => {
    const before = `{"hooks":{"SessionStart": /* keep */ [{"hooks":[${oursJson}]}]}}`;
    expect(textOf(plan(grouped, false, before))).toBe(`{"hooks":{"SessionStart": /* keep */ []}}`);
  });

  test("a comment inside a group's matcher pins the group; only its hooks list is emptied", () => {
    const before = `{"model":"opus","hooks":{"SessionStart":[{"matcher":/* keep */"startup","hooks":[${oursJson}]}]}}`;
    expect(textOf(plan(grouped, false, before))).toBe(
      `{"model":"opus","hooks":{"SessionStart":[{"matcher":/* keep */"startup","hooks":[]}]}}`,
    );
  });

  test("a trailing comma after ours and a comment goes with ours; the comment stays", () => {
    const before = `{"hooks":{"SessionStart":[{"hooks":[${oursJson} /* keep */,]}]}}`;
    expect(textOf(plan(grouped, false, before))).toBe(
      `{"hooks":{"SessionStart":[{"hooks":[ /* keep */]}]}}`,
    );
  });

  test("a group annotated by the user keeps its comment; only its hooks list is emptied", () => {
    const before = `{"hooks":{"SessionStart":[{"matcher":"x", /* keep */ "hooks":[${oursJson}]}]}}`;
    expect(textOf(plan(grouped, false, before))).toBe(
      `{"hooks":{"SessionStart":[{"matcher":"x", /* keep */ "hooks":[]}]}}`,
    );
  });

  test("two copies of our handler converge to one on add and to none on remove", () => {
    const twice = `{"model":"opus","hooks":{"SessionStart":[{"hooks":[${oursJson}]},{"matcher":"resume","hooks":[${theirsJson}, ${oursJson}]}]}}`;
    const converged = plan(grouped, true, twice);
    expect(converged.notice).toBe(`removed duplicate maxims hooks from ${settingsPath}`);
    expect(parse(textOf(converged))).toEqual({
      model: "opus",
      hooks: {
        SessionStart: [
          { hooks: [grouped.hook.handler(hookSpecFor(grouped))] },
          { matcher: "resume", hooks: [parse(theirsJson)] },
        ],
      },
    });
    expect(parse(textOf(plan(grouped, false, twice)))).toEqual({
      model: "opus",
      hooks: { SessionStart: [{ matcher: "resume", hooks: [parse(theirsJson)] }] },
    });
  });

  test("a CRLF file gains CRLF-only lines", () => {
    const added = textOf(plan(grouped, true, '{\r\n  "model": "opus"\r\n}\r\n'));
    expect(added.includes("\r\n")).toBe(true);
    expect(added.replaceAll("\r\n", "").includes("\n")).toBe(false);
    expect(added.endsWith("\r\n")).toBe(true);
  });

  const refusals: { name: string; text: string; wanted: boolean }[] = [
    { name: "a truncated file", text: '{ "hooks": { "SessionStart": [', wanted: true },
    { name: "a truncated file on removal", text: "{ bad", wanted: false },
    { name: "an empty file", text: "", wanted: true },
    { name: "a top-level array", text: "[]", wanted: true },
    { name: "an event that is an object", text: '{"hooks":{"SessionStart":{}}}', wanted: true },
    { name: "an event object on removal", text: '{"hooks":{"SessionStart":{}}}', wanted: false },
    { name: "a hooks key that is a list", text: '{"hooks":[]}', wanted: true },
  ];

  test.each(refusals)("refuses to rewrite $name", ({ text, wanted }) => {
    let caught: unknown;
    try {
      plan(grouped, wanted, text);
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(MaximsError);
    if (caught instanceof MaximsError) expect(caught.code).toBe(ExitCode.DestinationWriteFailed);
  });

  test("a TOML registry is never written", () => {
    let caught: unknown;
    try {
      plan(registryDef({ format: "toml" }), true, null);
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(MaximsError);
    if (caught instanceof MaximsError) expect(caught.code).toBe(ExitCode.DestinationWriteFailed);
  });
});

describe("planFileHookWrite", () => {
  const fileDef: HarnessWithHook<"file"> = {
    ...base,
    hook: {
      kind: "file",
      path: (_, ctx) => join(ctx.projectRoot ?? "", ".clinerules", "hooks", "TaskStart"),
      render: (spec) => `#!/bin/sh\n${[spec.command, ...spec.args].join(" ")}\n`,
      executable: true,
      stdout: "none",
    },
  };
  const path = rooted(`${projectRoot}/.clinerules/hooks/TaskStart`);
  const rendered = `#!/bin/sh\n${HOOK_COMMAND}\n`;
  const executable: Change = { kind: "write", path, content: rendered, mode: 0o755 };
  const cases: {
    name: string;
    wanted: boolean;
    current: { text: string; mode: number } | null;
    changes: Change[];
  }[] = [
    {
      name: "written executable when wanted and absent",
      wanted: true,
      current: null,
      changes: [executable],
    },
    {
      name: "rewritten when the artifact drifted",
      wanted: true,
      current: { text: "#!/bin/sh\nold\n", mode: 0o755 },
      changes: [executable],
    },
    {
      name: "made executable again when only the mode drifted",
      wanted: true,
      current: { text: rendered, mode: 0o644 },
      changes: [executable],
    },
    {
      name: "left alone when identical",
      wanted: true,
      current: { text: rendered, mode: 0o755 },
      changes: [],
    },
    {
      name: "deleted when unwanted",
      wanted: false,
      current: { text: rendered, mode: 0o755 },
      changes: [{ kind: "delete", path }],
    },
    { name: "nothing to delete when absent", wanted: false, current: null, changes: [] },
  ];
  test.each(cases)("$name", ({ wanted, current, changes }) => {
    const result = planFileHookWrite({ def: fileDef, scope: "project", ctx, wanted, current });
    expect(result.changes).toEqual(changes);
  });

  test.skipIf(process.platform === "win32")(
    "a hook whose execute bit was stripped is repaired through applyChanges (mode bits are POSIX)",
    async () => {
      await withTempDir(async (root) => {
        const local: HarnessContext = { ...ctx, projectRoot: root };
        const file = join(root, ".clinerules", "hooks", "TaskStart");
        mkdirSync(join(root, ".clinerules", "hooks"), { recursive: true });
        writeFileSync(file, rendered, { mode: 0o644 });
        const repair = await planHookWrite({
          def: fileDef,
          scope: "project",
          ctx: local,
          wanted: true,
        });
        expect(repair.changes).toHaveLength(1);
        await applyChanges({ changes: repair.changes, notices: [] }, { dryRun: false });
        expect(statSync(file).mode & 0o7777).toBe(0o755);
        expect(readFileSync(file, "utf8")).toBe(rendered);
        const again = await planHookWrite({
          def: fileDef,
          scope: "project",
          ctx: local,
          wanted: true,
        });
        expect(again.changes).toEqual([]);
      });
    },
  );
});

describe("planHookWrite against a real directory", () => {
  test("registers, converges, and unregisters through applyChanges", async () => {
    await withTempDir(async (root) => {
      const local: HarnessContext = { ...ctx, projectRoot: root };
      const file = join(root, ".claude", "settings.json");
      mkdirSync(join(root, ".claude"), { recursive: true });
      const original = `{\n  "model": "opus",\n  "hooks": {\n    "SessionStart": [ { "hooks": [ ${theirsJson} ] } ]\n  }\n}\n`;
      writeFileSync(file, original);
      const first = await planHookWrite({
        def: grouped,
        scope: "project",
        ctx: local,
        wanted: true,
      });
      await applyChanges({ changes: first.changes, notices: [] }, { dryRun: false });
      expect(readFileSync(file, "utf8")).toContain(HOOK_COMMAND);
      const again = await planHookWrite({
        def: grouped,
        scope: "project",
        ctx: local,
        wanted: true,
      });
      expect(again.changes).toEqual([]);
      const gone = await planHookWrite({
        def: grouped,
        scope: "project",
        ctx: local,
        wanted: false,
      });
      await applyChanges({ changes: gone.changes, notices: [] }, { dryRun: false });
      expect(readFileSync(file, "utf8")).toBe(original);
    });
  });

  test("a directory at the registry path is refused as exit 4", async () => {
    await withTempDir(async (root) => {
      const local: HarnessContext = { ...ctx, projectRoot: root };
      mkdirSync(join(root, ".claude", "settings.json"), { recursive: true });
      let caught: unknown;
      try {
        await planHookWrite({ def: grouped, scope: "project", ctx: local, wanted: true });
      } catch (error) {
        caught = error;
      }
      expect(caught).toBeInstanceOf(MaximsError);
      if (caught instanceof MaximsError) expect(caught.code).toBe(ExitCode.DestinationWriteFailed);
    });
  });
});

describe("planHookWrite composes the hook with the definition's config edit", () => {
  const hookFile = rooted(`${projectRoot}/.example/hook`);
  const configFile = rooted(`${projectRoot}/example.json`);
  const seen: { scope: Scope; wanted: boolean; command: string }[] = [];
  const def: HarnessDefinition = {
    ...base,
    hook: {
      kind: "custom",
      reconcile: async (scope, _ctx, spec, wanted) => {
        seen.push({ scope, wanted, command: [spec.command, ...spec.args].join(" ") });
        return wanted ? [{ kind: "write", path: hookFile, content: "hook\n" }] : [];
      },
    },
    configEdit: async (_scope, _ctx, wanted) =>
      wanted
        ? [{ kind: "write", path: configFile, content: "{}\n" }]
        : [{ kind: "delete", path: configFile }],
  };

  test("both wanted: the custom hook sees the scope and the command; the config edit follows", async () => {
    const plan = await planHookWrite({ def, scope: "global", ctx, wanted: true });
    expect(plan.changes).toEqual([
      { kind: "write", path: hookFile, content: "hook\n" },
      { kind: "write", path: configFile, content: "{}\n" },
    ]);
    expect(seen).toEqual([{ scope: "global", wanted: true, command: HOOK_COMMAND }]);
  });

  test("both unwanted: the config edit's removal is still planned", async () => {
    const plan = await planHookWrite({ def, scope: "project", ctx, wanted: false });
    expect(plan.changes).toEqual([{ kind: "delete", path: configFile }]);
    expect(seen.at(-1)).toEqual({ scope: "project", wanted: false, command: HOOK_COMMAND });
  });
});

describe("achievedTier", () => {
  const codexLike = registryDef({
    path: (_, ctx) => join(ctx.home, ".codex", "hooks.json"),
    tierCheck: {
      path: (_, ctx) => join(ctx.home, ".codex", "config.toml"),
      format: "toml",
      key: "features.hooks",
      demotesWhen: false,
    },
  });
  const cases: { name: string; config: string | null; tier: 1 | 2 }[] = [
    { name: "no config file keeps the declared tier", config: null, tier: 1 },
    {
      name: "the flag set to false demotes to tier 2",
      config: "[features]\nhooks = false\n",
      tier: 2,
    },
    { name: "the flag set to true keeps tier 1", config: "[features]\nhooks = true\n", tier: 1 },
    { name: "an absent key means the default, tier 1", config: "[features]\nother = 1\n", tier: 1 },
    {
      name: "a value other than the demoting one keeps the declared tier",
      config: '[features]\nhooks = "off"\n',
      tier: 1,
    },
    {
      name: "an unparseable config keeps the declared tier",
      config: "[features\nhooks =",
      tier: 1,
    },
  ];
  test.each(cases)("$name", async ({ config, tier }) => {
    await withTempDir(async (home) => {
      const local: HarnessContext = { home, projectRoot: null, env: {} };
      if (config !== null) {
        mkdirSync(join(home, ".codex"), { recursive: true });
        writeFileSync(join(home, ".codex", "config.toml"), config);
      }
      expect(await achievedTier(codexLike, "global", local)).toBe(tier);
    });
  });

  test("a JSON tier check and a definition's own probe are honoured", async () => {
    await withTempDir(async (home) => {
      const local: HarnessContext = { home, projectRoot: null, env: {} };
      const jsonCheck = registryDef({
        path: (_, ctx) => join(ctx.home, ".example", "hooks.json"),
        tierCheck: {
          path: (_, ctx) => join(ctx.home, ".example", "settings.json"),
          format: "json",
          key: "hooks.enabled",
          demotesWhen: false,
        },
      });
      mkdirSync(join(home, ".example"), { recursive: true });
      writeFileSync(join(home, ".example", "settings.json"), '{ "hooks": { "enabled": false } }');
      expect(await achievedTier(jsonCheck, "global", local)).toBe(2);
      writeFileSync(join(home, ".example", "settings.json"), '{ "hooks": { "enabled": false }');
      expect(await achievedTier(jsonCheck, "global", local)).toBe(1);
      writeFileSync(join(home, ".example", "settings.json"), '{ "hooks": { "enabled": false } }');
      const probed: HarnessDefinition = { ...jsonCheck, achievedTier: async () => 1 };
      expect(await achievedTier(probed, "global", local)).toBe(1);
      expect(await achievedTier({ ...base, hook: { kind: "none" } }, "global", local)).toBe(1);
    });
  });
});
