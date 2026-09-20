// What would drift silently: the hook writer plans a definition's config edit under the same
// `wanted` as the hook, so a source that lists rules without a hook would lose the config entry
// its rules directory needs, and one that switched rules off would keep it. A hook that lives in
// one place whatever the scope (dsh's bridge under the global root) would be written for the scope
// that wants it and deleted again for the scope that does not. When both scopes resolve to one
// registry (a home directory that is itself a git repository), the second sync would remove the
// hook the first one wrote and the third would put it back.
import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  configEditHarness,
  entryFor,
  FIXTURE_CONFIG_CONTENT,
  FIXTURE_DIR,
  fakeIo,
  localFrom,
  stateWith,
  writeSource,
  writeState,
} from "../../../tests/engine/harness.ts";
import { TWO_MEMORIES, world } from "../../../tests/engine/world.ts";
import { claudeCode } from "../../harnesses/claude-code/index.ts";
import { HOOK_COMMAND, type Scope } from "../../harnesses/contract.ts";
import { dsh } from "../../harnesses/dsh/index.ts";
import { runSync } from "../sync.ts";
import type { SyncOptions } from "../types.ts";
import { loadContext } from "./context.ts";
import { type HarnessWants, planHooks } from "./hooks.ts";

const SYNC: SyncOptions = {
  quiet: false,
  dryRun: false,
  json: false,
  fetch: "due",
};

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

describe("a hook that lives in one place for both scopes", () => {
  test("a project-scoped dsh source keeps its bridge files; with no scope wanting them they leave", async () => {
    await world(async ({ home, userHome, dir, project }) => {
      const source = writeSource(join(dir, "src"), TWO_MEMORIES);
      const entry = entryFor(localFrom(source), {
        destination: { scope: "project" },
        harnesses: ["dsh"],
      });
      writeState(home, stateWith({ [source]: entry }, ["dsh"]));
      const io = fakeIo({ home, userHome, cwd: project, harnesses: [dsh] });
      const hooks = join(userHome, ".dsh", "maxims-hooks.json");
      const patch = join(userHome, ".dsh", "cordis.patch.yml");
      for (const run of ["first", "second"]) {
        await runSync(SYNC, io);
        expect([run, readFileSync(hooks, "utf8")]).toEqual([
          run,
          expect.stringContaining(HOOK_COMMAND),
        ]);
        expect(readFileSync(patch, "utf8")).toContain("maxims-hooks");
      }
      writeState(home, stateWith({ [source]: entry }, []));
      await runSync(SYNC, io);
      expect(existsSync(hooks)).toBe(false);
      expect(readFileSync(patch, "utf8")).not.toContain("maxims-hooks");
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
        destination: { scope: "project" },
        harnesses: ["claude-code"],
      });
      writeState(home, stateWith({ [source]: entry }, ["claude-code"]));
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
      writeState(home, stateWith({ [source]: entry }, []));
      await runSync(SYNC, io);
      expect(readFileSync(settings, "utf8")).not.toContain(HOOK_COMMAND);
    });
  });
});
