// Guards the boundary of `$MAXIMS_HOME/harnesses.json`: a missing file is an empty list; a file
// that cannot be read or parsed, an entry that fails the schema, an id that collides with a
// built-in, or an id declared twice each stop the load with exit 4 and a message naming the file,
// the entry and the field; and what loads carries `userDefined` so `list` can label it. A loader
// that dropped a bad entry and went on would leave a harness the user declared silently unsynced.
import { expect, test } from "bun:test";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { loadUserDefinedHarnesses } from "../../src/harnesses/user-defined.ts";
import { ExitCode } from "../../src/util/exit-codes.ts";
import { srcPath } from "../shared/src_path.ts";
import { withTempDir } from "../shared/temp_dir.ts";

// The file name is the contract users write to, so the tests spell it out rather than asking the
// loader where it looks.
const fileIn = (home: string): string => join(home, "harnesses.json");

function acme(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "acme",
    displayName: "Acme Agent",
    tier: 1,
    verifiedAgainst: {
      date: "2026-09-20",
      sources: [
        {
          kind: "page",
          url: "https://example.com/acme/docs/hooks",
          claims: ["hooks"],
          why: "a fixture",
        },
      ],
    },
    globalRoot: { default: ".acme", env: { name: "ACME_HOME" } },
    targets: {
      project: { kind: "shared-block", file: "AGENTS.md" },
      global: { kind: "shared-block", file: "AGENTS.md" },
    },
    bodiesDir: { project: ".agents/memories", global: null },
    markers: "counted",
    expands: [],
    detect: { dirs: ["."] },
    hook: {
      kind: "registry",
      path: { project: ".acme/hooks.json", global: "hooks.json" },
      format: "json",
      eventPath: ["hooks", "SessionStart"],
      grouped: true,
      handlerTemplate: { type: "command", command: "{{command}}", timeout: "{{timeoutSeconds}}" },
      commandKey: "command",
      stdout: "plain",
      async: false,
    },
    ...overrides,
  };
}

async function load(home: string, content: string) {
  writeFileSync(fileIn(home), content);
  return loadUserDefinedHarnesses(home);
}

function refusalNaming(home: string, expected: string): RegExp {
  return new RegExp(`^${RegExp.escape(`${fileIn(home)}: `)}.*${RegExp.escape(expected)}`, "s");
}

test("no file means no user-defined harnesses", async () => {
  await withTempDir(async (home) => {
    await expect(loadUserDefinedHarnesses(home)).resolves.toEqual([]);
  });
});

test("a declared harness compiles under its own global root and is labelled user-defined", async () => {
  await withTempDir(async (home) => {
    const [def, ...rest] = await load(home, JSON.stringify({ harnesses: [acme()] }));
    expect(rest).toEqual([]);
    if (def === undefined || def.hook.kind !== "registry") throw new Error("expected a registry");
    expect(def.userDefined).toBe(true);
    expect(String(def.id)).toBe("acme");
    const ctx = {
      home: resolve("/home/user"),
      projectRoot: resolve("/home/user/project"),
      cwd: resolve("/home/user/project"),
      env: {},
    };
    expect(def.hook.path("global", ctx)).toBe(resolve("/home/user/.acme/hooks.json"));
    expect(def.hook.path("project", ctx)).toBe(resolve("/home/user/project/.acme/hooks.json"));
    expect(def.detect({ ...ctx, env: { ACME_HOME: home } })).toBe(true);
  });
});

const refusals: [string, string, string][] = [
  ["malformed JSON", "{", "not valid JSON"],
  ["a bare array instead of the object", JSON.stringify([acme()]), 'expected {"harnesses": [...]}'],
  ["an entry that is not an object", JSON.stringify({ harnesses: [42] }), "harnesses[0]: "],
  [
    "an entry with a built-in-only key",
    JSON.stringify({ harnesses: [acme({ fixtures: { config: "hooks.json" } })] }),
    'harnesses[0] (id "acme"): Unrecognized key: "fixtures"',
  ],
  [
    "an entry with a path outside its root",
    JSON.stringify({
      harnesses: [
        acme({
          targets: { project: { kind: "shared-block", file: "/etc/AGENTS.md" }, global: null },
        }),
      ],
    }),
    'harnesses[0] (id "acme"): targets.project.file: expected a path relative to the scope root',
  ],
  [
    "an id that is a built-in harness",
    JSON.stringify({ harnesses: [acme({ id: "codex" })] }),
    'harnesses[0] (id "codex"): id: "codex" is a built-in harness id',
  ],
  [
    "an id declared twice",
    JSON.stringify({ harnesses: [acme(), acme({ displayName: "Acme again" })] }),
    'harnesses[1] (id "acme"): "acme" is declared twice',
  ],
];

test.each(refusals)(
  "refuses %s with exit 4 naming the file and the entry",
  async (_, content, expected) => {
    await withTempDir(async (home) => {
      await expect(load(home, content)).rejects.toMatchObject({
        name: "MaximsError",
        code: ExitCode.DestinationWriteFailed,
        message: expect.stringMatching(refusalNaming(home, expected)),
      });
    });
  },
);

// The file has no migration ladder, so an entry in a pre-stable shape is refused by name rather
// than repaired or dropped. The exact message is the pin: a loader that grew a silent repair, or a
// schema that stopped being strict, changes it. The `path` tier check named one file per scope; a
// loader that read it as one layer per scope would silently probe the wrong files. A tier check
// without `unreadable` never said what its harness does with a broken layer; a default would
// decide that for it. A JSON `format` of its own let a tier check read the registry file in a
// dialect the hook writer did not, so the writer kept a construct the probe called unreadable. A
// path with a trailing separator was a second spelling of the registry file, which the check that
// keeps a TOML layer off that file compared as text and missed.
const oldShapes: [string, string, string][] = [
  [
    "verifiedAgainst.pages",
    "corrupt-verified-against-pages.json",
    "verifiedAgainst.sources: Invalid input: expected tuple, received undefined; " +
      'verifiedAgainst: Unrecognized key: "pages"',
  ],
  [
    "tierCheck.path",
    "corrupt-tier-check-path.json",
    "hook.tierCheck.layers: Invalid input: expected object, received undefined; " +
      'hook.tierCheck.unreadable: Invalid option: expected one of "skips-the-file"|"refuses-to-start"; ' +
      'hook.tierCheck: Unrecognized key: "path"',
  ],
  [
    "tierCheck without unreadable",
    "corrupt-tier-check-without-unreadable.json",
    'hook.tierCheck.unreadable: Invalid option: expected one of "skips-the-file"|"refuses-to-start"',
  ],
  [
    "tierCheck with a JSON format",
    "corrupt-tier-check-json-format.json",
    "hook.tierCheck.format: a tier check in a JSON dialect reads as hook.format and declares no format; remove tierCheck.format, or write toml for a TOML config",
  ],
  [
    "hook.path with a trailing separator",
    "corrupt-hook-path-trailing-separator.json",
    "hook.path.project: a path has no leading, trailing or doubled / and no . segment; write .acme/settings.json",
  ],
];

test.each(oldShapes)(
  "an entry in the old %s shape is refused naming what it lacks",
  async (_, fixtureName, expected) => {
    await withTempDir(async (home) => {
      const fixture = srcPath("harnesses", "fixtures", fixtureName);
      await expect(load(home, readFileSync(fixture, "utf8"))).rejects.toMatchObject({
        name: "MaximsError",
        code: ExitCode.DestinationWriteFailed,
        message: `${fileIn(home)}: harnesses[0] (id "acme"): ${expected}`,
      });
    });
  },
);

// Only "no file" reads as empty; a file that exists but cannot be read must not pass for an
// empty list, or a permissions slip would silently drop every user-defined harness.
test("a file that cannot be read is refused rather than read as empty", async () => {
  await withTempDir(async (home) => {
    mkdirSync(fileIn(home));
    await expect(loadUserDefinedHarnesses(home)).rejects.toMatchObject({
      name: "MaximsError",
      code: ExitCode.DestinationWriteFailed,
      message: expect.stringContaining("cannot read"),
    });
  });
});
