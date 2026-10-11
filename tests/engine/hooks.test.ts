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
import { loadContext } from "../../src/engine/context.ts";
import { type HarnessWants, planHooks } from "../../src/engine/hooks.ts";
import { sourceSlug } from "../../src/engine/slug.ts";
import { claudeCode } from "../../src/harnesses/claude-code/spec.ts";
import { codex } from "../../src/harnesses/codex/spec.ts";
import {
  type HarnessContext,
  type HarnessDefinition,
  HOOK_COMMAND,
  type Scope,
  scopeRoot,
} from "../../src/harnesses/contract.ts";
import { devin } from "../../src/harnesses/devin/spec.ts";
import { dsh } from "../../src/harnesses/dsh/spec.ts";
import { planMcpRegistration } from "../../src/harnesses/mcp-stub/register.ts";
import { applyChanges } from "../../src/util/change.ts";
import { ExitCode } from "../../src/util/exit-codes.ts";
import * as fsUtil from "../../src/util/fs.ts";
import { assertInsideRoot, readIfPresent } from "../../src/util/fs.ts";
import { CHMOD_DENIES, WINDOWS } from "../shared/platform.ts";
import { SYNC } from "../shared/sync_support.ts";
import {
  configEditHarness,
  entryFor,
  FIXTURE_CONFIG_CONTENT,
  FIXTURE_DIR,
  fakeIo,
  localFrom,
  rulesDirHarness,
  sharedBlockHarness,
  stateWith,
  writeSource,
  writeState,
} from "./fakes.ts";
import { expectExit, globalRulesFile, TWO_MEMORIES, world } from "./world.ts";

// The registry write's content is the hook writer's; this test pins only which changes appear:
// the config entry is a write of a file maxims owns, the registry and the servers file edits of
// the user's files.
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
// The rules-dir fixture with a servers file beside its hook registry, or in it.
const serversIn = (file: string, serversPath = ["mcpServers"]): HarnessDefinition => ({
  ...rulesDirHarness,
  mcp: {
    path: (scope: Scope, ctx: HarnessContext) => join(scopeRoot({}, scope, ctx), FIXTURE_DIR, file),
    serversPath,
  },
});
const apart = serversIn("mcp.json");
const together = serversIn("settings.json");

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
  // may be named by the leaf (both declared at a registry linked into a dotfiles checkout), by the
  // file behind the registry's link (a registry linked at the servers file), by the file behind
  // the servers file's link (a servers file linked at the registry), or by a link partway along
  // the chain. Either way a servers change planned from the file's old text would land after the
  // edit and take the hook back out. `end` is the file the edit names when `behind` is a link.
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

  // The servers file is matched to a refused registry by the registry's declared path alone: a
  // containment assertion repeated inside the servers attempt would fail again where the hook's
  // did, and take a servers file apart from the registry down with it.
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

  // Matching the servers file to the refused registry resolves the registry's declared path once
  // more; a folder on the way that cannot be searched is the hook's failure, reported once, and
  // not the servers file's. Both rows name the hook's declared path: which component the kernel
  // refuses differs by platform (`realKeyOf` owns that), and the plan does not.
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
  const shared: [string, HarnessDefinition[], string, unknown][] = [
    [
      "two servers files declared at one file under two keys",
      [hookless("claude-code", ["mcpServers"]), hookless("codex", ["context_servers"])],
      "mcp.json",
      { mcpServers: { maxims: server }, context_servers: { maxims: server } },
    ],
    [
      "two hook registries declared at one file under two events",
      [hookedAt("claude-code", "SessionStart"), hookedAt("codex", "Start")],
      "settings.json",
      { hooks: { SessionStart: [group], Start: [group] } },
    ],
  ];
  test.each(shared)(
    "%s: the file gets one edit holding both",
    async (_label, defs, file, holds) => {
      await world(async ({ home, userHome, dir }) => {
        const io = fakeIo({ home, userHome, cwd: dir, harnesses: defs });
        const ctx = await loadContext(io, { readHookStdin: false });
        const planned = await planHooks({
          ctx,
          harnesses: defs,
          agents: undefined,
          wants: (_id, scope: Scope) => ({
            hook: true,
            rules: false,
            unreachable: scope !== "global",
          }),
          elsewhere: () => [],
          judgeLink: () => undefined,
        });
        const path = join(userHome, FIXTURE_DIR, file);
        expect<unknown[]>(planned.changes.map((change) => change.path)).toEqual([path]);
        const [edit] = planned.changes;
        if (edit?.kind !== "edit") throw new Error("expected the one edit");
        expect(JSON.parse(edit.content)).toEqual(holds);
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
      const plan = (wanted: string[]) =>
        planHooks({
          ctx,
          harnesses: defs,
          agents: undefined,
          wants: (id, scope: Scope) => ({
            hook: wanted.includes(id),
            rules: false,
            unreachable: scope !== "global",
          }),
          elsewhere: () => [],
          judgeLink: () => undefined,
        });
      const both = await plan(["claude-code", "codex"]);
      const [installed] = both.changes;
      if (installed?.kind !== "edit") throw new Error("expected the one edit");
      writeFileSync(path, installed.content);
      const one = await plan(["claude-code"]);
      const parsed = (change: { kind: string; path: string; content?: string }) => [
        change.kind,
        change.path,
        change.content === undefined ? null : JSON.parse(change.content),
      ];
      expect<unknown[]>([one.changes, one.removals.map(parsed), one.failures]).toEqual([
        [],
        [["edit", path, { hooks: { SessionStart: [group] } }]],
        [],
      ]);
      const [removal] = one.removals;
      if (removal?.kind !== "edit") throw new Error("expected the one removal edit");
      writeFileSync(path, removal.content);
      const settled = await plan(["claude-code"]);
      expect([settled.changes, settled.removals, settled.failures]).toEqual([[], [], []]);
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
      const plan = () =>
        planHooks({
          ctx,
          harnesses: defs,
          agents: undefined,
          wants: (id, scope: Scope) => ({
            hook: id === "claude-code",
            rules: false,
            unreachable: scope !== "global",
          }),
          elsewhere: () => [],
          judgeLink: () => undefined,
        });
      const installing = await plan();
      const [installed] = installing.changes;
      if (installed?.kind !== "edit") throw new Error("expected the one edit");
      expect([JSON.parse(installed.content), installing.removals, installing.notices]).toEqual([
        { hooks: { SessionStart: [group] } },
        [],
        [`registered the maxims hook in ${path}`],
      ]);
      writeFileSync(path, installed.content);
      const settled = await plan();
      expect([settled.changes, settled.removals, settled.notices]).toEqual([[], [], []]);
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
      const planned = await planHooks({
        ctx,
        harnesses: defs,
        agents: undefined,
        wants: (id, scope: Scope) => ({
          hook: id !== "claude-code",
          rules: false,
          unreachable: scope !== "global",
        }),
        elsewhere: () => [],
        judgeLink: () => undefined,
      });
      expect([planned.changes.map((change) => basename(change.path)), planned.removals]).toEqual([
        ["settings.json", "other.json"],
        [],
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
      const plan = (wanted: string[]) =>
        planHooks({
          ctx,
          harnesses: defs,
          agents: undefined,
          wants: (id, scope: Scope) => ({
            hook: wanted.includes(id),
            rules: false,
            unreachable: scope !== "global",
          }),
          elsewhere: () => [],
          judgeLink: () => undefined,
        });
      const [installed] = (await plan(["claude-code", "codex"])).changes;
      if (installed?.kind !== "edit") throw new Error("expected the one edit");
      expect(JSON.parse(installed.content)).toEqual({
        "mcp/one": { maxims: server },
        mcp: { one: { maxims: server } },
      });
      writeFileSync(path, installed.content);
      const one = await plan(["claude-code"]);
      expect<unknown[]>([
        one.changes,
        one.removals.map((change) =>
          change.kind === "edit" ? JSON.parse(change.content) : change,
        ),
      ]).toEqual([[], [{ "mcp/one": { maxims: server }, mcp: { one: {} } }]]);
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
  // global scope's removal stands. Settled, nothing writes the leaf, the link stays, and the file
  // behind it is the project's registration: compared by the leaf alone the global removal would
  // take it away, and so would a removal at a link partway along the chain.
  const behindTheLink: [
    string,
    (current: string) => string,
    boolean,
    object[],
    object[],
    object[],
  ][] = [
    [
      "a stale entry behind the link is refused out of the project root, and the global entry still leaves",
      () => '{\n  "mcpServers": {\n    "maxims": {\n      "command": "old"\n    }\n  }\n}\n',
      false,
      [],
      [{ kind: "edit", content: '{\n  "mcpServers": {}\n}\n' }],
      [
        {
          message: expect.stringMatching(/^cannot edit .*: it is a symlink to .*, outside /),
          hint: expect.stringContaining("then run maxims sync"),
        },
      ],
    ],
    [
      "the current entry behind the link is settled and stays",
      (current) => current,
      false,
      [],
      [],
      [],
    ],
    [
      "the current entry behind a chain of links, the global file a link itself, stays",
      (current) => current,
      true,
      [],
      [],
      [],
    ],
  ];
  for (const [label, textBehind, chained, changes, removals, failures] of behindTheLink) {
    test(`a project servers file linked to the global one: ${label}`, async () => {
      await world(async ({ home, userHome, project }) => {
        const hookless: HarnessDefinition = { ...apart, hook: { kind: "none" } };
        const global = join(userHome, FIXTURE_DIR, "mcp.json");
        const linked = join(project, FIXTURE_DIR, "mcp.json");
        const [current] = planMcpRegistration({
          registration: {
            root: userHome,
            path: assertInsideRoot(userHome, global),
            serversPath: ["mcpServers"],
          },
          wanted: true,
          currentText: null,
        }).changes;
        if (current?.kind !== "edit") throw new Error("expected the servers edit");
        const backing = join(userHome, "dotfiles", "mcp.json");
        if (chained) {
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
        expect<unknown[]>(plan.removals).toEqual(
          removals.map((c) => ({ ...c, path: global, target: global })),
        );
        expect<unknown[]>(plan.failures).toEqual(failures);
      });
    });
  }

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
