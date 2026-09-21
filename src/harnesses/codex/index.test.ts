// Guards the tier Codex actually reaches: hooks are on by default and only `[features] hooks =
// false` in the project or user config.toml disables them, with the project layer deciding when it
// sets the key at all. Reporting tier 1 on a disabled machine would promise a refresh that never
// fires, and so would passing an unreadable config off as an absent one. Also guards that every
// user-level file follows $CODEX_HOME, that the variable alone never counts as an install, and the
// bytes a fresh hooks.json receives, which Codex reads without checking them for us.
import { expect, test } from "bun:test";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { withTempDir } from "../../../tests/shared/temp_dir.ts";
import { ExitCode, MaximsError } from "../../util/exit-codes.ts";
import { assertInsideRoot } from "../../util/fs.ts";
import { type HarnessContext, scopeRoot } from "../contract.ts";
import { hasHook, planHookRegistryWrite } from "../hook-writer.ts";
import { codex } from "./index.ts";

const fixture = (name: string): string =>
  readFileSync(join(import.meta.dir, "fixtures", name), "utf8");
const disabled = fixture("config-hooks-disabled.toml");
const noFeatures = fixture("config-default.toml");
const enabled = `${noFeatures}\n[features]\nhooks = true\n`;

function achievedTier(ctx: HarnessContext): Promise<1 | 2> {
  if (codex.achievedTier === undefined) throw new Error("Codex probes its config.toml layers");
  return codex.achievedTier(ctx);
}

function hookPath(scope: "project" | "global", ctx: HarnessContext): string {
  if (!hasHook(codex, "registry")) throw new Error("the hook is a registry entry");
  return codex.hook.path(scope, ctx);
}

const layers: [string, string | null, string | null, 1 | 2][] = [
  ["no config at all", null, null, 1],
  ["configs without a features table", noFeatures, noFeatures, 1],
  ["project disables", disabled, null, 2],
  ["user disables, project silent", noFeatures, disabled, 2],
  ["project enables over a disabling user config", enabled, disabled, 1],
  ["project disables over an enabling user config", disabled, enabled, 2],
];

test.each(layers)(
  "achievedTier reports 2 only when the deciding config.toml disables hooks (%s)",
  async (_, projectToml, userToml, expected) => {
    await withTempDir(async (dir) => {
      const home = join(dir, "home");
      const project = join(dir, "project");
      mkdirSync(join(home, ".codex"), { recursive: true });
      mkdirSync(join(project, ".codex"), { recursive: true });
      if (projectToml !== null) writeFileSync(join(project, ".codex", "config.toml"), projectToml);
      if (userToml !== null) writeFileSync(join(home, ".codex", "config.toml"), userToml);
      expect(await achievedTier({ home, projectRoot: project, env: {} })).toBe(expected);
    });
  },
);

test("achievedTier surfaces a config.toml it cannot read instead of counting it absent", async () => {
  await withTempDir(async (dir) => {
    mkdirSync(join(dir, ".codex", "config.toml"), { recursive: true });
    const refused = await achievedTier({ home: dir, projectRoot: null, env: {} }).catch((e) => e);
    expect(refused).toBeInstanceOf(MaximsError);
    expect({ code: refused.code, message: refused.message }).toEqual({
      code: ExitCode.DestinationWriteFailed,
      message: expect.stringMatching(/^cannot read .*config\.toml: EISDIR/),
    });
  });
});

// The wording is what a user reads when Codex's own config refuses to load: the file, the reason
// and where, with the excerpt smol-toml appends left out.
const malformed: [string, string, string][] = [
  [
    "a bare key",
    "hooks\n",
    "Invalid TOML document: incomplete key-value: cannot find end of key (line 1, column 1)",
  ],
  [
    "a date at the top level",
    "1979-05-27T07:32:00Z",
    "Invalid TOML document: incomplete key-value: cannot find end of key (line 1, column 1)",
  ],
  [
    'hooks = "true"',
    '[features]\nhooks = "true"\n',
    "features.hooks: Invalid input: expected boolean, received string",
  ],
  [
    "hooks as a table",
    "[features.hooks]\n",
    "features.hooks: Invalid input: expected boolean, received object",
  ],
];

test.each(malformed)(
  "achievedTier refuses a config.toml it cannot read a hooks flag from with exit 4 (%s)",
  async (_, toml, reason) => {
    await withTempDir(async (dir) => {
      mkdirSync(join(dir, ".codex"), { recursive: true });
      const path = join(dir, ".codex", "config.toml");
      writeFileSync(path, toml);
      const refused = await achievedTier({ home: dir, projectRoot: null, env: {} }).catch((e) => e);
      expect(refused).toBeInstanceOf(MaximsError);
      expect({ code: refused.code, message: refused.message, hint: refused.hint }).toEqual({
        code: ExitCode.DestinationWriteFailed,
        message: `cannot read ${path}: ${reason}`,
        hint: "fix the file by hand, then run maxims sync",
      });
    });
  },
);

test("achievedTier skips a project whose .codex is a regular file and lets the user config decide", async () => {
  await withTempDir(async (dir) => {
    const home = join(dir, "home");
    const project = join(dir, "project");
    mkdirSync(join(home, ".codex"), { recursive: true });
    mkdirSync(project, { recursive: true });
    writeFileSync(join(project, ".codex"), "not a directory\n");
    writeFileSync(join(home, ".codex", "config.toml"), disabled);
    expect(await achievedTier({ home, projectRoot: project, env: {} })).toBe(2);
  });
});

test("$CODEX_HOME moves the user AGENTS.md, config and hook registry, even when relative", async () => {
  await withTempDir(async (dir) => {
    const codexHome = join(dir, "elsewhere");
    mkdirSync(codexHome, { recursive: true });
    writeFileSync(join(codexHome, "config.toml"), disabled);
    const ctx = { home: join(dir, "home"), projectRoot: null, env: { CODEX_HOME: codexHome } };
    expect(await achievedTier(ctx)).toBe(2);
    expect(hookPath("global", ctx)).toBe(join(codexHome, "hooks.json"));
    const target = codex.targets.global;
    if (target?.kind !== "shared-block") throw new Error("the user AGENTS.md is a shared block");
    expect(join(scopeRoot(codex, "global", ctx), target.file)).toBe(join(codexHome, "AGENTS.md"));

    const relative = { ...ctx, env: { CODEX_HOME: "custom-codex" } };
    expect(hookPath("global", relative)).toBe(join(process.cwd(), "custom-codex/hooks.json"));
  });
});

// A shell that exports $CODEX_HOME on every machine, Codex installed or not, must not make maxims
// report Codex present: the directory is the evidence, the variable only says where to look, and
// a stray file at that path is no config directory either.
test("detection follows the config directory, not the exported variable", async () => {
  await withTempDir(async (dir) => {
    const home = join(dir, "home");
    const present = join(dir, "present");
    mkdirSync(present, { recursive: true });
    writeFileSync(join(dir, "a-file"), "");
    expect(codex.detect({ home, projectRoot: null, env: { CODEX_HOME: present } })).toBe(true);
    expect(
      codex.detect({ home, projectRoot: null, env: { CODEX_HOME: join(dir, "missing") } }),
    ).toBe(false);
    expect(
      codex.detect({ home, projectRoot: null, env: { CODEX_HOME: join(dir, "a-file") } }),
    ).toBe(false);
    expect(codex.detect({ home, projectRoot: null, env: {} })).toBe(false);
    mkdirSync(join(home, ".codex"), { recursive: true });
    expect(codex.detect({ home, projectRoot: null, env: {} })).toBe(true);
  });
});

test("a fresh project hooks.json receives the grouped async SessionStart entry", () => {
  const ctx: HarnessContext = { home: "/home/user", projectRoot: "/home/user/project", env: {} };
  if (!hasHook(codex, "registry")) throw new Error("the hook is a registry entry");
  const plan = planHookRegistryWrite({
    def: codex,
    scope: "project",
    ctx,
    wanted: true,
    currentText: null,
  });
  expect(plan.changes).toEqual([
    {
      kind: "write",
      path: assertInsideRoot("/home/user/project", "/home/user/project/.codex/hooks.json"),
      content: [
        "{",
        '  "hooks": {',
        '    "SessionStart": [',
        "      {",
        '        "hooks": [',
        "          {",
        '            "type": "command",',
        '            "command": "npx -y @vivswan/maxims sync --quiet",',
        '            "timeout": 20,',
        '            "async": true,',
        '            "statusMessage": "Syncing maxims"',
        "          }",
        "        ]",
        "      }",
        "    ]",
        "  }",
        "}",
        "",
      ].join("\n"),
    },
  ]);
});
