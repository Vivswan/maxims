// Guards the refusals the schema owes a hand-written harnesses.json or a new built-in folder: an
// unknown or misspelled key, a path that would escape its root, a template that could never run
// the hook, a file name the slug cannot reach, a precedence list that omits its own default, and
// an empty-file rule with no list to apply it to would each compile into a definition that writes
// to the wrong place or writes nothing, and the refusal must name the field so the author can find
// it.
import { expect, test } from "bun:test";
import { append, type Json, nil, set, unset } from "@hyperjump/json-pointer";
import { util } from "zod";
import { parseHarnessSpec } from "../../src/harnesses/spec.ts";

function base(): Record<string, unknown> {
  return {
    id: "example",
    displayName: "Example",
    tier: 1,
    verifiedAgainst: {
      date: "2026-09-20",
      sources: [
        {
          kind: "page",
          url: "https://example.com/docs/hooks",
          claims: ["SessionStart"],
          why: "no schema or repository file names the event",
        },
      ],
    },
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

function at(path: string[], value: unknown): Mutation {
  const pointer = path.reduce((built, segment) => append(segment, built), nil);
  return (spec) => {
    const subject = spec as Json;
    const edited =
      value === undefined ? unset(pointer, subject) : set(pointer, subject, value as Json);
    if (!util.isObject(edited)) throw new Error("the spec stays an object");
    return edited;
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
    "skipsEmpty on a shared block with no precedence list",
    at(["targets", "global"], { kind: "shared-block", file: "AGENTS.md", skipsEmpty: true }),
    "targets.global.skipsEmpty: only a precedence list has empty files to skip",
  ],
  [
    "a scoped frontmatter whose paths key already holds a value",
    at(["targets", "project", "frontmatter", "scoped"], {
      fields: { globs: "**", alwaysApply: false },
      pathsKey: "globs",
      pathsAs: "list",
    }),
    "targets.project.frontmatter.scoped.fields.globs: the paths key holds null where the paths go, or is left out",
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
    "a registry hook in a toml file",
    at(["hook", "format"], "toml"),
    "hook.format: a registry hook is json; toml is read for tierCheck and never written",
  ],
  [
    "a tier check on a key zod would drop from what it parses",
    at(["hook", "tierCheck"], {
      layers: { project: [".example/settings.json"], global: ["settings.json"] },
      format: "json",
      key: "hooks.__proto__",
      demotesWhen: false,
    }),
    "hook.tierCheck.key: a key segment cannot be __proto__",
  ],
  [
    "a per-scope budget that names no scope",
    at(["byteBudget"], {}),
    "byteBudget: a per-scope budget names at least one scope",
  ],
  [
    "a definition verified against no source",
    at(["verifiedAgainst", "sources"], []),
    "verifiedAgainst.sources.0: Invalid input: expected object, received undefined",
  ],
  [
    "a page without claims",
    at(["verifiedAgainst", "sources", "0", "claims"], undefined),
    "verifiedAgainst.sources.0.claims: Invalid input: expected tuple, received undefined",
  ],
  [
    "a page with an empty claims list",
    at(["verifiedAgainst", "sources", "0", "claims"], []),
    "verifiedAgainst.sources.0.claims.0: Invalid input: expected string, received undefined",
  ],
  [
    "a claim with an edge space",
    at(["verifiedAgainst", "sources", "0", "claims"], ["SessionStart "]),
    "verifiedAgainst.sources.0.claims.0: a claim has no leading or trailing whitespace",
  ],
  [
    "a page without a why",
    at(["verifiedAgainst", "sources", "0", "why"], undefined),
    "verifiedAgainst.sources.0.why: Invalid input: expected string, received undefined",
  ],
  [
    "a page whose why is only whitespace",
    at(["verifiedAgainst", "sources", "0", "why"], "  "),
    "verifiedAgainst.sources.0.why: a page is the last resort: say what programmatic source was looked for",
  ],
  [
    "a schema pointer without its leading slash",
    at(["verifiedAgainst", "sources", "0"], {
      kind: "schema",
      url: "https://example.com/schema.json",
      paths: ["properties/hooks"],
    }),
    "verifiedAgainst.sources.0.paths.0: expected an RFC 6901 JSON pointer",
  ],
  [
    "a schema pointer with an escape RFC 6901 does not define",
    at(["verifiedAgainst", "sources", "0"], {
      kind: "schema",
      url: "https://example.com/schema.json",
      paths: ["/properties/a~2b"],
    }),
    "verifiedAgainst.sources.0.paths.0: expected an RFC 6901 JSON pointer",
  ],
  [
    "a schema pointer whose value is an object the drift check cannot compare",
    at(["verifiedAgainst", "sources", "0"], {
      kind: "schema",
      url: "https://example.com/schema.json",
      paths: [{ pointer: "/properties/hooks", equals: { type: "object" } }],
    }),
    "verifiedAgainst.sources.0.paths.0.equals: Invalid input: expected string, received object",
  ],
  [
    "a repository file whose repo is a URL",
    at(["verifiedAgainst", "sources", "0"], {
      kind: "file",
      repo: "https://github.com/example/agent",
      ref: "main",
      path: "docs/hooks.md",
      claims: ["SessionStart"],
    }),
    "verifiedAgainst.sources.0.repo: expected a GitHub owner/name",
  ],
  [
    "a repository file whose repo would normalize into another path",
    at(["verifiedAgainst", "sources", "0"], {
      kind: "file",
      repo: "../example",
      ref: "main",
      path: "docs/hooks.md",
      claims: ["SessionStart"],
    }),
    "verifiedAgainst.sources.0.repo: a repo has no . or .. segment",
  ],
  [
    "a repository file whose ref would end the URL path early",
    at(["verifiedAgainst", "sources", "0"], {
      kind: "file",
      repo: "example/agent",
      ref: "release#1",
      path: "docs/hooks.md",
      claims: ["SessionStart"],
    }),
    "verifiedAgainst.sources.0.ref: expected a branch, tag, or commit",
  ],
  [
    "a repository file whose ref would normalize into another ref's URL",
    at(["verifiedAgainst", "sources", "0"], {
      kind: "file",
      repo: "example/agent",
      ref: "main/../other",
      path: "docs/hooks.md",
      claims: ["SessionStart"],
    }),
    "verifiedAgainst.sources.0.ref: a ref has no empty, . or .. segment",
  ],
  [
    "a repository file whose path carries a query character",
    at(["verifiedAgainst", "sources", "0"], {
      kind: "file",
      repo: "example/agent",
      ref: "main",
      path: "docs/a?b.md",
      claims: ["SessionStart"],
    }),
    "verifiedAgainst.sources.0.path: a repository path carries only letters, digits, and ._/-",
  ],
  [
    "a repository file whose path has a dot segment",
    at(["verifiedAgainst", "sources", "0"], {
      kind: "file",
      repo: "example/agent",
      ref: "main",
      path: "docs/./hooks.md",
      claims: ["SessionStart"],
    }),
    "verifiedAgainst.sources.0.path: a repository path has no empty or . segment",
  ],
  [
    "a repository file whose path climbs out",
    at(["verifiedAgainst", "sources", "0"], {
      kind: "file",
      repo: "example/agent",
      ref: "main",
      path: "../docs/hooks.md",
      claims: ["SessionStart"],
    }),
    "verifiedAgainst.sources.0.path: a path cannot contain ..",
  ],
  [
    "a source of an unknown kind",
    at(["verifiedAgainst", "sources", "0"], { kind: "hash", url: "https://example.com/docs" }),
    "verifiedAgainst.sources.0.kind: Invalid discriminator value. Expected 'schema' | 'file' | 'page'",
  ],
  [
    "a fixture name with a path",
    at(["fixtures", "config"], "../hooks.json"),
    "fixtures.config: expected a file name inside fixtures/",
  ],
];

// The positive control for the refusal table: the base spec with one source of each kind,
// including the root pointer and a pointer with a value, parses whole. Without it a base that
// stopped parsing, or a schema that refused every `file` or `schema` source, would leave most of
// the refusals above passing for the wrong reason.
test("a definition verified against a schema, a repository file and a page parses whole", () => {
  const sources = [
    {
      kind: "schema",
      url: "https://example.com/settings.schema.json",
      paths: ["", "/properties/hooks", { pointer: "/properties/hooks/type", equals: "object" }],
      note: "the hook event",
    },
    {
      kind: "file",
      repo: "example/agent",
      ref: "main",
      path: "docs/rules.md",
      claims: [".example/rules", "alwaysApply: true"],
    },
    {
      kind: "page",
      url: "https://example.com/docs/limits",
      claims: ["32 KiB"],
      why: "the limit is stated only on the docs page",
      note: "the byte budget",
    },
  ];
  const result = parseHarnessSpec(at(["verifiedAgainst", "sources"], sources)(base()));
  if (!result.ok) throw new Error(result.issues.join("; "));
  expect<unknown>(result.spec.verifiedAgainst).toEqual({ date: "2026-09-20", sources });
});

test.each(refusals)("refuses %s and names the field", (_, mutate, expected) => {
  const result = parseHarnessSpec(mutate(base()));
  if (result.ok) throw new Error("expected a refusal");
  expect(result.issues.some((issue) => issue.startsWith(expected))).toBe(true);
});
