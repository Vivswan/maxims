// What would drift silently: the hook writer plans a definition's config edit under the same
// `wanted` as the hook, so a source that lists rules without a hook would lose the config entry
// its rules directory needs, and one that switched rules off would keep it; and a hook that
// lives in one place whatever the scope (dsh's bridge under the global root) would be written
// for the scope that wants it and deleted again for the scope that does not.
import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
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
  noFetch: false,
  force: false,
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
