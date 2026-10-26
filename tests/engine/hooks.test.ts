// What would drift silently:
// - a config edit planned under a different `wanted` than its hook, so a source listing rules
//   without a hook loses the config entry its rules directory needs
// - a hook living in one place for both scopes (dsh's bridge) written for one and deleted for the
//   other, or two scopes resolving to one registry undoing each other run after run
// - a registry kept as a symlink into a dotfiles checkout replaced by a regular file, or edited
//   through a link at a rule file maxims owns whole
// - one registry file planned twice (two scopes, two harnesses, or a hook and its servers entry
//   declared at one file, or linked into one), the later change erasing the earlier
import { describe, expect, spyOn, test } from "bun:test";
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
import { basename, dirname, join, resolve, sep } from "node:path";
import { runSync } from "../../src/commands/sync.ts";
import { type EngineContext, harnessContext, loadContext } from "../../src/engine/context.ts";
import {
  type HarnessWants,
  type HooksPlan,
  hookStatus,
  planHooks,
} from "../../src/engine/hooks.ts";
import { sourceSlug } from "../../src/engine/slug.ts";
import { claudeCode } from "../../src/harnesses/claude-code/spec.ts";
import { codex } from "../../src/harnesses/codex/spec.ts";
import {
  type HarnessContext,
  type HarnessDefinition,
  HOOK_COMMAND,
  HOOK_TIMEOUT_SECONDS,
  hookSpecFor,
  type Scope,
  scopeRoot,
} from "../../src/harnesses/contract.ts";
import { devin } from "../../src/harnesses/devin/spec.ts";
import { BRIDGE_PLUGIN, BRIDGE_ROW_ID } from "../../src/harnesses/dsh/quirks.ts";
import { dsh } from "../../src/harnesses/dsh/spec.ts";
import {
  freshRegistry,
  hasHook,
  hookPath,
  planHookOnly,
  rewriteHookRegistry,
} from "../../src/harnesses/hook-writer.ts";
import { mcpRegistrationAt, rewriteServers } from "../../src/harnesses/mcp-stub/register.ts";
import { applyChanges, type Change } from "../../src/util/change.ts";
import { ExitCode } from "../../src/util/exit-codes.ts";
import * as fsUtil from "../../src/util/fs.ts";
import { assertInsideRoot, readIfPresent } from "../../src/util/fs.ts";
import { JSONC } from "../../src/util/jsonc.ts";
import { CHMOD_DENIES, WINDOWS } from "../shared/platform.ts";
import { SYNC } from "../shared/sync_support.ts";
import {
  configEditHarness,
  entryFor,
  FIXTURE_CONFIG_CONTENT,
  FIXTURE_CONFIG_EMPTIED,
  FIXTURE_DIR,
  fakeIo,
  jsonConfigEditHarness,
  localFrom,
  rulesDirHarness,
  sharedBlockHarness,
  stateWith,
  writeSource,
  writeState,
} from "./fakes.ts";
import { expectExit, globalRulesFile, TWO_MEMORIES, world } from "./world.ts";

const configWrite = (config: string): unknown => ({
  kind: "edit",
  path: config,
  target: config,
  content: FIXTURE_CONFIG_CONTENT,
});
const configEmptied = (config: string): unknown => ({
  kind: "edit",
  path: config,
  target: config,
  content: FIXTURE_CONFIG_EMPTIED,
});
const registryWrite = (registry: string): unknown => ({
  kind: "edit",
  path: registry,
  target: registry,
  content: expect.stringContaining(HOOK_COMMAND),
});
const serversWrite = (servers: string, behind = servers): unknown => ({
  kind: "edit",
  path: servers,
  target: behind,
  content: expect.stringContaining('"mcp-serve"'),
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

// The registry write's content is the hook writer's; this test pins only which changes appear:
// the config entry, the registry and the servers file are each an edit of the user's file.
describe("planHooks", () => {
  for (const [label, wants, expected] of cases) {
    test(`${label}: the config edit follows the rules, the registry entry follows the hook`, async () => {
      await world(async ({ home, userHome, dir }) => {
        const io = fakeIo({ home, userHome, cwd: dir, harnesses: [configEditHarness] });
        const ctx = await loadContext(io, { readHookStdin: false });
        const config = join(userHome, FIXTURE_DIR, "config.json");
        const registry = join(userHome, FIXTURE_DIR, "settings.json");
        // The entry is there to leave when the rules are not wanted, absent to be written when
        // they are, so each row plans the edit its intent calls for.
        if (!wants.rules) writeFileSync(config, FIXTURE_CONFIG_CONTENT);
        const plan = await planHooks({
          ctx,
          harnesses: [configEditHarness],
          agents: undefined,
          wants: (_id, scope: Scope) =>
            scope === "global" ? wants : { ...wants, unreachable: true },
          elsewhere: () => [],
          judgeLink: () => undefined,
        });
        expect<unknown[]>(plan.changes).toEqual(expected(config, registry));
        expect<unknown[]>(plan.removals).toEqual(wants.rules ? [] : [configEmptied(config)]);
        expect(plan.failures).toEqual([]);
      });
    });
  }
});

const serversIn = (file: string, serversPath = ["mcpServers"]): HarnessDefinition => ({
  ...rulesDirHarness,
  mcp: {
    path: (scope: Scope, ctx: HarnessContext) => join(scopeRoot({}, scope, ctx), FIXTURE_DIR, file),
    serversPath,
    format: "jsonc",
  },
});
const apart = serversIn("mcp.json");
const together = serversIn("settings.json");

// The stub server entry is the session-start sync of a harness whose event is the MCP handshake,
// so it follows the hook intent: wanted, it is written beside the hook; unwanted, it leaves as a
// removal. A user-defined harness may keep its hooks and its servers in one file, where two
// changes in one plan would leave whichever landed last.
//
// `serversIn` is the rules-dir fixture with a servers file beside its hook registry (`apart`) or
// in it (`together`).
describe("the MCP server entry follows the hook intent", () => {
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
      expect<unknown[]>(wanted.changes).toEqual([registryWrite(registry), serversWrite(mcp)]);
      expect(wanted.notices).toEqual([
        `registered the maxims hook in ${registry}`,
        `registered the maxims MCP server in ${mcp}`,
      ]);
      const [, written] = wanted.changes;
      if (written?.kind !== "edit") throw new Error("expected the servers edit");
      writeFileSync(mcp, written.content);
      const unwanted = await plan(apart, dir, home, userHome, false);
      expect<unknown[]>(unwanted.removals).toEqual([
        { kind: "edit", path: mcp, target: mcp, content: '{\n  "mcpServers": {}\n}\n' },
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
          format: "jsonc",
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

  // One file the hook and the servers entry name two ways: a servers change planned from its old
  // text would land after the hook's edit and take the hook back out. `end` is the file the edit
  // names when `behind` is itself a link. The file is named by:
  //   both at a registry linked into dotfiles           -> the leaf
  //   a registry linked at the servers file             -> the file behind the registry's link
  //   a servers file linked at the registry             -> the file behind the servers file's link
  //   a registry linked at a servers file that is a link -> a link partway along the chain
  const linkedRegistry: [
    string,
    HarnessDefinition,
    (
      userHome: string,
      registry: string,
      mcp: string,
    ) => { behind: string; link: string; end?: string },
  ][] = [
    [
      "both declared at a registry linked into a dotfiles checkout",
      together,
      (userHome, registry) => {
        mkdirSync(join(userHome, "dotfiles"));
        return { behind: join(userHome, "dotfiles", "settings.json"), link: registry };
      },
    ],
    [
      "a registry linked at the servers file",
      apart,
      (_userHome, registry, mcp) => ({ behind: mcp, link: registry }),
    ],
    [
      "a servers file linked at the registry",
      apart,
      (_userHome, registry, mcp) => ({ behind: registry, link: mcp }),
    ],
    [
      "a registry linked at a servers file that is itself linked into a dotfiles checkout",
      apart,
      (userHome, registry, mcp) => {
        mkdirSync(join(userHome, "dotfiles"));
        const end = join(userHome, "dotfiles", "servers.json");
        symlinkSync(end, mcp);
        return { behind: mcp, link: registry, end };
      },
    ],
  ];
  test.each(linkedRegistry)(
    "%s: the entry rides in the edit behind the link",
    async (_label, def, plant) => {
      await world(async ({ home, userHome, dir }) => {
        const registry = join(userHome, FIXTURE_DIR, "settings.json");
        const mcp = join(userHome, FIXTURE_DIR, "mcp.json");
        const { behind, link, end = behind } = plant(userHome, registry, mcp);
        writeFileSync(behind, '{ "theme": "dark" }\n');
        symlinkSync(behind, link);
        const wanted = await plan(def, dir, home, userHome, true);
        expect<unknown[]>(wanted.changes).toEqual([
          {
            kind: "edit",
            path: registry,
            target: end,
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

  // The refusal tells the user to replace the link with a real file; a servers write of the same
  // file, planned from its old text, would do that replacing itself, and the run's own refusal
  // would be contradicted by what it applied.
  test("in the hook's registry whose link is refused, no write of that file is planned beside the refusal", async () => {
    await world(async ({ home, userHome, dir }) => {
      const outside = join(dir, "outside.json");
      writeFileSync(outside, '{ "theme": "dark" }\n');
      const registry = join(userHome, FIXTURE_DIR, "settings.json");
      symlinkSync(outside, registry);
      const wanted = await plan(together, dir, home, userHome, true);
      expect(wanted).toEqual({
        changes: [],
        removals: [],
        notices: [],
        failures: [
          {
            message: expect.stringContaining(
              `cannot edit ${registry}: it is a symlink to ${outside}, outside `,
            ),
            hint: expect.stringContaining("then run maxims sync"),
          },
        ],
      });
      expect(readFileSync(outside, "utf8")).toBe('{ "theme": "dark" }\n');
    });
  });

  // The servers attempt resolves its own file and never the hook's, so the hook path's containment
  // failure is the hook's alone and a servers file apart from the registry is still edited.
  test("a hook folder linked out of the root fails the hook alone; a servers file apart from it is still written", async () => {
    await world(async ({ home, userHome, dir }) => {
      mkdirSync(join(dir, "elsewhere"));
      symlinkSync(join(dir, "elsewhere"), join(userHome, "fixture-hooks"));
      const registryHook = rulesDirHarness.hook;
      if (registryHook.kind !== "registry") throw new Error("the fixture hook is a registry");
      const hooksApart: HarnessDefinition = {
        ...apart,
        hook: {
          ...registryHook,
          path: (scope: Scope, ctx: HarnessContext) =>
            join(scopeRoot({}, scope, ctx), "fixture-hooks", "settings.json"),
        },
      };
      const mcp = join(userHome, FIXTURE_DIR, "mcp.json");
      const wanted = await plan(hooksApart, dir, home, userHome, true);
      expect<unknown>(wanted).toEqual({
        changes: [serversWrite(mcp)],
        removals: [],
        notices: [`registered the maxims MCP server in ${mcp}`],
        failures: [
          {
            message: expect.stringContaining(`refusing to write outside ${userHome}`),
            hint: undefined,
          },
        ],
      });
    });
  });

  // A folder on the way to the hook registry that cannot be searched fails the hook's own read,
  // reported once, and never the servers file's, which resolves its own path alone. Both rows name
  // the hook's declared path: which component the kernel refuses differs by platform (`realKeyOf`
  // owns that), and the plan does not.
  const sealedHookFolders: [string, (hookFolder: string) => string][] = [
    ["an ancestor of the hook folder", dirname],
    ["the hook folder itself", (hookFolder) => hookFolder],
  ];
  for (const [label, sealedAt] of sealedHookFolders) {
    test.skipIf(!CHMOD_DENIES)(
      `${label} cannot be searched: the hook fails alone and a servers file apart from it is still written`,
      async () => {
        await world(async ({ home, userHome, dir }) => {
          const hookFolder = join(userHome, "locked", "fixture-hooks");
          mkdirSync(hookFolder, { recursive: true });
          const registryHook = rulesDirHarness.hook;
          if (registryHook.kind !== "registry") throw new Error("the fixture hook is a registry");
          const hooksApart: HarnessDefinition = {
            ...apart,
            hook: {
              ...registryHook,
              path: (scope: Scope, ctx: HarnessContext) =>
                join(scopeRoot({}, scope, ctx), "locked", "fixture-hooks", "settings.json"),
            },
          };
          const mcp = join(userHome, FIXTURE_DIR, "mcp.json");
          const sealed = sealedAt(hookFolder);
          chmodSync(sealed, 0o000);
          try {
            const wanted = await plan(hooksApart, dir, home, userHome, true);
            expect<unknown>(wanted).toEqual({
              changes: [serversWrite(mcp)],
              removals: [],
              notices: [`registered the maxims MCP server in ${mcp}`],
              failures: [
                {
                  message: expect.stringContaining(
                    `cannot inspect ${join(hookFolder, "settings.json")}:`,
                  ),
                  hint: undefined,
                },
              ],
            });
          } finally {
            chmodSync(sealed, 0o700);
          }
        });
      },
    );
  }

  // The servers file's link is judged whatever the hook's answer: a chain that reaches the hook's
  // file through a rule file maxims owns whole would otherwise ride in the hook's edit unjudged,
  // and the rules write would then replace the rule file under the servers link.
  test("a servers file linked through a rule file maxims owns whole to the registry is refused, nothing written", async () => {
    await world(async ({ home, userHome, dir }) => {
      const source = writeSource(join(dir, "src"), TWO_MEMORIES);
      const entries = { [source]: entryFor(localFrom(source)) };
      writeState(home, stateWith(entries));
      const io = fakeIo({ home, userHome, cwd: dir, harnesses: [apart] });
      await runSync(SYNC, io);
      const ruleFile = globalRulesFile(userHome, sourceSlug(localFrom(source)));
      const registry = join(userHome, FIXTURE_DIR, "settings.json");
      const mcp = join(userHome, FIXTURE_DIR, "mcp.json");
      writeFileSync(registry, '{ "theme": "dark" }\n');
      rmSync(ruleFile);
      symlinkSync(registry, ruleFile);
      symlinkSync(ruleFile, mcp);
      writeState(home, stateWith(entries, { global: ["claude-code"] }));
      const error = await expectExit(runSync(SYNC, io), ExitCode.DestinationWriteFailed);
      expect(error.message).toContain(
        `cannot edit ${mcp}: it is a symlink to ${ruleFile}, a rule file maxims owns whole`,
      );
      expect(readFileSync(registry, "utf8")).toBe('{ "theme": "dark" }\n');
      expect([readlinkSync(ruleFile), readlinkSync(mcp)]).toEqual([registry, ruleFile]);
    });
  });

  // With the hook settled, or kept in a file of its own, the servers entry is the only change of
  // the servers file, and a servers file the user keeps as a link is edited where the link points:
  // written at the leaf, the link would be replaced by a plain file.
  const serversBehindALink: [
    string,
    HarnessDefinition,
    (registry: string, mcp: string) => string,
    (registry: string, mcp: string, behind: string) => { changes: unknown[]; notices: string[] },
  ][] = [
    [
      "the hook settled in a registry linked into a dotfiles checkout",
      together,
      (registry) => registry,
      (registry, _mcp, behind) => ({
        changes: [serversWrite(registry, behind)],
        notices: [`registered the maxims MCP server in ${registry}`],
      }),
    ],
    [
      "a servers file apart from the registry, linked into a dotfiles checkout",
      apart,
      (_registry, mcp) => mcp,
      (registry, mcp, behind) => ({
        changes: [registryWrite(registry), serversWrite(mcp, behind)],
        notices: [
          `registered the maxims hook in ${registry}`,
          `registered the maxims MCP server in ${mcp}`,
        ],
      }),
    ],
  ];
  test.each(serversBehindALink)(
    "%s: the entry is edited into the file behind the link, and the link survives",
    async (_label, def, linkOf, expected) => {
      await world(async ({ home, userHome, dir }) => {
        const registry = join(userHome, FIXTURE_DIR, "settings.json");
        const mcp = join(userHome, FIXTURE_DIR, "mcp.json");
        const [settledHook] = (await plan(apart, dir, home, userHome, true)).changes;
        if (settledHook?.kind !== "edit") throw new Error("expected the registry edit");
        const link = linkOf(registry, mcp);
        mkdirSync(join(userHome, "dotfiles"));
        const behind = join(userHome, "dotfiles", basename(link));
        writeFileSync(behind, link === registry ? settledHook.content : '{ "theme": "dark" }\n');
        symlinkSync(behind, link);
        const wanted = await plan(def, dir, home, userHome, true);
        expect<unknown>(wanted).toEqual({
          ...expected(registry, mcp, behind),
          removals: [],
          failures: [],
        });
        await applyChanges({ changes: wanted.changes, notices: [] }, { dryRun: false });
        expect(readlinkSync(link)).toBe(behind);
        const text = readFileSync(behind, "utf8");
        expect(text).toContain('"mcp-serve"');
        expect(text).toContain(link === registry ? HOOK_COMMAND : '"theme": "dark"');
        expect((await plan(def, dir, home, userHome, true)).changes).toEqual([]);
      });
    },
  );

  // A file hook is maxims's own file, written whole over any link at its path and deleted on
  // removal, so a servers file whose path, or any link on the way to its file, is the hook file
  // would lose the hook on the add or come back after the remove.
  const atTheHook: [string, string, (hookFile: string, servers: string) => void][] = [
    ["declared at the hook file", "hooks/start", () => undefined],
    [
      "declared at the hook file, a link to a servers file",
      "hooks/start",
      (hookFile) => {
        writeFileSync(join(dirname(hookFile), "config.json"), '{ "mcpServers": {} }\n');
        symlinkSync(join(dirname(hookFile), "config.json"), hookFile);
      },
    ],
    [
      "linked through the hook file to a servers file",
      "servers.json",
      (hookFile, servers) => {
        writeFileSync(join(dirname(hookFile), "config.json"), '{ "mcpServers": {} }\n');
        symlinkSync(join(dirname(hookFile), "config.json"), hookFile);
        symlinkSync(hookFile, servers);
      },
    ],
  ];
  test.each(atTheHook)(
    "a servers file %s is refused with the hook write standing",
    async (_label, serversFile, plant) => {
      await world(async ({ home, userHome, dir }) => {
        const hookFile = join(userHome, FIXTURE_DIR, "hooks", "start");
        const servers = join(userHome, FIXTURE_DIR, serversFile);
        mkdirSync(dirname(hookFile), { recursive: true });
        plant(hookFile, servers);
        const colliding: HarnessDefinition = {
          ...sharedBlockHarness,
          mcp: {
            path: (scope: Scope, ctx: HarnessContext) =>
              join(scopeRoot({}, scope, ctx), FIXTURE_DIR, serversFile),
            serversPath: ["mcpServers"],
            format: "jsonc",
          },
        };
        const wanted = await plan(colliding, dir, home, userHome, true);
        expect<unknown[]>(wanted.changes).toEqual([
          {
            kind: "write",
            path: hookFile,
            content: expect.stringContaining(HOOK_COMMAND),
            mode: 0o755,
          },
        ]);
        expect(wanted.failures).toEqual([
          {
            message: `cannot register the maxims MCP server in ${servers}: it is the maxims hook file`,
            hint: expect.stringContaining("harnesses.json"),
          },
        ]);
      });
    },
  );

  // The collision check resolves the hook file again; a hook folder linked out of the home is the
  // hook's own failure, reported once, and must not cost the servers file declared apart from it.
  test("a hook folder linked out of the home costs the hook alone; the servers file apart from it is registered", async () => {
    await world(async ({ home, userHome, dir }) => {
      mkdirSync(join(dir, "elsewhere"));
      symlinkSync(join(dir, "elsewhere"), join(userHome, FIXTURE_DIR, "hooks"));
      const apartFromFileHook: HarnessDefinition = { ...sharedBlockHarness, mcp: apart.mcp };
      const mcp = join(userHome, FIXTURE_DIR, "mcp.json");
      const wanted = await plan(apartFromFileHook, dir, home, userHome, true);
      expect<unknown[]>(wanted.changes).toEqual([
        { kind: "edit", path: mcp, target: mcp, content: expect.stringContaining('"mcp-serve"') },
      ]);
      expect(wanted.failures.map((failure) => failure.message)).toEqual([
        expect.stringContaining(`refusing to write outside ${userHome}`),
      ]);
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

  // The hook and the servers entry each name the file by their own path, so a failure told apart
  // by its message would print the one file twice.
  test("a registry linked at a servers file that does not parse is reported once, by the hook's path", async () => {
    await world(async ({ home, userHome, dir }) => {
      const mcp = join(userHome, FIXTURE_DIR, "mcp.json");
      const registry = join(userHome, FIXTURE_DIR, "settings.json");
      writeFileSync(mcp, "{ oops");
      symlinkSync(mcp, registry);
      const wanted = await plan(apart, dir, home, userHome, true);
      expect(wanted).toEqual({
        changes: [],
        removals: [],
        notices: [],
        failures: [
          {
            message: `cannot edit ${registry}: it is not valid JSON`,
            hint: "fix the file by hand, then run maxims sync",
          },
        ],
      });
    });
  });
});

// Two user-defined harnesses may declare one file: a settings file both read their hooks from
// under their own events, or a servers file both start servers from under their own keys. Each
// entry planned from the file's old text would land after the other and take it back out.
describe("two harnesses declared at one file", () => {
  const hookless = (id: HarnessDefinition["id"], serversPath: string[]): HarnessDefinition => ({
    ...serversIn("mcp.json", serversPath),
    id,
    hook: { kind: "none" },
  });
  const hookedAt = (id: HarnessDefinition["id"], event: string): HarnessDefinition => {
    if (rulesDirHarness.hook.kind !== "registry") throw new Error("the fixture hook is a registry");
    return {
      ...rulesDirHarness,
      id,
      hook: { ...rulesDirHarness.hook, eventPath: ["hooks", event] },
    };
  };
  const server = { command: "npx", args: ["-y", "@vivswan/maxims", "mcp-serve"] };
  const group = { hooks: [{ type: "command", command: HOOK_COMMAND }] };
  const parsed = (change: Change): unknown[] => [
    change.kind,
    change.path,
    change.kind === "edit" ? change.target : null,
    "content" in change ? JSON.parse(change.content) : null,
  ];
  const whole = (plan: HooksPlan): unknown[] => [
    plan.changes.map(parsed),
    plan.removals.map(parsed),
    plan.failures,
    plan.notices,
  ];
  const plan = (ctx: EngineContext, defs: HarnessDefinition[], wanted: (id: string) => boolean) =>
    planHooks({
      ctx,
      harnesses: defs,
      agents: undefined,
      wants: (id, scope: Scope) => ({
        hook: wanted(id),
        rules: false,
        unreachable: scope !== "global",
      }),
      elsewhere: () => [],
      judgeLink: () => undefined,
    });
  const shared: [string, HarnessDefinition[], string, unknown, string][] = [
    [
      "two servers files declared at one file under two keys",
      [hookless("claude-code", ["mcpServers"]), hookless("codex", ["context_servers"])],
      "mcp.json",
      { mcpServers: { maxims: server }, context_servers: { maxims: server } },
      "MCP server",
    ],
    [
      "two hook registries declared at one file under two events",
      [hookedAt("claude-code", "SessionStart"), hookedAt("codex", "Start")],
      "settings.json",
      { hooks: { SessionStart: [group], Start: [group] } },
      "hook",
    ],
  ];
  test.each(shared)(
    "%s: the file gets one edit holding both",
    async (_label, defs, file, holds, registered) => {
      await world(async ({ home, userHome, dir }) => {
        const io = fakeIo({ home, userHome, cwd: dir, harnesses: defs });
        const ctx = await loadContext(io, { readHookStdin: false });
        const planned = await plan(ctx, defs, () => true);
        const path = join(userHome, FIXTURE_DIR, file);
        const notice = `registered the maxims ${registered} in ${path}`;
        expect(whole(planned)).toEqual([[["edit", path, path, holds]], [], [], [notice, notice]]);
      });
    },
  );

  // The other harness's entry in the shared file is not this harness's artifact at another scope:
  // once only claude-code is wanted, codex's group leaves and claude-code's stays, in one edit.
  test("two hook registries at one file, then one harness wanted: the other's group leaves in one edit", async () => {
    await world(async ({ home, userHome, dir }) => {
      const defs = [hookedAt("claude-code", "SessionStart"), hookedAt("codex", "Start")];
      const io = fakeIo({ home, userHome, cwd: dir, harnesses: defs });
      const ctx = await loadContext(io, { readHookStdin: false });
      const path = join(userHome, FIXTURE_DIR, "settings.json");
      const registered = `registered the maxims hook in ${path}`;
      const both = await plan(ctx, defs, () => true);
      expect(whole(both)).toEqual([
        [["edit", path, path, { hooks: { SessionStart: [group], Start: [group] } }]],
        [],
        [],
        [registered, registered],
      ]);
      const [installed] = both.changes;
      if (installed?.kind !== "edit") throw new Error("expected the one edit");
      writeFileSync(path, installed.content);
      const one = await plan(ctx, defs, (id) => id === "claude-code");
      expect(whole(one)).toEqual([
        [],
        [["edit", path, path, { hooks: { SessionStart: [group] } }]],
        [],
        [`removed the maxims hook from ${path}`],
      ]);
      const [removal] = one.removals;
      if (removal?.kind !== "edit") throw new Error("expected the one removal edit");
      writeFileSync(path, removal.content);
      expect(whole(await plan(ctx, defs, (id) => id === "claude-code"))).toEqual([[], [], [], []]);
    });
  });

  // Two harnesses at one file under one event share the entry itself: the harness that wants it
  // owns it, so the other's leaving removes nothing, on the install and once settled alike.
  test("two hook registries at one file under one event, one harness wanted: the entry stays", async () => {
    await world(async ({ home, userHome, dir }) => {
      const defs = [hookedAt("claude-code", "SessionStart"), hookedAt("codex", "SessionStart")];
      const io = fakeIo({ home, userHome, cwd: dir, harnesses: defs });
      const ctx = await loadContext(io, { readHookStdin: false });
      const path = join(userHome, FIXTURE_DIR, "settings.json");
      const installing = await plan(ctx, defs, (id) => id === "claude-code");
      expect(whole(installing)).toEqual([
        [["edit", path, path, { hooks: { SessionStart: [group] } }]],
        [],
        [],
        [`registered the maxims hook in ${path}`],
      ]);
      const [installed] = installing.changes;
      if (installed?.kind !== "edit") throw new Error("expected the one edit");
      writeFileSync(path, installed.content);
      expect(whole(await plan(ctx, defs, (id) => id === "claude-code"))).toEqual([[], [], [], []]);
    });
  });

  // The plan lists files in the order the harnesses reached them, a file whose first harness
  // leaves it included, so a dry run reads in harness order whatever each harness wants.
  test("a shared file reached first by the harness that leaves it keeps its place in the plan", async () => {
    await world(async ({ home, userHome, dir }) => {
      const other: HarnessDefinition = {
        ...hookedAt("cursor", "SessionStart"),
        hook: {
          ...hookedAt("cursor", "SessionStart").hook,
          path: (scope: Scope, ctx: HarnessContext) =>
            join(scopeRoot({}, scope, ctx), FIXTURE_DIR, "other.json"),
        } as HarnessDefinition["hook"],
      };
      const defs = [
        hookedAt("claude-code", "SessionStart"),
        other,
        hookedAt("codex", "SessionStart"),
      ];
      const io = fakeIo({ home, userHome, cwd: dir, harnesses: defs });
      const ctx = await loadContext(io, { readHookStdin: false });
      const planned = await plan(ctx, defs, (id) => id !== "claude-code");
      const settings = join(userHome, FIXTURE_DIR, "settings.json");
      const otherPath = join(userHome, FIXTURE_DIR, "other.json");
      expect(whole(planned)).toEqual([
        [
          ["edit", settings, settings, { hooks: { SessionStart: [group] } }],
          ["edit", otherPath, otherPath, { hooks: { SessionStart: [group] } }],
        ],
        [],
        [],
        [`registered the maxims hook in ${settings}`, `registered the maxims hook in ${otherPath}`],
      ]);
    });
  });

  // A servers key path is a list of segments, and a segment may hold the separator a flattened
  // spelling would use: ["mcp/one"] and ["mcp", "one"] are two entries, not one.
  test("two servers files at one file under key paths that flatten alike: the unwanted entry leaves", async () => {
    await world(async ({ home, userHome, dir }) => {
      const defs = [hookless("claude-code", ["mcp/one"]), hookless("codex", ["mcp", "one"])];
      const io = fakeIo({ home, userHome, cwd: dir, harnesses: defs });
      const ctx = await loadContext(io, { readHookStdin: false });
      const path = join(userHome, FIXTURE_DIR, "mcp.json");
      const registered = `registered the maxims MCP server in ${path}`;
      const both = await plan(ctx, defs, () => true);
      expect(whole(both)).toEqual([
        [["edit", path, path, { "mcp/one": { maxims: server }, mcp: { one: { maxims: server } } }]],
        [],
        [],
        [registered, registered],
      ]);
      const [installed] = both.changes;
      if (installed?.kind !== "edit") throw new Error("expected the one edit");
      writeFileSync(path, installed.content);
      expect(whole(await plan(ctx, defs, (id) => id === "claude-code"))).toEqual([
        [],
        [["edit", path, path, { "mcp/one": { maxims: server }, mcp: { one: {} } }]],
        [],
        [`removed the maxims MCP server from ${path}`],
      ]);
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

  // Codex's project registry is `.codex/hooks.json` under the project root and its global one
  // `$CODEX_HOME/hooks.json`, so a home that is a repository, a `$CODEX_HOME` under it, and a
  // `~/.codex/hooks.json` linked to the file there make the project edit land in the very file the
  // global removal names. Applied last, that removal would erase the hook on every sync.
  test("a project-scoped source whose linked registry lands in the global registry file keeps its hook", async () => {
    await world(async ({ home, userHome, dir }) => {
      mkdirSync(join(userHome, ".git"));
      const codexHome = join(userHome, "dotfiles", "codex");
      mkdirSync(codexHome, { recursive: true });
      const backing = join(codexHome, "hooks.json");
      const stale = {
        type: "command",
        command: `${HOOK_COMMAND} --agent x`,
        timeout: 20,
        async: true,
        statusMessage: "Syncing maxims",
      };
      writeFileSync(
        backing,
        `${JSON.stringify({ hooks: { SessionStart: [{ hooks: [stale] }] } }, null, 2)}\n`,
      );
      mkdirSync(join(userHome, ".codex"));
      const link = join(userHome, ".codex", "hooks.json");
      symlinkSync(backing, link);
      const source = writeSource(join(dir, "src"), TWO_MEMORIES);
      const entry = entryFor(localFrom(source), {
        destination: { scope: "project", root: userHome },
        harnesses: ["codex"],
      });
      writeState(home, stateWith({ [source]: entry }, { project: { [userHome]: ["codex"] } }));
      const env = { CODEX_HOME: codexHome };
      const ctx = await loadContext(fakeIo({ home, userHome, cwd: userHome, env }), {
        readHookStdin: false,
      });
      const plan = await planHooks({
        ctx,
        harnesses: [codex],
        agents: undefined,
        wants: (_id, scope: Scope) => ({
          hook: scope === "project",
          rules: false,
          unreachable: false,
        }),
        elsewhere: () => [],
        judgeLink: () => undefined,
      });
      expect<unknown[]>(plan.changes).toEqual([
        {
          kind: "edit",
          path: link,
          target: backing,
          content: expect.stringContaining(HOOK_COMMAND),
        },
      ]);
      expect(plan.removals).toEqual([]);
      const io = fakeIo({ home, userHome, cwd: userHome, env, harnesses: [codex] });
      await runSync(SYNC, io);
      const text = readFileSync(backing, "utf8");
      expect([text.includes(HOOK_COMMAND), text.includes("--agent x")]).toEqual([true, false]);
      expect(readlinkSync(link)).toBe(backing);
      expect((await runSync(SYNC, io)).changed).toEqual([]);
    });
  });

  // bun's `realpathSync` reads as the kernel does, so node's fold of `jump/..` to the stray
  // `~/hooks.json` is driven through the seam both scope identities read. Windows folds as node
  // does: nothing to drive.
  for (const wanted of ["global", "project"] as const) {
    test.skipIf(WINDOWS)(
      `a settled registry keeps its hook when the ${wanted} scope wants it: node's realpathSync folds .. lexically where the kernel does not`,
      async () => {
        await world(async ({ home, userHome, dir }) => {
          mkdirSync(join(userHome, ".git"));
          const codexHome = join(userHome, "dotfiles", "codex");
          mkdirSync(join(codexHome, "sub"), { recursive: true });
          const backing = join(codexHome, "hooks.json");
          writeFileSync(backing, "{}\n");
          const stray = join(userHome, "hooks.json");
          writeFileSync(stray, "{}\n");
          symlinkSync(join(codexHome, "sub"), join(userHome, "jump"));
          mkdirSync(join(userHome, ".codex"));
          const link = join(userHome, ".codex", "hooks.json");
          const typed = ["..", "jump", "..", "hooks.json"].join(sep);
          symlinkSync(typed, link);
          const source = writeSource(join(dir, "src"), TWO_MEMORIES);
          const entry = entryFor(localFrom(source), {
            harnesses: ["codex"],
            ...(wanted === "project" ? { destination: { scope: wanted, root: userHome } } : {}),
          });
          const hooks =
            wanted === "global"
              ? { global: ["codex" as const] }
              : { project: { [userHome]: ["codex" as const] } };
          writeState(home, stateWith({ [source]: entry }, hooks));
          const env = { CODEX_HOME: codexHome };
          const io = fakeIo({ home, userHome, cwd: userHome, env, harnesses: [codex] });
          await runSync(SYNC, io);
          const settled = readFileSync(backing, "utf8");
          expect(settled).toContain(HOOK_COMMAND);
          const kernel = fsUtil.realpathOfExistingPrefix;
          const asNodeFolds = (path: string): string =>
            fsUtil.isSymlink(path)
              ? asNodeFolds(resolve(dirname(path), readlinkSync(path)))
              : kernel(path);
          const folded = spyOn(fsUtil, "realpathOfExistingPrefix").mockImplementation(asNodeFolds);
          try {
            expect([asNodeFolds(link), readFileSync(link, "utf8")]).toEqual([stray, settled]);
            const ctx = await loadContext(fakeIo({ home, userHome, cwd: userHome, env }), {
              readHookStdin: false,
            });
            const plan = await planHooks({
              ctx,
              harnesses: [codex],
              agents: undefined,
              wants: (_id, scope: Scope) => ({
                hook: scope === wanted,
                rules: false,
                unreachable: false,
              }),
              elsewhere: () => [],
              judgeLink: () => undefined,
            });
            expect([plan.changes, plan.removals]).toEqual([[], []]);
            expect((await runSync(SYNC, io)).changed).toEqual([]);
            expect([
              readFileSync(backing, "utf8"),
              readlinkSync(link),
              readFileSync(stray, "utf8"),
            ]).toEqual([settled, typed, "{}\n"]);
          } finally {
            folded.mockRestore();
          }
        });
      },
    );
  }

  // A project servers file linked to the global one is the user's link, and the project's write
  // would land out of the project root: it is refused by name, nothing replaces the link, and the
  // global scope's removal stands, behind the global file's own link too. Settled, nothing writes
  // the leaf, the link stays, and the file behind it is the project's registration: compared by
  // the leaf alone the global removal would take it away, and so would a removal at a link partway
  // along the chain.
  const stale = () =>
    '{\n  "mcpServers": {\n    "maxims": {\n      "command": "old"\n    }\n  }\n}\n';
  const settled = (current: string) => current;
  // label, the text behind the link, the global file a link itself, the project entry refused
  const behindTheLink: [string, (current: string) => string, boolean, boolean][] = [
    [
      "a stale entry behind the link is refused out of the project root, and the global entry still leaves",
      stale,
      false,
      true,
    ],
    [
      "a stale entry behind a chain of links is refused, and the global entry still leaves behind its own link",
      stale,
      true,
      true,
    ],
    ["the current entry behind the link is settled and stays", settled, false, false],
    [
      "the current entry behind a chain of links, the global file a link itself, stays",
      settled,
      true,
      false,
    ],
  ];
  for (const [label, textBehind, chained, refused] of behindTheLink) {
    test(`a project servers file linked to the global one: ${label}`, async () => {
      await world(async ({ home, userHome, project }) => {
        const hookless: HarnessDefinition = { ...apart, hook: { kind: "none" } };
        const global = join(userHome, FIXTURE_DIR, "mcp.json");
        const linked = join(project, FIXTURE_DIR, "mcp.json");
        const current = rewriteServers({
          registration: {
            root: userHome,
            path: assertInsideRoot(userHome, global),
            serversPath: ["mcpServers"],
            reader: JSONC,
          },
          wanted: true,
          currentText: null,
        });
        if (current === null) throw new Error("expected the servers text");
        const backing = join(userHome, "dotfiles", "mcp.json");
        if (chained) {
          mkdirSync(join(userHome, "dotfiles"));
          writeFileSync(backing, textBehind(current.text));
          symlinkSync(backing, global);
        } else {
          writeFileSync(global, textBehind(current.text));
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
        const behind = chained ? backing : global;
        expect<unknown>(plan).toEqual({
          changes: [],
          removals: refused
            ? [
                {
                  kind: "edit",
                  path: global,
                  target: behind,
                  content: '{\n  "mcpServers": {}\n}\n',
                },
              ]
            : [],
          notices: refused ? [`removed the maxims MCP server from ${global}`] : [],
          failures: refused
            ? [
                {
                  message: `cannot edit ${linked}: it is a symlink to ${behind}, outside ${project}`,
                  hint: expect.stringContaining("then run maxims sync"),
                },
              ]
            : [],
        });
      });
    });
  }

  // One file reached by two harnesses, one of them through a link out of its root: each altering
  // rewrite mints its own edit, so the refusal does not depend on which harness altered the file
  // first.
  const orders: [string, boolean][] = [
    ["the global harness first", true],
    ["the project harness first", false],
  ];
  test.each(orders)(
    "a project servers file linked to the global one, another harness wanting the global file, %s: the project entry is refused",
    async (_label, globalFirst) => {
      await world(async ({ home, userHome, project }) => {
        const global = join(userHome, FIXTURE_DIR, "mcp.json");
        const linked = join(project, FIXTURE_DIR, "mcp.json");
        writeFileSync(global, "{}\n");
        symlinkSync(global, linked);
        const atGlobal: HarnessDefinition = { ...apart, hook: { kind: "none" } };
        const atProject: HarnessDefinition = {
          ...serversIn("mcp.json", ["context_servers"]),
          id: "codex",
          hook: { kind: "none" },
        };
        const defs = globalFirst ? [atGlobal, atProject] : [atProject, atGlobal];
        const io = fakeIo({ home, userHome, cwd: project, harnesses: defs });
        const ctx = await loadContext(io, { readHookStdin: false });
        const plan = await planHooks({
          ctx,
          harnesses: defs,
          agents: undefined,
          wants: (id, scope: Scope) => {
            const own: Scope = id === atGlobal.id ? "global" : "project";
            return { hook: scope === own, rules: false, unreachable: scope !== own };
          },
          elsewhere: () => [],
          judgeLink: () => undefined,
        });
        const server = { command: "npx", args: ["-y", "@vivswan/maxims", "mcp-serve"] };
        expect<unknown>(plan).toEqual({
          changes: [{ kind: "edit", path: global, target: global, content: expect.any(String) }],
          removals: [],
          notices: [`registered the maxims MCP server in ${global}`],
          failures: [
            {
              message: `cannot edit ${linked}: it is a symlink to ${global}, outside ${project}`,
              hint: expect.stringContaining("then run maxims sync"),
            },
          ],
        });
        const [edit] = plan.changes;
        if (edit?.kind !== "edit") throw new Error("expected the global edit");
        expect(JSON.parse(edit.content)).toEqual({ mcpServers: { maxims: server } });
      });
    },
  );

  // The intent says the entry leaves, and the file holding it is reached through a link the edit
  // refuses: the removal that cannot happen is this run's failure, wanted or not, or the entry
  // stays installed with nothing said.
  test("a project servers file linked out of the project root, the entry to leave behind it: the refusal is reported", async () => {
    await world(async ({ home, userHome, project }) => {
      const hookless: HarnessDefinition = { ...apart, hook: { kind: "none" } };
      const global = join(userHome, FIXTURE_DIR, "mcp.json");
      const linked = join(project, FIXTURE_DIR, "mcp.json");
      const current = rewriteServers({
        registration: {
          root: userHome,
          path: assertInsideRoot(userHome, global),
          serversPath: ["mcpServers"],
          reader: JSONC,
        },
        wanted: true,
        currentText: null,
      });
      if (current === null) throw new Error("expected the servers text");
      writeFileSync(global, current.text);
      symlinkSync(global, linked);
      const io = fakeIo({ home, userHome, cwd: project, harnesses: [hookless] });
      const ctx = await loadContext(io, { readHookStdin: false });
      const plan = await planHooks({
        ctx,
        harnesses: [hookless],
        agents: undefined,
        wants: (_id, scope: Scope) => ({
          hook: false,
          rules: false,
          unreachable: scope !== "project",
        }),
        elsewhere: () => [],
        judgeLink: () => undefined,
      });
      expect<unknown>(plan).toEqual({
        changes: [],
        removals: [],
        notices: [],
        failures: [
          {
            message: `cannot edit ${linked}: it is a symlink to ${global}, outside ${project}`,
            hint: expect.stringContaining("then run maxims sync"),
          },
        ],
      });
    });
  });

  // Home as the project root puts the global servers file inside the project, so Devin's project
  // hook registry may be linked to it; the wanted entry beside the stale one keeps only itself.
  test("Devin's project hook registry linked to the global servers file holding a stale entry: the hook lands and the entry leaves in one edit", async () => {
    await world(async ({ home, userHome }) => {
      if (!hasHook(devin, "registry")) throw new Error("Devin's hook is a registry");
      mkdirSync(join(userHome, ".git"));
      const io = fakeIo({ home, userHome, cwd: userHome, harnesses: [devin] });
      const ctx = await loadContext(io, { readHookStdin: false });
      const harnessCtx = harnessContext(ctx);
      const registry = hookPath(devin, "project", harnessCtx);
      const servers = mcpRegistrationAt(devin, "global", harnessCtx);
      const projectServers = mcpRegistrationAt(devin, "project", harnessCtx);
      if (servers === null || projectServers === null) throw new Error("Devin declares servers");
      for (const file of [registry, servers.path]) mkdirSync(dirname(file), { recursive: true });
      const stale = rewriteServers({ registration: servers, wanted: true, currentText: null });
      if (stale === null) throw new Error("expected the servers text");
      writeFileSync(servers.path, stale.text);
      symlinkSync(servers.path, registry);
      const plan = await planHooks({
        ctx,
        harnesses: [devin],
        agents: undefined,
        wants: (_id, scope: Scope) => ({
          hook: scope === "project",
          rules: false,
          unreachable: false,
        }),
        elsewhere: () => [],
        judgeLink: () => undefined,
      });
      const parsed = (change: Change): unknown[] => [
        change.kind,
        change.path,
        change.kind === "edit" ? change.target : null,
        "content" in change ? JSON.parse(change.content) : null,
      ];
      const handler = { type: "command", command: HOOK_COMMAND, timeout: HOOK_TIMEOUT_SECONDS };
      const server = { command: "npx", args: ["-y", "@vivswan/maxims", "mcp-serve"] };
      expect([plan.changes.map(parsed), plan.removals, plan.failures, plan.notices]).toEqual([
        [
          [
            "edit",
            registry,
            servers.path,
            { mcpServers: {}, hooks: { SessionStart: [{ hooks: [handler] }] } },
          ],
          ["edit", projectServers.path, projectServers.path, { mcpServers: { maxims: server } }],
        ],
        [],
        [],
        [
          `registered the maxims hook in ${registry}`,
          `removed the maxims MCP server from ${servers.path}`,
          `registered the maxims MCP server in ${projectServers.path}`,
        ],
      ]);
    });
  });

  // A file hook is maxims's own file, written whole: a servers file of the other scope linked to it
  // holds no entry of the user's to remove, and the removal edit, applied after the hook's write,
  // would replace the hook with JSON. Home as the project root puts the file inside both roots.
  test("a global servers file linked to the wanted project file hook: its removal is dropped, the hook written", async () => {
    await world(async ({ home, userHome }) => {
      if (!hasHook(sharedBlockHarness, "file")) throw new Error("the fixture hook is a file");
      mkdirSync(join(userHome, ".git"));
      const folderOf = (scope: Scope) => (scope === "project" ? ".fixture-project" : FIXTURE_DIR);
      const perScope: HarnessDefinition = {
        ...sharedBlockHarness,
        hook: {
          ...sharedBlockHarness.hook,
          path: (scope: Scope, ctx: HarnessContext) =>
            join(scopeRoot({}, scope, ctx), folderOf(scope), "hooks", "start"),
        },
        mcp: {
          path: (scope: Scope, ctx: HarnessContext) =>
            join(scopeRoot({}, scope, ctx), folderOf(scope), "mcp.json"),
          serversPath: ["mcpServers"],
          format: "jsonc",
        },
      };
      const hookFile = join(userHome, ".fixture-project", "hooks", "start");
      const projectServers = join(userHome, ".fixture-project", "mcp.json");
      const globalServers = join(userHome, FIXTURE_DIR, "mcp.json");
      mkdirSync(dirname(hookFile), { recursive: true });
      writeFileSync(hookFile, '{ "mcpServers": { "maxims": { "command": "old" } } }\n');
      symlinkSync(hookFile, globalServers);
      const io = fakeIo({ home, userHome, cwd: userHome, harnesses: [perScope] });
      const ctx = await loadContext(io, { readHookStdin: false });
      const plan = await planHooks({
        ctx,
        harnesses: [perScope],
        agents: undefined,
        wants: (_id, scope: Scope) => ({
          hook: scope === "project",
          rules: false,
          unreachable: false,
        }),
        elsewhere: () => [],
        judgeLink: () => undefined,
      });
      expect<unknown>(plan).toEqual({
        changes: [
          {
            kind: "write",
            path: hookFile,
            content: expect.stringContaining(HOOK_COMMAND),
            mode: 0o755,
          },
          {
            kind: "edit",
            path: projectServers,
            target: projectServers,
            content: expect.stringContaining('"mcp-serve"'),
          },
        ],
        removals: [],
        failures: [],
        notices: [
          `wrote the maxims hook to ${hookFile}`,
          `registered the maxims MCP server in ${projectServers}`,
        ],
      });
    });
  });

  // list and doctor judge the hook through planHookOnly, so a hook settled behind a project
  // registry linked out of the project root reads current there, as sync plans nothing for it.
  test("a hook settled behind a project registry linked out of the project root is current for list and doctor", async () => {
    await world(async ({ home, userHome, project }) => {
      if (!hasHook(rulesDirHarness, "registry")) throw new Error("the fixture hook is a registry");
      const global = join(userHome, FIXTURE_DIR, "settings.json");
      const linked = join(project, FIXTURE_DIR, "settings.json");
      const io = fakeIo({ home, userHome, cwd: project, harnesses: [rulesDirHarness] });
      const ctx = await loadContext(io, { readHookStdin: false });
      const harnessCtx = harnessContext(ctx);
      const fresh = rewriteHookRegistry({
        def: rulesDirHarness,
        scope: "project",
        ctx: harnessCtx,
        wanted: true,
        currentText: null,
      });
      if (fresh === null) throw new Error("expected the fresh registry");
      writeFileSync(global, fresh.text);
      symlinkSync(global, linked);
      const state = stateWith({}, { project: { [project]: ["claude-code"] } });
      expect(
        await hookStatus(rulesDirHarness, "project", state, project, harnessCtx, planHookOnly),
      ).toBe("current");
    });
  });

  // A home that is itself a repository makes the two scopes' hook registries one file while a
  // definition naming its servers file per scope keeps two: the one registry is then edited once
  // for both scopes, each servers file once for its own.
  test("one registry for both scopes and a servers file per scope: the registry is edited once", async () => {
    await world(async ({ home, userHome }) => {
      mkdirSync(join(userHome, ".git"));
      const perScope: HarnessDefinition = {
        ...rulesDirHarness,
        mcp: {
          path: (scope: Scope, ctx: HarnessContext) =>
            join(scopeRoot({}, scope, ctx), FIXTURE_DIR, `${scope}-mcp.json`),
          serversPath: ["mcpServers"],
          format: "jsonc",
        },
      };
      const io = fakeIo({ home, userHome, cwd: userHome, harnesses: [perScope] });
      const ctx = await loadContext(io, { readHookStdin: false });
      const planned = await planHooks({
        ctx,
        harnesses: [perScope],
        agents: undefined,
        wants: () => ({ hook: true, rules: false, unreachable: false }),
        elsewhere: () => [],
        judgeLink: () => undefined,
      });
      const server = { command: "npx", args: ["-y", "@vivswan/maxims", "mcp-serve"] };
      const hook = { hooks: [{ type: "command", command: HOOK_COMMAND }] };
      expect<unknown[]>(
        planned.changes.map((change) => [
          change.path,
          change.kind === "edit" ? JSON.parse(change.content) : change.kind,
        ]),
      ).toEqual([
        [join(userHome, FIXTURE_DIR, "settings.json"), { hooks: { SessionStart: [hook] } }],
        [join(userHome, FIXTURE_DIR, "global-mcp.json"), { mcpServers: { maxims: server } }],
        [join(userHome, FIXTURE_DIR, "project-mcp.json"), { mcpServers: { maxims: server } }],
      ]);
      expect([planned.removals, planned.failures]).toEqual([[], []]);
    });
  });
});

// Built-in registries a user has linked into one file. Each entry planned from the file's old
// text would land after the other and take it back out, and a write at a link partway along the
// chain would replace the link with a file holding only its own entry.
describe("built-in registries linked into one file", () => {
  type Linked = { end: string; links: string[]; holds: string[] };
  const rows: [string, HarnessDefinition[], (project: string) => Linked][] = [
    [
      "Devin's registry linked at its servers file, itself linked into a dotfiles checkout",
      [devin],
      (project) => {
        const end = join(project, "dotfiles", "devin.json");
        const servers = join(project, ".devin", "mcp_config.json");
        const registry = join(project, ".devin", "config.json");
        symlinkSync(end, servers);
        symlinkSync(servers, registry);
        return { end, links: [servers, registry], holds: ['"mcp-serve"'] };
      },
    ],
    [
      "Claude Code's registry linked at Devin's servers file",
      [claudeCode, devin],
      (project) => {
        const end = join(project, ".devin", "mcp_config.json");
        const registry = join(project, ".claude", "settings.json");
        writeFileSync(end, '{ "theme": "dark" }\n');
        symlinkSync(end, registry);
        return { end, links: [registry], holds: ['"mcp-serve"'] };
      },
    ],
    [
      "Codex's and Devin's registries linked at one dotfiles file",
      [codex, devin],
      (project) => {
        const end = join(project, "dotfiles", "hooks.json");
        const links = [
          join(project, ".codex", "hooks.json"),
          join(project, ".devin", "config.json"),
        ];
        for (const link of links) symlinkSync(end, link);
        return { end, links, holds: [] };
      },
    ],
  ];
  test.each(rows)(
    "%s: one edit lands behind the links, which survive",
    async (_label, defs, plant) => {
      await world(async ({ home, userHome, dir, project }) => {
        for (const folder of [".claude", ".codex", ".devin", "dotfiles"]) {
          mkdirSync(join(project, folder), { recursive: true });
        }
        const linked = plant(project);
        if (!existsSync(linked.end)) writeFileSync(linked.end, '{ "theme": "dark" }\n');
        const ids = defs.map((def) => def.id);
        const source = writeSource(join(dir, "src"), TWO_MEMORIES);
        const entry = entryFor(localFrom(source), {
          destination: { scope: "project", root: project },
          harnesses: ids,
        });
        writeState(home, stateWith({ [source]: entry }, { project: { [project]: ids } }));
        const io = fakeIo({ home, userHome, cwd: project, harnesses: defs });
        const report = await runSync(SYNC, io);
        const edits = report.plan.changes.filter(
          (change) => change.kind === "edit" && change.target === linked.end,
        );
        expect(edits.map((change) => change.kind)).toEqual(["edit"]);
        for (const link of linked.links) expect(lstatSync(link).isSymbolicLink()).toBe(true);
        const text = readFileSync(linked.end, "utf8");
        for (const held of [HOOK_COMMAND, '"theme": "dark"', ...linked.holds]) {
          expect([held, text.includes(held)]).toEqual([held, true]);
        }
        expect((await runSync(SYNC, io)).changed).toEqual([]);
      });
    },
  );

  // Codex's handler carries `async` and `statusMessage` and Devin's does not, so over one file each
  // wanted rewrite replaces the other's and the second restores the first's bytes: the pair plans
  // no change and no notice, and the servers file apart from it is still registered.
  test("Codex's and Devin's registries linked at one file holding Devin's form: the rewrites cancel", async () => {
    await world(async ({ home, userHome, project }) => {
      for (const folder of [".codex", ".devin", "dotfiles"]) {
        mkdirSync(join(project, folder), { recursive: true });
      }
      if (devin.hook.kind !== "registry") throw new Error("Devin's hook is a registry");
      const end = join(project, "dotfiles", "hooks.json");
      writeFileSync(end, freshRegistry(devin.hook, devin.hook.handler(hookSpecFor(devin))));
      const links = [join(project, ".codex", "hooks.json"), join(project, ".devin", "config.json")];
      for (const link of links) symlinkSync(end, link);
      const defs = [codex, devin];
      const io = fakeIo({ home, userHome, cwd: project, harnesses: defs });
      const ctx = await loadContext(io, { readHookStdin: false });
      const planned = await planHooks({
        ctx,
        harnesses: defs,
        agents: undefined,
        wants: (_id, scope: Scope) => ({
          hook: true,
          rules: false,
          unreachable: scope !== "project",
        }),
        elsewhere: () => [],
        judgeLink: () => undefined,
      });
      const servers = join(project, ".devin", "mcp_config.json");
      expect<unknown>(planned).toEqual({
        changes: [
          {
            kind: "edit",
            path: servers,
            target: servers,
            content: expect.stringContaining('"mcp-serve"'),
          },
        ],
        removals: [],
        notices: [`registered the maxims MCP server in ${servers}`],
        failures: [],
      });
    });
  });
});

describe("a config edit is the planner's to mint", () => {
  // Claude's registry linked at the config another harness lists its rules in: planned apart, the
  // config edit was a second edit of one backing file from the original bytes, and whichever
  // applied last took the other out until the next sync. One text per file holds for a config too.
  test("a config linked at .claude/settings.json takes Claude's hook and the rules entry in one edit", async () => {
    await world(async ({ home, userHome, dir, project }) => {
      mkdirSync(join(project, ".claude"));
      const config = join(project, FIXTURE_DIR, "config.json");
      writeFileSync(config, '{ "model": "x" }\n');
      const registry = join(project, ".claude", "settings.json");
      symlinkSync(config, registry);
      const source = writeSource(join(dir, "src"), TWO_MEMORIES);
      const entry = entryFor(localFrom(source), {
        destination: { scope: "project", root: project },
        harnesses: ["claude-code", "cursor"],
      });
      writeState(home, stateWith({ [source]: entry }, { project: { [project]: ["claude-code"] } }));
      const io = fakeIo({
        home,
        userHome,
        cwd: project,
        harnesses: [claudeCode, jsonConfigEditHarness],
      });
      const report = await runSync(SYNC, io);
      const edits = report.plan.changes.flatMap((change) =>
        change.kind === "edit" ? [[String(change.path), String(change.target)]] : [],
      );
      expect(edits).toEqual([[registry, config]]);
      const text = readFileSync(config, "utf8");
      expect([HOOK_COMMAND, '"instructions"', '"model": "x"'].map((s) => text.includes(s))).toEqual(
        [true, true, true],
      );
      expect((await runSync(SYNC, io)).changed).toEqual([]);
    });
  });

  // The entry must leave and cannot: a refusal raised while removing was recorded only while the
  // entry was wanted, so it stayed behind the link with nothing said. The edit is minted where a
  // registry's is, under the same reporting.
  test("removing the rules entry behind a link out of the project is reported", async () => {
    await world(async ({ home, userHome, dir, project }) => {
      const outside = join(dir, "elsewhere", "config.json");
      const listed = '{"instructions":["rules"]}\n';
      mkdirSync(join(dir, "elsewhere"));
      writeFileSync(outside, listed);
      const link = join(project, FIXTURE_DIR, "config.json");
      symlinkSync(outside, link);
      const io = fakeIo({ home, userHome, cwd: project, harnesses: [jsonConfigEditHarness] });
      const ctx = await loadContext(io, { readHookStdin: false });
      const plan = await planHooks({
        ctx,
        harnesses: [jsonConfigEditHarness],
        agents: undefined,
        wants: (_id, scope) => ({ hook: false, rules: false, unreachable: scope !== "project" }),
        elsewhere: () => [],
        judgeLink: () => undefined,
      });
      expect(plan).toEqual({
        changes: [],
        removals: [],
        notices: [],
        failures: [
          {
            message: `cannot edit ${link}: it is a symlink to ${outside}, outside ${project}`,
            hint: expect.stringContaining("then run maxims sync"),
          },
        ],
      });
      expect(readFileSync(outside, "utf8")).toBe(listed);
    });
  });

  // The bridge is one artifact: with the row unremovable, the hooks file it points at stays too,
  // and the run says why instead of planning nothing.
  test("removing the dsh bridge behind a patch file linked out of DSH_HOME is reported, the hooks file kept", async () => {
    await world(async ({ home, userHome, dir }) => {
      const dshHome = join(userHome, ".dsh");
      mkdirSync(dshHome);
      const hooks = join(dshHome, "maxims-hooks.json");
      writeFileSync(hooks, "{}\n");
      const outside = join(dir, "elsewhere", "cordis.patch.yml");
      const mounted = `- insert:\n    - id: ${BRIDGE_ROW_ID}\n      name: "${BRIDGE_PLUGIN}"\n      config:\n        configPath: ${hooks}\n`;
      mkdirSync(join(dir, "elsewhere"));
      writeFileSync(outside, mounted);
      const link = join(dshHome, "cordis.patch.yml");
      symlinkSync(outside, link);
      const io = fakeIo({ home, userHome, cwd: dir, harnesses: [dsh] });
      const ctx = await loadContext(io, { readHookStdin: false });
      const plan = await planHooks({
        ctx,
        harnesses: [dsh],
        agents: undefined,
        wants: (_id, scope) => ({ hook: false, rules: false, unreachable: scope !== "global" }),
        elsewhere: () => [],
        judgeLink: () => undefined,
      });
      expect(plan).toEqual({
        changes: [],
        removals: [],
        notices: [],
        failures: [
          {
            message: `cannot edit ${link}: it is a symlink to ${outside}, outside ${dshHome}`,
            hint: expect.stringContaining("then run maxims sync"),
          },
        ],
      });
      expect([existsSync(hooks), readFileSync(outside, "utf8")]).toEqual([true, mounted]);
    });
  });

  // The row points at the hooks file, so the file is written first: a hooks-file write that fails
  // at apply stops the plan there, with no row mounted over a file that is not there.
  test("the dsh bridge plans its hooks file before the patch row", async () => {
    await world(async ({ home, userHome, dir }) => {
      mkdirSync(join(userHome, ".dsh"));
      writeFileSync(join(userHome, ".dsh", "cordis.patch.yml"), "[]\n");
      const io = fakeIo({ home, userHome, cwd: dir, harnesses: [dsh] });
      const ctx = await loadContext(io, { readHookStdin: false });
      const plan = await planHooks({
        ctx,
        harnesses: [dsh],
        agents: undefined,
        wants: (_id, scope) => ({ hook: true, rules: false, unreachable: scope !== "global" }),
        elsewhere: () => [],
        judgeLink: () => undefined,
      });
      expect(plan.changes.map((change) => [change.kind, basename(change.path)])).toEqual([
        ["write", "maxims-hooks.json"],
        ["edit", "cordis.patch.yml"],
      ]);
    });
  });
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
