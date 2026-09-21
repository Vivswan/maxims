// What would drift silently: a verb order that leaves bytes a fresh install of the same final
// intent never writes (a stale rule line after a narrowing, a body link nobody points at, a hook
// entry a removal forgot), a sync that keeps changing an idle machine, a store or destination that
// a sync cannot rebuild from state alone, an orphan the sweep misses, or two sources sharing a
// folder name landing in one store entry. Every property drives the real engine in-process over
// hand-written local sources and compares the bytes on disk, never the log.
import { expect, test } from "bun:test";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import fc from "fast-check";
import { HOOK_COMMAND } from "../../src/harnesses/contract.ts";
import { emptyState } from "../../src/state/schema.ts";
import { WRITTEN_BY } from "../../src/state/store.ts";
import { homePaths } from "../../src/util/home.ts";
import { type MemorySpec, writeMemories } from "../chaos/shared/fixture-repo.ts";
import { type RealWorld, runReal, withRealWorld } from "../chaos/shared/real-cli.ts";
import { snapshot } from "../e2e/fixtures.ts";
import { checkProperty, PROPERTY_TIMEOUT_MS } from "./property.ts";

// A source as the generators name it: its folder under the world and the memories it ships.
type Fixture = { name: string; memories: Record<string, MemorySpec> };

// Three sources with disjoint names, so any order of adds is free of collisions.
const FIXTURES: Fixture[] = [
  {
    name: "alpha",
    memories: {
      "alpha-one": { description: "Alpha rule one." },
      "alpha-two": { description: "Alpha rule two." },
      "alpha-three": { description: "Alpha rule three." },
    },
  },
  {
    name: "beta",
    memories: {
      "beta-one": { description: "Beta rule one." },
      "beta-two": { description: "Beta rule two." },
    },
  },
  {
    name: "gamma",
    memories: {
      "gamma-one": { description: "Gamma rule one." },
      "gamma-two": { description: "Gamma rule two." },
      "gamma-three": { description: "Gamma rule three." },
    },
  },
];

function namesOf(fixture: Fixture): string[] {
  return Object.keys(fixture.memories).sort();
}

function pathOf(world: RealWorld, fixture: Fixture): string {
  return join(world.dir, "sources", fixture.name);
}

async function withSources<T>(project: boolean, fn: (world: RealWorld) => Promise<T>): Promise<T> {
  return withRealWorld({ project }, async (world) => {
    for (const fixture of FIXTURES) writeMemories(pathOf(world, fixture), fixture.memories);
    return fn(world);
  });
}

type AddOp = { kind: "add"; fixture: Fixture; subset: string[] | null };
type Op =
  | AddOp
  | { kind: "remove"; fixture: Fixture }
  | { kind: "remove-memory"; fixture: Fixture; name: string }
  | { kind: "sync" };

const fixtureArb = fc.constantFrom(...FIXTURES);

const addOp: fc.Arbitrary<AddOp> = fixtureArb.chain((fixture) =>
  fc.record({
    kind: fc.constant("add" as const),
    fixture: fc.constant(fixture),
    subset: fc.option(fc.subarray(namesOf(fixture), { minLength: 1 }), { nil: null }),
  }),
);

const op: fc.Arbitrary<Op> = fc.oneof(
  addOp,
  fixtureArb.map((fixture): Op => ({ kind: "remove", fixture })),
  fixtureArb.chain((fixture) =>
    fc
      .constantFrom(...namesOf(fixture))
      .map((name): Op => ({ kind: "remove-memory", fixture, name })),
  ),
  fc.constant<Op>({ kind: "sync" }),
);

const sequence = fc.array(op, { minLength: 3, maxLength: 8 });

// The intent a sequence leaves behind: per source, every memory or the sorted names kept.
type Selection = "*" | string[];
type Model = Map<Fixture, Selection>;

// Applies one op to the model and returns the exit the command line must answer with: a removal
// naming a source that is not installed is a usage error, a memory that is not selected is a
// notice, and the last selected memory leaving takes the source with it.
function applyToModel(model: Model, step: Op): number {
  switch (step.kind) {
    case "add":
      model.set(step.fixture, step.subset === null ? "*" : [...step.subset].sort());
      return 0;
    case "remove":
      return model.delete(step.fixture) ? 0 : 1;
    case "remove-memory": {
      const selection = model.get(step.fixture);
      if (selection === undefined) return 1;
      const selected = selection === "*" ? namesOf(step.fixture) : selection;
      if (!selected.includes(step.name)) return 0;
      const remaining = selected.filter((name) => name !== step.name);
      if (remaining.length === 0) model.delete(step.fixture);
      else model.set(step.fixture, remaining);
      return 0;
    }
    case "sync":
      return 0;
  }
}

const ADD_FLAGS = ["--rule", "-a", "claude-code", "-y"];

function addArgv(
  world: RealWorld,
  fixture: Fixture,
  subset: string[] | null,
  scope: "-g" | "-p",
  extra: string[] = [],
): string[] {
  const select = subset === null ? [] : ["-m", subset.join(",")];
  return ["add", pathOf(world, fixture), scope, ...ADD_FLAGS, ...extra, ...select];
}

async function runOp(world: RealWorld, step: Op): Promise<number> {
  switch (step.kind) {
    case "add":
      return (await runReal(world, addArgv(world, step.fixture, step.subset, "-g"))).code;
    case "remove":
      return (await runReal(world, ["remove", pathOf(world, step.fixture), "-y"])).code;
    case "remove-memory":
      return (await runReal(world, ["remove", pathOf(world, step.fixture), "-m", step.name, "-y"]))
        .code;
    case "sync":
      return (await runReal(world, ["sync"])).code;
  }
}

async function runSequence(world: RealWorld, steps: Op[]): Promise<Model> {
  const model: Model = new Map();
  for (const step of steps) {
    const expected = applyToModel(model, step);
    const code = await runOp(world, step);
    expect({ step, code }).toEqual({ step, code: expected });
  }
  return model;
}

// Regular files and links only: a sweep may leave an emptied folder behind, and a folder holds no
// rule, body or registry entry a harness reads.
function fileSnapshot(root: string, skip: string[]): Map<string, string> {
  return new Map([...snapshot(root, skip)].filter(([, digest]) => digest !== "dir"));
}

const RUN_RECORDS = [
  ".agents/maxims/log",
  ".agents/maxims/last-sync",
  ".agents/maxims/state.json.lock",
];
const RUN_RECORDS_AND_STATE = [...RUN_RECORDS, ".agents/maxims/state.json"];

// The recorded state with the two timestamps a fresh install cannot reproduce dropped from every
// source; an absent file is the empty state a removal of the last source leaves behind.
type Intent = Record<string, unknown>;

function intentOf(maximsHome: string): Intent {
  const path = homePaths(maximsHome).state;
  if (!existsSync(path)) return emptyState(WRITTEN_BY);
  const state = JSON.parse(readFileSync(path, "utf8")) as Intent & {
    sources: Record<string, { addedAt: string; fetched?: { at: string } }>;
  };
  const sources: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(state.sources)) {
    const { addedAt: _added, fetched, ...rest } = entry;
    if (fetched === undefined) {
      sources[key] = rest;
      continue;
    }
    const { at: _at, ...facts } = fetched;
    sources[key] = { ...rest, fetched: facts };
  }
  return { ...state, sources };
}

function wipeHome(world: RealWorld): void {
  rmSync(join(world.userHome, ".claude"), { recursive: true, force: true });
  rmSync(world.maximsHome, { recursive: true, force: true });
  mkdirSync(world.maximsHome, { recursive: true });
}

test(
  "sequence equivalence: any order of add, remove and sync leaves the bytes one add per source would",
  async () => {
    await checkProperty(
      "sequence equivalence",
      fc.asyncProperty(sequence, async (steps) => {
        await withSources(false, async (world) => {
          const model = await runSequence(world, steps);
          const sequenced = fileSnapshot(world.userHome, RUN_RECORDS_AND_STATE);
          const sequencedIntent = intentOf(world.maximsHome);
          wipeHome(world);
          for (const fixture of FIXTURES) {
            const selection = model.get(fixture);
            if (selection === undefined) continue;
            const subset = selection === "*" ? null : selection;
            expect((await runReal(world, addArgv(world, fixture, subset, "-g"))).code).toBe(0);
          }
          expect((await runReal(world, ["sync"])).code).toBe(0);
          expect(sequenced).toEqual(fileSnapshot(world.userHome, RUN_RECORDS_AND_STATE));
          expect(sequencedIntent).toEqual(intentOf(world.maximsHome));
          expect(Object.keys(sequencedIntent.sources as object)).toHaveLength(model.size);
        });
      }),
    );
  },
  PROPERTY_TIMEOUT_MS,
);

test(
  "sync N equals sync 1: extra syncs on an idle machine change no byte",
  async () => {
    await checkProperty(
      "sync N equals sync 1",
      fc.asyncProperty(sequence, fc.integer({ min: 1, max: 5 }), async (steps, extra) => {
        await withSources(false, async (world) => {
          await runSequence(world, steps);
          expect((await runReal(world, ["sync"])).code).toBe(0);
          const once = snapshot(world.userHome, RUN_RECORDS);
          for (let index = 0; index < extra; index += 1) {
            expect((await runReal(world, ["sync"])).code).toBe(0);
          }
          expect(snapshot(world.userHome, RUN_RECORDS)).toEqual(once);
        });
      }),
    );
  },
  PROPERTY_TIMEOUT_MS,
);

// A registry with the user's own entries, which a hook registration must leave byte-identical
// once the hook is gone again.
const SEEDED_SETTINGS = `{
  "permissions": { "allow": ["Bash(ls)"] },
  "hooks": {
    "SessionStart": [
      { "hooks": [{ "type": "command", "command": "echo hello" }] }
    ]
  }
}
`;

test(
  "add then remove: a source with a hook leaves the home as it found it, seeded registry included",
  async () => {
    await checkProperty(
      "add then remove",
      fc.asyncProperty(addOp, async (step) => {
        await withSources(false, async (world) => {
          const settings = join(world.userHome, ".claude", "settings.json");
          mkdirSync(join(world.userHome, ".claude"), { recursive: true });
          writeFileSync(settings, SEEDED_SETTINGS);
          const before = fileSnapshot(world.userHome, RUN_RECORDS_AND_STATE);
          const argv = addArgv(world, step.fixture, step.subset, "-g", ["--add-hook"]);
          expect((await runReal(world, argv)).code).toBe(0);
          const registered = readFileSync(settings, "utf8");
          expect(registered).toContain(HOOK_COMMAND);
          expect(registered).toContain('"command": "echo hello"');
          const removed = await runReal(world, ["remove", pathOf(world, step.fixture), "-y"]);
          expect(removed.code).toBe(0);
          expect(fileSnapshot(world.userHome, RUN_RECORDS_AND_STATE)).toEqual(before);
          expect(intentOf(world.maximsHome)).toEqual(emptyState(WRITTEN_BY));
        });
      }),
    );
  },
  PROPERTY_TIMEOUT_MS,
);

const PROJECT_RUN_RECORDS = [
  "home/.agents/maxims/log",
  "home/.agents/maxims/last-sync",
  "home/.agents/maxims/state.json.lock",
  "project/.agents/maxims.lock",
];

test(
  "restore: rule files, the registry entry and body links come back byte-identical from state and store",
  async () => {
    await checkProperty(
      "restore",
      fc.asyncProperty(fc.array(addOp, { minLength: 1, maxLength: 3 }), async (steps) => {
        await withSources(true, async (world) => {
          const project = world.cwd;
          // A harness named explicitly at project scope must have its folder there already.
          mkdirSync(join(project, ".claude"));
          for (const step of steps) {
            const argv = addArgv(world, step.fixture, step.subset, "-p", ["--add-hook"]);
            expect((await runReal(world, argv)).code).toBe(0);
          }
          const before = fileSnapshot(world.dir, PROJECT_RUN_RECORDS);
          const rules = join(project, ".claude", "rules");
          const registry = join(project, ".claude", "settings.json");
          const bodies = join(project, ".agents", "memories");
          expect(readdirSync(rules).length).toBeGreaterThan(0);
          expect(readdirSync(bodies).length).toBeGreaterThan(0);
          expect(readFileSync(registry, "utf8")).toContain(HOOK_COMMAND);
          rmSync(rules, { recursive: true });
          rmSync(registry);
          rmSync(bodies, { recursive: true });
          expect(fileSnapshot(world.dir, PROJECT_RUN_RECORDS)).not.toEqual(before);
          expect((await runReal(world, ["sync"])).code).toBe(0);
          expect(fileSnapshot(world.dir, PROJECT_RUN_RECORDS)).toEqual(before);
        });
      }),
    );
  },
  PROPERTY_TIMEOUT_MS,
);

test(
  "store missing: a sync rebuilds the store from the sources and rewrites no destination",
  async () => {
    await checkProperty(
      "store missing",
      fc.asyncProperty(sequence, async (steps) => {
        await withSources(false, async (world) => {
          const model = await runSequence(world, steps);
          fc.pre(model.size > 0);
          expect((await runReal(world, ["sync"])).code).toBe(0);
          const store = homePaths(world.maximsHome).store;
          const destinations = fileSnapshot(world.userHome, RUN_RECORDS_AND_STATE);
          const copies = snapshot(store);
          expect(copies.size).toBeGreaterThan(0);
          rmSync(store, { recursive: true });
          expect((await runReal(world, ["sync"])).code).toBe(0);
          expect(snapshot(store)).toEqual(copies);
          expect(fileSnapshot(world.userHome, RUN_RECORDS_AND_STATE)).toEqual(destinations);
        });
      }),
    );
  },
  PROPERTY_TIMEOUT_MS,
);

test(
  "orphan sweep: a stray store entry is removed and nothing else changes",
  async () => {
    await checkProperty(
      "orphan sweep",
      fc.asyncProperty(sequence, async (steps) => {
        await withSources(false, async (world) => {
          await runSequence(world, steps);
          // A home that never recorded intent has nothing to plan against, so no sweep runs there.
          fc.pre(existsSync(homePaths(world.maximsHome).state));
          expect((await runReal(world, ["sync"])).code).toBe(0);
          const before = snapshot(world.userHome, RUN_RECORDS);
          const store = homePaths(world.maximsHome).store;
          const orphans = [
            join(store, "_git", "git.example.com", "team", "orphan"),
            join(store, "_local", "orphan-0badcafe"),
          ];
          for (const orphan of orphans) {
            mkdirSync(join(orphan, "memories"), { recursive: true });
            writeFileSync(join(orphan, "memories", "stray.md"), "stray\n");
          }
          expect((await runReal(world, ["sync"])).code).toBe(0);
          for (const orphan of orphans) expect(existsSync(orphan)).toBe(false);
          const after = snapshot(world.userHome, RUN_RECORDS);
          for (const key of after.keys()) {
            if (!before.has(key)) expect(after.get(key)).toBe("dir");
          }
          for (const [key, digest] of before) expect(after.get(key)).toBe(digest);
        });
      }),
    );
  },
  PROPERTY_TIMEOUT_MS,
);

test("shared basename: two local sources both named memories get two store entries", async () => {
  await withRealWorld({}, async (world) => {
    const roots = ["one", "two"].map((parent) => {
      const path = join(world.dir, parent, "memories");
      writeMemories(path, { [`${parent}-rule`]: { description: `Rule from ${parent}.` } });
      return path;
    });
    for (const root of roots) {
      const added = await runReal(world, ["add", root, "-g", ...ADD_FLAGS]);
      expect({ code: added.code, stderr: added.stderr }).toEqual({ code: 0, stderr: "" });
    }
    const local = join(homePaths(world.maximsHome).store, "_local");
    const entries = readdirSync(local).sort();
    expect(entries).toHaveLength(2);
    expect(new Set(entries).size).toBe(2);
    for (const entry of entries) expect(entry).toMatch(/^memories-[0-9a-f]{8}$/);
    const copies = entries.flatMap((entry) => readdirSync(join(local, entry, "memories")));
    expect(copies.sort()).toEqual(["one-rule.md", "two-rule.md"]);
    expect(readdirSync(join(world.userHome, ".claude", "rules"))).toHaveLength(2);
  });
});
