// What would drift silently:
// - a config edit planned under a different `wanted` than its hook, so a source listing rules
//   without a hook loses the config entry its rules directory needs
// - a hook living in one place for both scopes (dsh's bridge) written for one and deleted for the
//   other, or two scopes resolving to one registry undoing each other run after run
// - a registry kept as a symlink into a dotfiles checkout replaced by a regular file, or edited
//   through a link at a rule file maxims owns whole
import { describe, expect, test } from "bun:test";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { basename, join, sep } from "node:path";
import { runSync } from "../../src/commands/sync.ts";
import { loadContext } from "../../src/engine/context.ts";
import { type HarnessWants, planHooks } from "../../src/engine/hooks.ts";
import { sourceSlug } from "../../src/engine/slug.ts";
import { claudeCode } from "../../src/harnesses/claude-code/spec.ts";
import {
  type HarnessContext,
  type HarnessDefinition,
  HOOK_COMMAND,
  type Scope,
  scopeRoot,
} from "../../src/harnesses/contract.ts";
import { dsh } from "../../src/harnesses/dsh/spec.ts";
import { planMcpRegistration } from "../../src/harnesses/mcp-stub/register.ts";
import { ExitCode } from "../../src/util/exit-codes.ts";
import { assertInsideRoot, readIfPresent } from "../../src/util/fs.ts";
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
import { expectExit, globalRulesFile, TWO_MEMORIES, world } from "./world.ts";

// The registry write's content is the hook writer's; this test pins only which changes appear:
// the config entry is a write of a file maxims owns, the registry an edit of the user's file.
const configWrite = (config: string): unknown => ({
  kind: "write",
  path: config,
  content: FIXTURE_CONFIG_CONTENT,
});
const registryWrite = (registry: string): unknown => ({
  kind: "edit",
  path: registry,
  target: registry,
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
          judgeLink: () => undefined,
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
// changes in one plan would leave whichever landed last.
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
      judgeLink: () => undefined,
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

  test("in the hook's own registry it rides in the hook's edit, so the file is written once", async () => {
    await world(async ({ home, userHome, dir }) => {
      const registry = join(userHome, FIXTURE_DIR, "settings.json");
      const wanted = await plan(together, dir, home, userHome, true);
      expect<unknown[]>(wanted.changes.map((change) => change.path)).toEqual([registry]);
      const [edit] = wanted.changes;
      if (edit?.kind !== "edit") throw new Error("expected the registry edit");
      expect(edit.content).toContain(HOOK_COMMAND);
      expect(edit.content).toContain('"mcp-serve"');
      writeFileSync(registry, edit.content);
      const settled = await plan(together, dir, home, userHome, true);
      expect(settled.changes).toEqual([]);
      const unwanted = await plan(together, dir, home, userHome, false);
      expect<unknown[]>(unwanted.removals).toEqual([
        {
          kind: "edit",
          path: registry,
          target: registry,
          content: '{\n  "mcpServers": {}\n}\n',
        },
      ]);
    });
  });

  // A user-defined harness may name the one file by two spellings: the hook by its path, the
  // servers through a directory link. Compared by name they would be two writes of one file.
  test("in the hook's registry reached through a directory link it still rides in the hook's edit", async () => {
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
      const [edit] = wanted.changes;
      if (edit?.kind !== "edit") throw new Error("expected the registry edit");
      expect(edit.content).toContain(HOOK_COMMAND);
      expect(edit.content).toContain('"mcp-serve"');
    });
  });

  // The registry's edit lands in the file behind its link, so the one file the two entries share
  // may be named by the leaf (both declared at a registry linked into a dotfiles checkout) or by
  // the file behind it (a registry linked at the servers file). Either way a servers write planned
  // from the file's old text would land after the edit and take the hook back out.
  const linkedRegistry: [string, HarnessDefinition, (userHome: string) => string][] = [
    [
      "both declared at a registry linked into a dotfiles checkout",
      together,
      (userHome) => {
        mkdirSync(join(userHome, "dotfiles"));
        return join(userHome, "dotfiles", "settings.json");
      },
    ],
    [
      "a registry linked at the servers file",
      apart,
      (userHome) => join(userHome, FIXTURE_DIR, "mcp.json"),
    ],
  ];
  test.each(linkedRegistry)(
    "%s: the entry rides in the edit behind the link",
    async (_label, def, plant) => {
      await world(async ({ home, userHome, dir }) => {
        const behind = plant(userHome);
        const registry = join(userHome, FIXTURE_DIR, "settings.json");
        writeFileSync(behind, '{ "theme": "dark" }\n');
        symlinkSync(behind, registry);
        const wanted = await plan(def, dir, home, userHome, true);
        expect<unknown[]>(wanted.changes).toEqual([
          {
            kind: "edit",
            path: registry,
            target: behind,
            content: expect.stringContaining('"mcp-serve"'),
          },
        ]);
        const [edit] = wanted.changes;
        if (edit?.kind !== "edit") throw new Error("expected the registry edit");
        expect(edit.content).toContain(HOOK_COMMAND);
        expect(edit.content).toContain('"theme": "dark"');
      });
    },
  );

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
      const [edit] = wanted.changes;
      if (edit?.kind !== "edit") throw new Error("expected the registry edit");
      writeFileSync(registry, edit.content);
      const unwanted = await plan(apart, dir, home, userHome, false);
      expect<unknown[]>(unwanted.removals).toEqual([
        { kind: "edit", path: registry, target: registry, content: "{}\n" },
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
            judgeLink: () => undefined,
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
          judgeLink: () => undefined,
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

  // The writer replaces a link at the leaf with a real file, so a project servers file linked to
  // the global one becomes its own file on the project write and the global file keeps whatever
  // it held: compared by the resolved leaf the two are one file and the global removal is dropped.
  // Settled, nothing writes the leaf, the link stays, and the file behind it is the project's
  // registration: compared by the leaf alone the global removal stands and takes it away, and so
  // does a removal at a link partway along the chain, which the resolved leaf does not name.
  const behindTheLink: [string, (current: string) => string, boolean, object[], object[]][] = [
    [
      "a stale entry behind the link is written apart, and the global entry still leaves",
      () => '{\n  "mcpServers": {\n    "maxims": {\n      "command": "old"\n    }\n  }\n}\n',
      false,
      [{ kind: "write", content: expect.stringContaining('"mcp-serve"') }],
      [{ kind: "write", content: '{\n  "mcpServers": {}\n}\n' }],
    ],
    ["the current entry behind the link is settled and stays", (current) => current, false, [], []],
    [
      "the current entry behind a chain of links, the global file a link itself, stays",
      (current) => current,
      true,
      [],
      [],
    ],
  ];
  for (const [label, textBehind, chained, changes, removals] of behindTheLink) {
    test(`a project servers file linked to the global one: ${label}`, async () => {
      await world(async ({ home, userHome, project }) => {
        const hookless: HarnessDefinition = {
          ...rulesDirHarness,
          hook: { kind: "none" },
          mcp: {
            path: (scope: Scope, ctx: HarnessContext) =>
              join(scopeRoot({}, scope, ctx), FIXTURE_DIR, "mcp.json"),
            serversPath: ["mcpServers"],
          },
        };
        const global = join(userHome, FIXTURE_DIR, "mcp.json");
        const linked = join(project, FIXTURE_DIR, "mcp.json");
        const [current] = planMcpRegistration({
          registration: { path: assertInsideRoot(userHome, global), serversPath: ["mcpServers"] },
          wanted: true,
          currentText: null,
        }).changes;
        if (current?.kind !== "write") throw new Error("expected the servers write");
        if (chained) {
          const backing = join(userHome, "dotfiles", "mcp.json");
          mkdirSync(join(userHome, "dotfiles"));
          writeFileSync(backing, textBehind(current.content));
          symlinkSync(backing, global);
        } else {
          writeFileSync(global, textBehind(current.content));
        }
        symlinkSync(global, linked);
        const io = fakeIo({ home, userHome, cwd: project, harnesses: [hookless] });
        const ctx = await loadContext(io, { readHookStdin: false });
        const plan = await planHooks({
          ctx,
          harnesses: [hookless],
          agents: undefined,
          wants: (_id, scope: Scope) => ({
            hook: scope === "project",
            rules: false,
            unreachable: false,
          }),
          elsewhere: () => [],
          judgeLink: () => undefined,
        });
        expect<unknown[]>(plan.changes).toEqual(changes.map((c) => ({ ...c, path: linked })));
        expect<unknown[]>(plan.removals).toEqual(removals.map((c) => ({ ...c, path: global })));
      });
    });
  }
});

describe("a registry kept as a symlink", () => {
  // The dotfiles file lives under the home, where the link's target has to be.
  test("the hook lands in the file the link points to, the link survives, and the plan names the target", async () => {
    await world(async ({ home, userHome, dir }) => {
      const source = writeSource(join(dir, "src"), TWO_MEMORIES);
      writeState(
        home,
        stateWith({ [source]: entryFor(localFrom(source)) }, { global: ["claude-code"] }),
      );
      mkdirSync(join(userHome, "dotfiles"));
      const real = join(userHome, "dotfiles", "settings.json");
      writeFileSync(real, '{ "theme": "dark" }\n');
      const link = join(userHome, FIXTURE_DIR, "settings.json");
      symlinkSync(real, link);

      const dry = fakeIo({ home, userHome, cwd: dir });
      await runSync({ ...SYNC, dryRun: true }, dry);
      expect(dry.out.join("")).toContain(`edit    ${link} -> ${real} (`);
      const json = fakeIo({ home, userHome, cwd: dir });
      await runSync({ ...SYNC, json: true }, json);
      const planned = JSON.parse(json.out.join("")).plan.changes;
      expect(planned).toContainEqual({
        kind: "edit",
        path: link,
        target: real,
        content: expect.stringContaining(HOOK_COMMAND),
      });

      const io = fakeIo({ home, userHome, cwd: dir });
      await runSync(SYNC, io);
      expect(lstatSync(link).isSymbolicLink()).toBe(true);
      expect(readlinkSync(link)).toBe(real);
      const text = readFileSync(real, "utf8");
      expect(text).toContain(HOOK_COMMAND);
      expect(text).toContain('"theme": "dark"');
      expect(readdirSync(join(userHome, "dotfiles"))).toEqual(["settings.json"]);
      expect((await runSync(SYNC, io)).changed).toEqual([]);
    });
  });

  // Only the user can repoint the link, so the run fails on that harness by name, with the fix,
  // and writes nothing in the link's place or behind it.
  const unfollowable: [string, (dir: string) => string, RegExp][] = [
    ["a dangling link", (dir) => join(dir, "gone.json"), /does not exist/],
    [
      "a link to a directory",
      (dir) => {
        mkdirSync(join(dir, "folder"));
        return join(dir, "folder");
      },
      /is not a file/,
    ],
    [
      "a link out of the home",
      (dir) => {
        writeFileSync(join(dir, "elsewhere.json"), "{}\n");
        return join(dir, "elsewhere.json");
      },
      /outside/,
    ],
  ];
  test.each(unfollowable)(
    "%s is refused with the link and the fix",
    async (_label, plant, reason) => {
      await world(async ({ home, userHome, dir }) => {
        const source = writeSource(join(dir, "src"), TWO_MEMORIES);
        writeState(
          home,
          stateWith({ [source]: entryFor(localFrom(source)) }, { global: ["claude-code"] }),
        );
        const target = plant(dir);
        const behind = () =>
          lstatSync(target, { throwIfNoEntry: false })?.isFile()
            ? readFileSync(target, "utf8")
            : undefined;
        const before = behind();
        const link = join(userHome, FIXTURE_DIR, "settings.json");
        symlinkSync(target, link);
        const io = fakeIo({ home, userHome, cwd: dir });
        const error = await expectExit(runSync(SYNC, io), ExitCode.DestinationWriteFailed);
        expect(error.message).toContain(`cannot edit ${link}`);
        expect(error.message).toMatch(reason);
        expect(error.hint).toContain("then run maxims sync");
        expect(lstatSync(link).isSymbolicLink()).toBe(true);
        expect(behind()).toBe(before);
      });
    },
  );

  // The rule file is maxims's whole and the registry the user's: edited through the link, the
  // rule file would hold the registry until the next sync wrote rules over the user's settings.
  // The link is refused by name like a shared file's, and neither file moves.
  test("a link at a rule file maxims owns whole is refused, nothing written", async () => {
    await world(async ({ home, userHome, dir }) => {
      const source = writeSource(join(dir, "src"), TWO_MEMORIES);
      writeState(
        home,
        stateWith({ [source]: entryFor(localFrom(source)) }, { global: ["claude-code"] }),
      );
      const io = fakeIo({ home, userHome, cwd: dir });
      await runSync(SYNC, io);
      const ruleFile = globalRulesFile(userHome, sourceSlug(localFrom(source)));
      writeFileSync(ruleFile, '{ "theme": "dark" }\n');
      const link = join(userHome, FIXTURE_DIR, "settings.json");
      rmSync(link);
      symlinkSync(ruleFile, link);
      const error = await expectExit(runSync(SYNC, io), ExitCode.DestinationWriteFailed);
      expect(error.message).toContain(`cannot edit ${link}: it is a symlink to ${ruleFile}`);
      expect(error.hint).toContain("then run maxims sync");
      expect(readFileSync(ruleFile, "utf8")).toBe('{ "theme": "dark" }\n');
      expect(readlinkSync(link)).toBe(ruleFile);
    });
  });
});
