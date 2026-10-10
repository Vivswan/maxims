// What would drift silently: the hook writer plans a definition's config edit under the same
// `wanted` as the hook, so a source that lists rules without a hook would lose the config entry
// its rules directory needs, and one that switched rules off would keep it. A hook that lives in
// one place whatever the scope (dsh's bridge under the global root) would be written for the scope
// that wants it and deleted again for the scope that does not. When both scopes resolve to one
// registry (a home directory that is itself a git repository), the second sync would remove the
// hook the first one wrote and the third would put it back.
import { describe, expect, test } from "bun:test";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { basename, join, sep } from "node:path";
import { runSync } from "../../src/commands/sync.ts";
import { loadContext } from "../../src/engine/context.ts";
import { type HarnessWants, planHooks } from "../../src/engine/hooks.ts";
import { claudeCode } from "../../src/harnesses/claude-code/spec.ts";
import {
  type HarnessContext,
  type HarnessDefinition,
  HOOK_COMMAND,
  type Scope,
  scopeRoot,
} from "../../src/harnesses/contract.ts";
import { dsh } from "../../src/harnesses/dsh/spec.ts";
import { readIfPresent } from "../../src/util/fs.ts";
import { SYNC } from "../shared/sync_support.ts";
import {
  configEditHarness,
  entryFor,
  FIXTURE_CONFIG_CONTENT,
  FIXTURE_DIR,
  fakeIo,
  localFrom,
  rulesDirHarness,
  stateWith,
  writeSource,
  writeState,
} from "./fakes.ts";
import { TWO_MEMORIES, world } from "./world.ts";

// The registry write's content is the hook writer's; this test pins only which changes appear.
const configWrite = (config: string): unknown => ({
  kind: "write",
  path: config,
  content: FIXTURE_CONFIG_CONTENT,
});
const registryWrite = (registry: string): unknown => ({
  kind: "write",
  path: registry,
  content: expect.stringContaining(HOOK_COMMAND),
});

const cases: [string, HarnessWants, (config: string, registry: string) => unknown[]][] = [
  [
    "rules without a hook",
    { hook: false, rules: true, unreachable: false },
    (config) => [configWrite(config)],
  ],
  ["neither rules nor a hook", { hook: false, rules: false, unreachable: false }, () => []],
  [
    "a hook without rules",
    { hook: true, rules: false, unreachable: false },
    (_config, registry) => [registryWrite(registry)],
  ],
  [
    "rules and a hook",
    { hook: true, rules: true, unreachable: false },
    (config, registry) => [registryWrite(registry), configWrite(config)],
  ],
];

describe("planHooks", () => {
  for (const [label, wants, expected] of cases) {
    test(`${label}: the config edit follows the rules, the registry entry follows the hook`, async () => {
      await world(async ({ home, userHome, dir }) => {
        const io = fakeIo({ home, userHome, cwd: dir, harnesses: [configEditHarness] });
        const ctx = await loadContext(io, { readHookStdin: false });
        const plan = await planHooks({
          ctx,
          harnesses: [configEditHarness],
          agents: undefined,
          wants: (_id, scope: Scope) =>
            scope === "global" ? wants : { ...wants, unreachable: true },
          elsewhere: () => [],
        });
        const config = join(userHome, FIXTURE_DIR, "config.json");
        const registry = join(userHome, FIXTURE_DIR, "settings.json");
        expect<unknown[]>(plan.changes).toEqual(expected(config, registry));
        expect<unknown[]>(plan.removals).toEqual(
          wants.rules ? [] : [{ kind: "delete", path: config }],
        );
        expect(plan.failures).toEqual([]);
      });
    });
  }
});

// The stub server entry is the session-start sync of a harness whose event is the MCP handshake,
// so it follows the hook intent: wanted, it is written beside the hook; unwanted, it leaves as a
// removal. A user-defined harness may keep its hooks and its servers in one file, where two
// writes in one plan would leave whichever landed last.
describe("the MCP server entry follows the hook intent", () => {
  const serversIn = (file: string): HarnessDefinition => ({
    ...rulesDirHarness,
    mcp: {
      path: (scope: Scope, ctx: HarnessContext) =>
        join(scopeRoot({}, scope, ctx), FIXTURE_DIR, file),
      serversPath: ["mcpServers"],
    },
  });
  const apart = serversIn("mcp.json");
  const together = serversIn("settings.json");
  const plan = async (
    def: HarnessDefinition,
    dir: string,
    home: string,
    userHome: string,
    hook: boolean,
  ) => {
    const io = fakeIo({ home, userHome, cwd: dir, harnesses: [def] });
    const ctx = await loadContext(io, { readHookStdin: false });
    return planHooks({
      ctx,
      harnesses: [def],
      agents: undefined,
      wants: (_id, scope: Scope) => ({ hook, rules: false, unreachable: scope !== "global" }),
      elsewhere: () => [],
    });
  };

  test("in its own file it is written when the hook is wanted and removed when not", async () => {
    await world(async ({ home, userHome, dir }) => {
      const mcp = join(userHome, FIXTURE_DIR, "mcp.json");
      const registry = join(userHome, FIXTURE_DIR, "settings.json");
      const wanted = await plan(apart, dir, home, userHome, true);
      expect<unknown[]>(wanted.changes).toEqual([
        registryWrite(registry),
        { kind: "write", path: mcp, content: expect.stringContaining('"mcp-serve"') },
      ]);
      expect(wanted.notices).toEqual([
        `registered the maxims hook in ${registry}`,
        `registered the maxims MCP server in ${mcp}`,
      ]);
      const [, written] = wanted.changes;
      if (written?.kind !== "write") throw new Error("expected the servers write");
      writeFileSync(mcp, written.content);
      const unwanted = await plan(apart, dir, home, userHome, false);
      expect<unknown[]>(unwanted.removals).toEqual([
        { kind: "write", path: mcp, content: '{\n  "mcpServers": {}\n}\n' },
      ]);
      expect(unwanted.notices).toEqual([`removed the maxims MCP server from ${mcp}`]);
    });
  });

  test("in the hook's own registry it rides in the hook's write, so the file is written once", async () => {
    await world(async ({ home, userHome, dir }) => {
      const registry = join(userHome, FIXTURE_DIR, "settings.json");
      const wanted = await plan(together, dir, home, userHome, true);
      expect<unknown[]>(wanted.changes.map((change) => change.path)).toEqual([registry]);
      const [write] = wanted.changes;
      if (write?.kind !== "write") throw new Error("expected the registry write");
      expect(write.content).toContain(HOOK_COMMAND);
      expect(write.content).toContain('"mcp-serve"');
      writeFileSync(registry, write.content);
      const settled = await plan(together, dir, home, userHome, true);
      expect(settled.changes).toEqual([]);
      const unwanted = await plan(together, dir, home, userHome, false);
      expect<unknown[]>(unwanted.removals).toEqual([
        { kind: "write", path: registry, content: '{\n  "mcpServers": {}\n}\n' },
      ]);
    });
  });

  // A user-defined harness may name the one file by two spellings: the hook by its path, the
  // servers through a directory link. Compared by name they would be two writes of one file.
  test("in the hook's registry reached through a directory link it still rides in the hook's write", async () => {
    await world(async ({ home, userHome, dir }) => {
      const alias = join(userHome, "fixture-alias");
      symlinkSync(join(userHome, FIXTURE_DIR), alias);
      const linked: HarnessDefinition = {
        ...rulesDirHarness,
        mcp: {
          path: (scope: Scope, ctx: HarnessContext) =>
            join(scopeRoot({}, scope, ctx), "fixture-alias", "settings.json"),
          serversPath: ["mcpServers"],
        },
      };
      const registry = join(userHome, FIXTURE_DIR, "settings.json");
      const wanted = await plan(linked, dir, home, userHome, true);
      expect<unknown[]>(wanted.changes.map((change) => change.path)).toEqual([registry]);
      const [write] = wanted.changes;
      if (write?.kind !== "write") throw new Error("expected the registry write");
      expect(write.content).toContain(HOOK_COMMAND);
      expect(write.content).toContain('"mcp-serve"');
    });
  });

  // Each artifact is planned on its own: a servers file that cannot be read costs this run that
  // one registration, reported when it was wanted, and never the hook's own edit or removal.
  test("a servers file that cannot be read is reported when wanted and leaves the hook's plan standing", async () => {
    await world(async ({ home, userHome, dir }) => {
      const mcp = join(userHome, FIXTURE_DIR, "mcp.json");
      const registry = join(userHome, FIXTURE_DIR, "settings.json");
      writeFileSync(mcp, "{ not json");
      const wanted = await plan(apart, dir, home, userHome, true);
      expect<unknown[]>(wanted.changes).toEqual([registryWrite(registry)]);
      expect(wanted.failures.map((failure) => failure.message)).toEqual([
        expect.stringContaining(mcp),
      ]);
      const [write] = wanted.changes;
      if (write?.kind !== "write") throw new Error("expected the registry write");
      writeFileSync(registry, write.content);
      const unwanted = await plan(apart, dir, home, userHome, false);
      expect<unknown[]>(unwanted.removals).toEqual([
        { kind: "write", path: registry, content: "{}\n" },
      ]);
      expect(unwanted.failures).toEqual([]);
    });
  });
});

describe("a hook that lives in one place for both scopes", () => {
  test("a project-scoped dsh source keeps its bridge files; with no scope wanting them they leave", async () => {
    await world(async ({ home, userHome, dir, project }) => {
      const source = writeSource(join(dir, "src"), TWO_MEMORIES);
      const entry = entryFor(localFrom(source), {
        destination: { scope: "project", root: project },
        harnesses: ["dsh"],
      });
      writeState(home, stateWith({ [source]: entry }, { project: { [project]: ["dsh"] } }));
      const io = fakeIo({ home, userHome, cwd: project, harnesses: [dsh] });
      const hooks = join(userHome, ".dsh", "maxims-hooks.json");
      const patch = join(userHome, ".dsh", "cordis.patch.yml");
      for (const run of ["first", "second"]) {
        await runSync(SYNC, io);
        expect([run, readIfPresent(hooks)]).toEqual([run, expect.stringContaining(HOOK_COMMAND)]);
        expect(readFileSync(patch, "utf8")).toContain("maxims-hooks");
      }
      // Half a mount (the row without its file) is still the bridge: the scope that does not want
      // it takes the pair back as one artifact, so the scope that wants it keeps the row.
      rmSync(hooks);
      await runSync(SYNC, io);
      expect(readIfPresent(hooks)).toEqual(expect.stringContaining(HOOK_COMMAND));
      expect(readFileSync(patch, "utf8")).toContain("maxims-hooks");
      writeState(home, stateWith({ [source]: entry }));
      await runSync(SYNC, io);
      expect(readIfPresent(hooks)).toBeNull();
      expect(readFileSync(patch, "utf8")).not.toContain("maxims-hooks");
    });
  });

  // The bridge is one artifact in two files (the hooks file loads only through the patch row), so
  // a run that reaches it with nothing of its own plans it whole and keeps it rather than taking
  // half of it down; before the other project's own sync mounts it, a run here plans nothing.
  test("a run elsewhere keeps the hook files another project's sources want", async () => {
    await world(async ({ home, userHome, dir, project }) => {
      const other = join(dir, "other");
      const homeAlias = join(dir, "home-alias");
      symlinkSync(userHome, homeAlias);
      const hooks = join(userHome, ".dsh", "maxims-hooks.json");
      const patch = join(userHome, ".dsh", "cordis.patch.yml");
      const registry = (root: string) => join(root, ".claude", "settings.json");
      for (const root of [other, userHome]) {
        for (const folder of [".git", ".claude"])
          mkdirSync(join(root, folder), { recursive: true });
        const source = writeSource(join(root, "memories"), TWO_MEMORIES);
        const entry = entryFor(localFrom(source, true), {
          destination: { scope: "project", root },
          harnesses: ["dsh", "claude-code"],
        });
        writeState(
          home,
          stateWith({ [source]: entry }, { project: { [root]: ["claude-code", "dsh"] } }),
        );
        const run = (cwd: string) =>
          runSync(SYNC, fakeIo({ home, userHome: homeAlias, cwd, harnesses: [dsh, claudeCode] }));
        if (!existsSync(hooks)) {
          const before = await run(project);
          const bridge = before.plan.changes.filter((change) =>
            change.path.includes(join(sep, ".dsh", sep)),
          );
          expect(bridge).toEqual([]);
          expect(existsSync(hooks)).toBe(false);
        }
        await run(root);
        expect(readFileSync(registry(root), "utf8")).toContain(HOOK_COMMAND);
        expect(readIfPresent(hooks)).toEqual(expect.stringContaining(HOOK_COMMAND));
        expect(readFileSync(patch, "utf8")).toContain("maxims-hooks");
        // The run reaches the home through its alias, so a planned path is matched by its name.
        const hookFiles = new Set([hooks, patch, registry(root)].map((file) => basename(file)));
        for (const cwd of [project, dir]) {
          const report = await run(cwd);
          const deleted = report.plan.changes.filter(
            (change) => change.kind === "delete" && hookFiles.has(basename(change.path)),
          );
          expect([root, cwd, deleted]).toEqual([root, cwd, []]);
          expect(readIfPresent(hooks)).toEqual(expect.stringContaining(HOOK_COMMAND));
          expect(readFileSync(patch, "utf8")).toContain("maxims-hooks");
          expect(readFileSync(registry(root), "utf8")).toContain(HOOK_COMMAND);
          expect(existsSync(registry(project))).toBe(false);
        }
      }
    });
  });

  // A registry folder that is a symlink out of its root cannot be written; when nothing here wants
  // the hook, the other harnesses' sync goes on as before, and another project's such folder is
  // that project's failure, not this run's.
  test("a registry folder symlinked out of its root is passed over when nothing here wants it", async () => {
    await world(async ({ home, userHome, dir, project }) => {
      const other = join(dir, "other");
      const sealed = join(dir, "sealed");
      for (const root of [other, sealed]) mkdirSync(join(root, ".git"), { recursive: true });
      for (const root of [userHome, other]) {
        const dotfiles = join(dir, `dotfiles-${basename(root)}`);
        mkdirSync(dotfiles);
        symlinkSync(dotfiles, join(root, ".claude"));
      }
      mkdirSync(join(sealed, ".claude"));
      chmodSync(sealed, 0o000);
      try {
        const io = fakeIo({ home, userHome, cwd: project, harnesses: [claudeCode] });
        const ctx = await loadContext(io, { readHookStdin: false });
        for (const elsewhere of [[], [other], [sealed]]) {
          const plan = await planHooks({
            ctx,
            harnesses: [claudeCode],
            agents: undefined,
            wants: () => ({ hook: false, rules: false, unreachable: false }),
            elsewhere: () => elsewhere,
          });
          expect([elsewhere, plan.changes, plan.removals, plan.failures]).toEqual([
            elsewhere,
            [],
            [],
            [],
          ]);
        }
      } finally {
        chmodSync(sealed, 0o700);
      }
    });
  });

  // A registry this run reaches and cannot edit is this run's failure when another project's
  // source wants a hook in it, as it is when a source of this run's own does; the registry of a
  // project nobody reaches from here stays that project's.
  test("a malformed registry another project's hook lands in is reported here", async () => {
    await world(async ({ home, userHome, dir, project }) => {
      mkdirSync(join(userHome, ".git"));
      mkdirSync(join(userHome, ".claude"));
      writeFileSync(join(userHome, ".claude", "settings.json"), "{ not json");
      const io = fakeIo({ home, userHome, cwd: project, harnesses: [claudeCode] });
      const ctx = await loadContext(io, { readHookStdin: false });
      const nobody: HarnessWants = { hook: false, rules: false, unreachable: false };
      const plan = (elsewhere: string[]) =>
        planHooks({
          ctx,
          harnesses: [claudeCode],
          agents: undefined,
          wants: () => nobody,
          elsewhere: () => elsewhere,
        });
      expect((await plan([])).failures).toEqual([]);
      expect((await plan([userHome])).failures.map((failure) => failure.message)).toEqual([
        expect.stringContaining(join(userHome, ".claude", "settings.json")),
      ]);
      const other = join(dir, "other");
      mkdirSync(join(other, ".claude"), { recursive: true });
      writeFileSync(join(other, ".claude", "settings.json"), "{ not json");
      expect((await plan([other])).failures).toEqual([]);
    });
  });
});

describe("both scopes resolving to one registry", () => {
  test("a project-scoped source under a home that is a repository keeps its hook settled; hooks off at both scopes removes it", async () => {
    await world(async ({ home, userHome, dir }) => {
      mkdirSync(join(userHome, ".git"));
      mkdirSync(join(userHome, ".claude"));
      const source = writeSource(join(dir, "src"), TWO_MEMORIES);
      const entry = entryFor(localFrom(source), {
        destination: { scope: "project", root: userHome },
        harnesses: ["claude-code"],
      });
      writeState(
        home,
        stateWith({ [source]: entry }, { project: { [userHome]: ["claude-code"] } }),
      );
      const io = fakeIo({ home, userHome, cwd: userHome, harnesses: [claudeCode] });
      const settings = join(userHome, ".claude", "settings.json");
      const texts: string[] = [];
      for (const run of ["first", "second", "third"]) {
        const report = await runSync(SYNC, io);
        const text = readFileSync(settings, "utf8");
        expect([run, text]).toEqual([run, expect.stringContaining(HOOK_COMMAND)]);
        expect(report.notices.filter((line) => line.includes("removed the maxims hook"))).toEqual(
          [],
        );
        texts.push(text);
      }
      expect(texts[2]).toBe(texts[1] ?? "");
      writeState(home, stateWith({ [source]: entry }));
      await runSync(SYNC, io);
      expect(readFileSync(settings, "utf8")).not.toContain(HOOK_COMMAND);
    });
  });
});
