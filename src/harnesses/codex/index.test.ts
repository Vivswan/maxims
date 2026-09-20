// Guards the tier Codex actually reaches: hooks are on by default and only `[features] hooks =
// false` in the project or user config.toml disables them, with the project layer deciding when it
// sets the key at all. Reporting tier 1 on a disabled machine would promise a refresh that never
// fires, and so would passing an unreadable config off as an absent one. Also guards that every
// user-level file follows $CODEX_HOME and that the variable alone never counts as an install.
import { expect, test } from "bun:test";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { withTempDir } from "../../../tests/shared/temp_dir.ts";
import { scopeRoot } from "../contract.ts";
import { codex } from "./index.ts";

const fixture = (name: string): string =>
  readFileSync(join(import.meta.dir, "fixtures", name), "utf8");
const disabled = fixture("config-hooks-disabled.toml");
const noFeatures = fixture("config-default.toml");
const enabled = `${noFeatures}\n[features]\nhooks = true\n`;

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
      const ctx = { home, projectRoot: project, env: {} };
      expect(await codex.achievedTier(ctx)).toBe(expected);
    });
  },
);

test("achievedTier surfaces a config.toml it cannot read instead of counting it absent", async () => {
  await withTempDir(async (dir) => {
    mkdirSync(join(dir, ".codex", "config.toml"), { recursive: true });
    const ctx = { home: dir, projectRoot: null, env: {} };
    await expect(codex.achievedTier(ctx)).rejects.toThrow(/EISDIR/);
  });
});

test("$CODEX_HOME moves the user AGENTS.md, config and hook registry, even when relative", async () => {
  await withTempDir(async (dir) => {
    const codexHome = join(dir, "elsewhere");
    mkdirSync(codexHome, { recursive: true });
    writeFileSync(join(codexHome, "config.toml"), disabled);
    const ctx = { home: join(dir, "home"), projectRoot: null, env: { CODEX_HOME: codexHome } };
    expect(await codex.achievedTier(ctx)).toBe(2);
    expect(codex.hook.path("global", ctx)).toBe(join(codexHome, "hooks.json"));
    expect(join(scopeRoot(codex, "global", ctx), codex.targets.global.file)).toBe(
      join(codexHome, "AGENTS.md"),
    );

    const relative = { ...ctx, env: { CODEX_HOME: "custom-codex" } };
    expect(codex.hook.path("global", relative)).toBe(
      join(process.cwd(), "custom-codex/hooks.json"),
    );
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
