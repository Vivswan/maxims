// Guards the refusals the schema owes a hand-written harnesses.json or a new built-in folder: an
// unknown or misspelled key, a path that would escape its root, a template that could never run
// the hook, a file name the slug cannot reach, and a precedence list that omits its own default
// would each compile into a definition that writes to the wrong place or writes nothing, and the
// refusal must name the field so the author can find it.
import { expect, test } from "bun:test";
import { parseHarnessSpec } from "./spec.ts";

function base(): Record<string, unknown> {
  return {
    id: "example",
    displayName: "Example",
    tier: 1,
    verifiedAgainst: { url: "https://example.com/docs/hooks", date: "2026-09-20" },
    globalRoot: { default: "~/.example", env: { name: "EXAMPLE_HOME" } },
    targets: {
      project: {
        kind: "rules-dir",
        dir: ".example/rules",
        fileName: "maxims-{{slug}}.md",
        frontmatter: { always: { alwaysApply: true } },
      },
      global: { kind: "shared-block", file: "AGENTS.md", precedence: ["RULES.md", "AGENTS.md"] },
    },
    bodiesDir: { project: ".agents/memories", global: null },
    markers: "counted",
    expands: [],
    detect: { dirs: ["."] },
    hook: {
      kind: "registry",
      path: { project: ".example/hooks.json", global: "hooks.json" },
      format: "json",
      eventPath: ["hooks", "SessionStart"],
      grouped: true,
      handlerTemplate: { type: "command", command: "{{command}}", timeout: "{{timeoutSeconds}}" },
      commandKey: "command",
      stdout: "plain",
      async: false,
    },
    fixtures: { config: "hooks.json" },
  };
}

type Mutation = (spec: Record<string, unknown>) => Record<string, unknown>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function at(path: string[], value: unknown): Mutation {
  return (spec) => {
    const copy = structuredClone(spec);
    let cursor: Record<string, unknown> = copy;
    for (const key of path.slice(0, -1)) {
      const next = cursor[key];
      if (!isRecord(next)) throw new Error(`no object at ${key}`);
      cursor = next;
    }
    const last = path[path.length - 1];
    if (last === undefined) throw new Error("a path needs a key");
    if (value === undefined) delete cursor[last];
    else cursor[last] = value;
    return copy;
  };
}

const refusals: [string, Mutation, string][] = [
  ["an unknown top-level key", at(["extra"], 1), 'Unrecognized key: "extra"'],
  [
    "an unknown key inside a target",
    at(["targets", "project", "bogus"], true),
    'targets.project: Unrecognized key: "bogus"',
  ],
  ["an id with capitals", at(["id"], "Example"), "id: expected a kebab-case harness id"],
  [
    "an absolute target file",
    at(["targets", "global", "file"], "/etc/AGENTS.md"),
    "targets.global.file: expected a path relative to the scope root",
  ],
  [
    "a rules directory that climbs out",
    at(["targets", "project", "dir"], "../rules"),
    "targets.project.dir: a path cannot contain ..",
  ],
  [
    "a file name without the slug",
    at(["targets", "project", "fileName"], "maxims.md"),
    "targets.project.fileName: expected the file name to contain {{slug}}",
  ],
  [
    "a file name using a hook placeholder",
    at(["targets", "project", "fileName"], "{{slug}}-{{command}}.md"),
    "targets.project.fileName: a file name may only use {{slug}}",
  ],
  [
    "a precedence list that omits the default file",
    at(["targets", "global", "precedence"], ["RULES.md"]),
    "targets.global.precedence: must include the default file AGENTS.md",
  ],
  [
    "no target in either scope",
    (spec) => at(["targets", "global"], null)(at(["targets", "project"], null)(spec)),
    "targets: at least one scope needs a target",
  ],
  [
    "an absolute global root",
    at(["globalRoot", "default"], "/opt/example"),
    "globalRoot.default: expected a path relative to HOME, with or without a leading ~/",
  ],
  [
    "nothing to detect",
    at(["detect"], { dirs: [] }),
    "detect.dirs: detection needs at least one directory or environment variable",
  ],
  [
    "a handler whose command key never runs the hook",
    at(["hook", "handlerTemplate", "command"], "maxims sync"),
    "hook.handlerTemplate.command: the command key must hold a string starting with {{command}}",
  ],
  [
    "a handler whose command key wraps the hook in a shell word",
    at(["hook", "handlerTemplate", "command"], "exec {{command}}"),
    "hook.handlerTemplate.command: the command key must hold a string starting with {{command}}",
  ],
  [
    "a handler with an unknown placeholder",
    at(["hook", "handlerTemplate", "timeout"], "{{timeout}}"),
    "hook.handlerTemplate: unknown placeholder {{timeout}}; known: command, argv, async, timeoutSeconds, timeoutMs",
  ],
  [
    "a handler with a misspelled placeholder outside the letters",
    at(["hook", "handlerTemplate", "timeout"], "{{timeout_ms}}"),
    "hook.handlerTemplate: unknown placeholder {{timeout_ms}}",
  ],
  [
    "a file name carrying a NUL",
    at(["targets", "project", "fileName"], "maxims-{{slug}}\0.md"),
    "targets.project.fileName: a file name cannot contain NUL",
  ],
  [
    "a file hook that never runs the hook",
    at(["hook"], {
      kind: "file",
      path: { project: ".example/hook.sh", global: "hook.sh" },
      contentTemplate: "#!/bin/sh\necho hi\n",
      executable: true,
      stdout: "none",
    }),
    "hook.contentTemplate: the file must run the hook: use {{command}} or {{argv}}",
  ],
  [
    "a content hash that is not a sha256 digest",
    at(["verifiedAgainst", "contentHash"], "abc123"),
    "verifiedAgainst.contentHash: expected a sha256:<64 hex digits> digest",
  ],
  [
    "a fixture name with a path",
    at(["fixtures", "config"], "../hooks.json"),
    "fixtures.config: expected a file name inside fixtures/",
  ],
];

test("the base spec parses", () => {
  expect(parseHarnessSpec(base())).toMatchObject({ ok: true });
});

test.each(refusals)("refuses %s and names the field", (_, mutate, expected) => {
  const result = parseHarnessSpec(mutate(base()));
  if (result.ok) throw new Error("expected a refusal");
  expect(result.issues.some((issue) => issue.startsWith(expected))).toBe(true);
});
