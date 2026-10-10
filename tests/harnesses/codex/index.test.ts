// Guards the tier Codex actually reaches: hooks are on by default and only `[features] hooks =
// false` in the project or user config.toml disables them, with the project layer deciding when it
// sets the key at all. Reporting tier 1 on a disabled machine would promise a refresh that never
// fires, and so would passing an unreadable config off as an absent one; a probe that threw on it
// would abort the sync and the read-only verbs over a file maxims never writes. Also guards that
// the probe reads the config.toml under $CODEX_HOME, and the bytes a fresh hooks.json receives,
// which Codex reads without checking them for us.
import { expect, test } from "bun:test";
import {
  chmodSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { stringify } from "smol-toml";
import { codex } from "../../../src/harnesses/codex/spec.ts";
import {
  type AchievedTier,
  type HarnessContext,
  type Scope,
  sharedBlockFile,
} from "../../../src/harnesses/contract.ts";
import {
  hasHook,
  planHookRegistryWrite,
  achievedTier as probe,
} from "../../../src/harnesses/hook-writer.ts";
import { assertInsideRoot } from "../../../src/util/fs.ts";
import { CHMOD_DENIES, WINDOWS } from "../../shared/platform.ts";
import { srcPath } from "../../shared/src_path.ts";
import { withTempDir } from "../../shared/temp_dir.ts";
import { exampleContext } from "../context.ts";

const fixture = (name: string): string =>
  readFileSync(srcPath("harnesses", "codex", "fixtures", name), "utf8");
const disabled = fixture("config-hooks-disabled.toml");
const noFeatures = fixture("config-default.toml");
const enabled = `${noFeatures}\n[features]\nhooks = true\n`;
// The projects entry as Codex's own trust prompt writes it, the path spelled as a TOML key
// whatever it holds (a Windows path's backslashes included).
const marked = (path: string, level: unknown): string =>
  `\n${stringify({ projects: { [path]: { trust_level: level } } })}\n`;
const trustedBy = (path: string): string => marked(path, "trusted");
const untrustedBy = (path: string): string => marked(path, "untrusted");

// The config.toml layers are the machine's whichever scope the hook sits in, so one scope stands
// for both in the rows that set a readable flag; the broken-layer rows below probe both scopes.
function achievedTier(ctx: HarnessContext): Promise<AchievedTier> {
  return probe(codex, "global", ctx);
}

// The user config is written with the project marked trusted, as Codex's own trust prompt writes
// it, so a project layer in these rows applies; the trust rows below cover the unmarked project.
const layers: [string, string | null, string | null, 1 | 2][] = [
  ["no config at all", null, null, 1],
  ["configs without a features table", noFeatures, noFeatures, 1],
  ["project disables", disabled, "", 2],
  ["user disables, project silent", noFeatures, disabled, 2],
  ["project enables over a disabling user config", enabled, disabled, 1],
  ["project disables over an enabling user config", disabled, enabled, 2],
];

test.each(layers)(
  "achievedTier reports 2 only when the deciding config.toml disables hooks (%s)",
  async (_, projectToml, userToml, expected) => {
    await withTempDir(async (dir) => {
      const home = join(dir, "home");
      const project = join(realpathSync(dir), "project");
      mkdirSync(join(home, ".codex"), { recursive: true });
      mkdirSync(join(project, ".codex"), { recursive: true });
      if (projectToml !== null) writeFileSync(join(project, ".codex", "config.toml"), projectToml);
      if (userToml !== null) {
        writeFileSync(join(home, ".codex", "config.toml"), `${userToml}${trustedBy(project)}`);
      }
      expect(await achievedTier({ home, projectRoot: project, cwd: project, env: {} })).toEqual({
        tier: expected,
        unreadable: null,
      });
    });
  },
);

const unreadable = (path: string, reason: string): AchievedTier => ({
  tier: 2,
  unreadable: `config.toml could not be read (${path}: ${reason}); assuming hooks off`,
});

test("achievedTier reads a config.toml it cannot open as hooks off, and says so", async () => {
  await withTempDir(async (dir) => {
    const path = join(dir, ".codex", "config.toml");
    mkdirSync(path, { recursive: true });
    const reading = await achievedTier({ home: dir, projectRoot: null, cwd: dir, env: {} });
    expect(reading.tier).toBe(2);
    expect(reading.unreadable).toMatch(
      new RegExp(
        `^config\\.toml could not be read \\(${RegExp.escape(path)}: EISDIR.*\\); assuming hooks off$`,
      ),
    );
  });
});

// The wording is what a user reads when Codex's own config refuses to load: the file, the reason
// and where, with the excerpt smol-toml appends left out.
const malformed: [string, string, string][] = [
  ["a bare key", "hooks\n", "Invalid TOML document: illegal character in key (line 1, column 6)"],
  [
    "a date at the top level",
    "1979-05-27T07:32:00Z",
    "Invalid TOML document: illegal character in key (line 1, column 14)",
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

// Codex reads a `.codex/config.toml` in every directory from the project root down to the one it
// runs in, the nearest deciding, so a subdirectory switches hooks off under a root that leaves
// them on. Layers that named the root alone would promise a refresh that never fires there.
const walked: [string, string, string, 1 | 2, 1 | 2][] = [
  ["the subdirectory disables under an enabling root", enabled, disabled, 2, 1],
  ["the subdirectory enables under a disabling root", disabled, enabled, 1, 2],
];

test.each(walked)(
  "achievedTier walks .codex/config.toml from the project root to the session's directory (%s)",
  async (_, rootToml, subToml, fromSub, fromRoot) => {
    await withTempDir(async (dir) => {
      const home = join(dir, "home");
      const project = join(realpathSync(dir), "project");
      const sub = join(project, "packages", "app");
      mkdirSync(join(home, ".codex"), { recursive: true });
      mkdirSync(join(project, ".codex"), { recursive: true });
      mkdirSync(join(sub, ".codex"), { recursive: true });
      writeFileSync(join(project, ".codex", "config.toml"), rootToml);
      writeFileSync(join(sub, ".codex", "config.toml"), subToml);
      writeFileSync(join(home, ".codex", "config.toml"), trustedBy(project));
      const at = (cwd: string) => achievedTier({ home, projectRoot: project, cwd, env: {} });
      expect(await at(sub)).toEqual({ tier: fromSub, unreadable: null });
      expect(await at(project)).toEqual({ tier: fromRoot, unreadable: null });
    });
  },
);

// A folder nobody may search stops the real-path lookup of the session directory. The probe still
// answers with the layer under it and the error that stopped the read, where a throw would abort
// list, doctor and sync over files maxims never writes. Through an alias symlink to the project
// the climb must still meet the root, recorded by its real path, or the sealed folder reads as
// absent.
const sealed: [string, (dir: string) => string][] = [
  ["spelled under the root", (dir) => join(dir, "project", "locked", "app")],
  ["spelled through an alias symlink to the root", (dir) => join(dir, "alias", "locked", "app")],
];

test.skipIf(!CHMOD_DENIES).each(sealed)(
  "a session directory under a folder nobody may search is a reading, never a throw (%s)",
  async (_, cwdIn) => {
    await withTempDir(async (dir) => {
      const home = join(dir, "home");
      const project = join(dir, "project");
      const locked = join(project, "locked");
      mkdirSync(join(home, ".codex"), { recursive: true });
      mkdirSync(join(project, ".codex"), { recursive: true });
      mkdirSync(join(locked, "app"), { recursive: true });
      symlinkSync(project, join(dir, "alias"));
      writeFileSync(join(project, ".codex", "config.toml"), enabled);
      writeFileSync(join(home, ".codex", "config.toml"), trustedBy(realpathSync(project)));
      chmodSync(locked, 0o000);
      try {
        const projectRoot = realpathSync(project);
        const probed = await achievedTier({ home, projectRoot, cwd: cwdIn(dir), env: {} });
        expect(probed.tier).toBe(2);
        expect(probed.unreadable).toMatch(
          /^config\.toml could not be read \(.*locked.*config\.toml: EACCES.*\); assuming hooks off$/,
        );
      } finally {
        chmodSync(locked, 0o700);
      }
    });
  },
);

test.each(malformed)(
  "achievedTier reads a config.toml that does not parse, or sets hooks to a non-boolean, as hooks off with the reason (%s)",
  async (_, toml, reason) => {
    await withTempDir(async (dir) => {
      mkdirSync(join(dir, ".codex"), { recursive: true });
      const path = join(dir, ".codex", "config.toml");
      writeFileSync(path, toml);
      expect(await achievedTier({ home: dir, projectRoot: null, cwd: dir, env: {} })).toEqual(
        unreadable(path, reason),
      );
    });
  },
);

// Codex refuses to start on a user or trusted project config.toml that does not parse, so a
// broken layer is the reading wherever it sits and whichever file the hook is registered in: the
// machine is taken at hooks off whatever the other layer says.
const brokenLayers: [string, string, (project: string) => string, "project" | "home"][] = [
  [
    "trusted project broken over an enabling user config",
    "hooks\n",
    (project) => `${enabled}${trustedBy(project)}`,
    "project",
  ],
  ["user broken under an enabling project config", enabled, () => "hooks\n", "home"],
];

test.each(brokenLayers)(
  "an unreadable config.toml is reported over the other layer, for a hook in either scope (%s)",
  async (_, projectToml, userToml, brokenIn) => {
    await withTempDir(async (dir) => {
      const home = join(dir, "home");
      const project = join(realpathSync(dir), "project");
      mkdirSync(join(home, ".codex"), { recursive: true });
      mkdirSync(join(project, ".codex"), { recursive: true });
      writeFileSync(join(home, ".codex", "config.toml"), userToml(project));
      writeFileSync(join(project, ".codex", "config.toml"), projectToml);
      const broken =
        brokenIn === "project"
          ? join(project, ".codex", "config.toml")
          : join(home, ".codex", "config.toml");
      for (const scope of ["project", "global"] as const) {
        expect(
          await probe(codex, scope, { home, projectRoot: project, cwd: project, env: {} }),
        ).toEqual(
          unreadable(broken, "Invalid TOML document: illegal character in key (line 1, column 6)"),
        );
      }
    });
  },
);

test("achievedTier skips a project whose .codex is a regular file and lets the user config decide", async () => {
  await withTempDir(async (dir) => {
    const home = join(dir, "home");
    const project = join(realpathSync(dir), "project");
    mkdirSync(join(home, ".codex"), { recursive: true });
    mkdirSync(project, { recursive: true });
    writeFileSync(join(project, ".codex"), "not a directory\n");
    writeFileSync(join(home, ".codex", "config.toml"), `${disabled}${trustedBy(project)}`);
    expect(await achievedTier({ home, projectRoot: project, cwd: project, env: {} })).toEqual({
      tier: 2,
      unreadable: null,
    });
  });
});

test("achievedTier reads the config.toml under $CODEX_HOME", async () => {
  await withTempDir(async (dir) => {
    const codexHome = join(dir, "elsewhere");
    mkdirSync(codexHome, { recursive: true });
    writeFileSync(join(codexHome, "config.toml"), disabled);
    const ctx = {
      home: join(dir, "home"),
      projectRoot: null,
      cwd: join(dir, "home"),
      env: { CODEX_HOME: codexHome },
    };
    expect(await achievedTier(ctx)).toEqual({ tier: 2, unreadable: null });
  });
});

test("a fresh project hooks.json receives the grouped async SessionStart entry", () => {
  if (!hasHook(codex, "registry")) throw new Error("the hook is a registry entry");
  const plan = planHookRegistryWrite({
    def: codex,
    scope: "project",
    ctx: exampleContext,
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

// Codex's home loader reads the first of AGENTS.override.md and AGENTS.md whose trimmed content is
// not empty, so a blank override beside the user's AGENTS.md must not receive the block: filled, it
// would become the one file Codex reads and the user's AGENTS.md would stop loading. Its project
// loader takes the first of the two that exists and drops a blank one without falling back to
// AGENTS.md, so there a blank override is the only file Codex would ever read and the block
// belongs in it. Blank is what Rust's trim leaves empty: a zero-byte file, a newline, a U+0085
// (whitespace to Rust, not to JavaScript); a lone byte order mark is content to Codex.
const blankOverrideRows: [Scope, string][] = [
  ["project", "AGENTS.override.md"],
  ["global", "AGENTS.md"],
];

test.each(blankOverrideRows)(
  "the %s block follows Codex's own loader: a blank AGENTS.override.md sends it to %s",
  async (scope, blankOverrideTarget) => {
    const target = codex.targets[scope];
    if (target?.kind !== "shared-block") throw new Error("expected a shared block");
    await withTempDir((dir) => {
      const override = join(dir, "AGENTS.override.md");
      expect(sharedBlockFile(target, dir)).toBe("AGENTS.md");
      writeFileSync(override, "");
      expect(sharedBlockFile(target, dir)).toBe(blankOverrideTarget);
      writeFileSync(override, "\n");
      expect(sharedBlockFile(target, dir)).toBe(blankOverrideTarget);
      writeFileSync(override, "\u0085");
      expect(sharedBlockFile(target, dir)).toBe(blankOverrideTarget);
      writeFileSync(join(dir, "AGENTS.md"), "# agents\n");
      expect(sharedBlockFile(target, dir)).toBe(blankOverrideTarget);
      writeFileSync(override, "\uFEFF");
      expect(sharedBlockFile(target, dir)).toBe("AGENTS.override.md");
      writeFileSync(override, "# override\n");
      expect(sharedBlockFile(target, dir)).toBe("AGENTS.override.md");
    });
  },
);

// Codex applies a project's `.codex/config.toml` only where the user config.toml marks the
// directory, or the project root, trusted (`projects.<path>.trust_level = "trusted"`); an untrusted
// one is skipped whole, broken or not, where a broken trusted one stops Codex from starting. A
// probe that read every project layer called an untrusted project's broken file hooks off, and
// its disabling flag a demotion Codex never applies.
const trustRows: [
  string,
  string,
  (project: string) => string,
  (project: string, home: string) => AchievedTier,
][] = [
  [
    "an unmarked project with a broken layer reads the user config alone",
    "hooks\n",
    () => enabled,
    () => ({ tier: 1, unreadable: null }),
  ],
  [
    "a project marked untrusted with a broken layer reads the user config alone",
    "hooks\n",
    (project) => `${enabled}${untrustedBy(project)}`,
    () => ({ tier: 1, unreadable: null }),
  ],
  [
    "an unmarked project's disabling layer does not apply",
    disabled,
    () => enabled,
    () => ({ tier: 1, unreadable: null }),
  ],
  [
    "a trusted project's broken layer is the reading",
    "hooks\n",
    (project) => `${enabled}${trustedBy(project)}`,
    (project) =>
      unreadable(
        join(project, ".codex", "config.toml"),
        "Invalid TOML document: illegal character in key (line 1, column 6)",
      ),
  ],
  [
    "a trusted project's disabling layer applies",
    disabled,
    (project) => `${enabled}${trustedBy(project)}`,
    () => ({ tier: 2, unreadable: null }),
  ],
  [
    "a mark outside Codex's own two is a user config Codex refuses, so the reading",
    disabled,
    (project) => `${enabled}${marked(project, "trustd")}`,
    (project, home) =>
      unreadable(
        join(home, ".codex", "config.toml"),
        `projects.${project}.trust_level: Invalid option: expected one of "trusted"|"untrusted"`,
      ),
  ],
  [
    "a mark of another type is the same refused user config",
    disabled,
    (project) => `${enabled}${marked(project, 42)}`,
    (project, home) =>
      unreadable(
        join(home, ".codex", "config.toml"),
        `projects.${project}.trust_level: Invalid option: expected one of "trusted"|"untrusted"`,
      ),
  ],
];

test.each(trustRows)(
  "achievedTier reads a project config.toml only where the user config trusts the project (%s)",
  async (_, projectToml, userToml, expected) => {
    await withTempDir(async (dir) => {
      const home = join(dir, "home");
      const project = join(realpathSync(dir), "project");
      mkdirSync(join(home, ".codex"), { recursive: true });
      mkdirSync(join(project, ".codex"), { recursive: true });
      writeFileSync(join(project, ".codex", "config.toml"), projectToml);
      writeFileSync(join(home, ".codex", "config.toml"), userToml(project));
      for (const scope of ["project", "global"] as const) {
        expect(
          await probe(codex, scope, { home, projectRoot: project, cwd: project, env: {} }),
        ).toEqual(expected(project, home));
      }
    });
  },
);

// Trust granted to the project root covers the directories under it, as Codex looks the project
// root up when the directory itself is unmarked.
test("achievedTier applies a subdirectory layer only under a trusted project root", async () => {
  await withTempDir(async (dir) => {
    const home = join(dir, "home");
    const project = join(realpathSync(dir), "project");
    const sub = join(project, "packages", "app");
    mkdirSync(join(home, ".codex"), { recursive: true });
    mkdirSync(join(sub, ".codex"), { recursive: true });
    writeFileSync(join(sub, ".codex", "config.toml"), disabled);
    const at = (userToml: string) => {
      writeFileSync(join(home, ".codex", "config.toml"), userToml);
      return achievedTier({ home, projectRoot: project, cwd: sub, env: {} });
    };
    expect(await at(`${enabled}${trustedBy(project)}`)).toEqual({ tier: 2, unreadable: null });
    expect(await at(enabled)).toEqual({ tier: 1, unreadable: null });
  });
});

// The projects table is keyed by the directory's path, which Codex writes as a TOML string: a
// Windows path's backslashes, or a quote in a directory name, must be spelled as TOML escapes or
// the user config does not parse at all. Windows forbids a quote in a file name, so the row runs
// where the name can exist; the Windows leg pins the backslash through every other row.
test.skipIf(WINDOWS)(
  "a project directory holding a backslash and a quote is keyed as TOML spells it",
  async () => {
    await withTempDir(async (dir) => {
      const home = join(dir, "home");
      const project = join(realpathSync(dir), 'pro"j\\ect');
      mkdirSync(join(home, ".codex"), { recursive: true });
      mkdirSync(join(project, ".codex"), { recursive: true });
      writeFileSync(join(project, ".codex", "config.toml"), disabled);
      writeFileSync(join(home, ".codex", "config.toml"), `${enabled}${trustedBy(project)}`);
      expect(await achievedTier({ home, projectRoot: project, cwd: project, env: {} })).toEqual({
        tier: 2,
        unreadable: null,
      });
    });
  },
);
