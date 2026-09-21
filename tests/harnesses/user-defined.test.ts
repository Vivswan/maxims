// Guards the boundary of `$MAXIMS_HOME/harnesses.json`: a missing file is an empty list; a file
// that cannot be read or parsed, an entry that fails the schema, an id that collides with a
// built-in, or an id declared twice each stop the load with exit 4 and a message naming the file,
// the entry and the field; and what loads carries `userDefined` so `list` can label it. A loader
// that dropped a bad entry and went on would leave a harness the user declared silently unsynced.
import { expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { loadUserDefinedHarnesses } from "../../src/harnesses/user-defined.ts";
import { ExitCode, MaximsError } from "../../src/util/exit-codes.ts";
import { withTempDir } from "../shared/temp_dir.ts";

// The file name is the contract users write to, so the tests spell it out rather than asking the
// loader where it looks.
const fileIn = (home: string): string => join(home, "harnesses.json");

function acme(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "acme",
    displayName: "Acme Agent",
    tier: 1,
    verifiedAgainst: { url: "https://example.com/acme/docs/hooks", date: "2026-09-20" },
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

async function refusal(home: string, content: string): Promise<MaximsError> {
  try {
    await load(home, content);
  } catch (error) {
    if (error instanceof MaximsError) return error;
    throw error;
  }
  throw new Error("expected the load to be refused");
}

test("no file means no user-defined harnesses", async () => {
  await withTempDir(async (home) => {
    expect(await loadUserDefinedHarnesses(home)).toEqual([]);
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
    'harnesses[0] (id "codex"): "codex" is a built-in harness id',
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
      const error = await refusal(home, content);
      expect(error.code).toBe(ExitCode.DestinationWriteFailed);
      expect(error.message.startsWith(`${fileIn(home)}: `)).toBe(true);
      expect(error.message).toContain(expected);
    });
  },
);

// Only "no file" reads as empty; a file that exists but cannot be read must not pass for an
// empty list, or a permissions slip would silently drop every user-defined harness.
test("a file that cannot be read is refused rather than read as empty", async () => {
  await withTempDir(async (home) => {
    mkdirSync(fileIn(home));
    let caught: unknown;
    try {
      await loadUserDefinedHarnesses(home);
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(MaximsError);
    if (!(caught instanceof MaximsError)) throw new Error("expected a MaximsError");
    expect(caught.code).toBe(ExitCode.DestinationWriteFailed);
    expect(caught.message).toContain("cannot read");
  });
});
