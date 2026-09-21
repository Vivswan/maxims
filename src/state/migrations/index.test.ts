// Guards the upgrade path: a step applied out of order, a hole in the chain that silently skips a
// version, or a step that forgets to bump `version` would each corrupt every upgraded install.
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { legacyHooksStep } from "../fixtures/migration-step-v0.ts";
import { type MigrationStep, migrateState } from "./index.ts";

const FIXTURES = join(import.meta.dir, "..", "fixtures");

function fixture(name: string): unknown {
  return JSON.parse(readFileSync(join(FIXTURES, name), "utf8"));
}

function record(json: unknown): Record<string, unknown> {
  if (typeof json !== "object" || json === null || Array.isArray(json)) {
    throw new Error("expected an object");
  }
  return { ...json };
}

// A step that only moves the version, for exercising the runner's chaining and ordering.
function bump(from: number, to: number): MigrationStep {
  return { from, to, migrate: (json) => ({ ...record(json), version: to, [`via${from}`]: true }) };
}

describe("migrateState", () => {
  test("a v0 fixture reaches v1 through the step, and the step is idempotent on its own output", () => {
    const legacy = fixture("v0-legacy.json");
    const result = migrateState(legacy, 0, [legacyHooksStep], 1);
    expect(result.kind).toBe("migrated");
    if (result.kind !== "migrated") return;
    expect(result.applied).toEqual([0]);
    const migrated = record(result.json);
    expect(migrated.version).toBe(1);
    expect(migrated.hooks).toEqual({ global: ["claude-code", "codex"] });
    expect(migrated.sources).toEqual(record(legacy).sources);
    expect(legacyHooksStep.migrate(result.json)).toEqual(result.json);
  });

  test("steps registered out of order still run ascending, each seeing the previous output", () => {
    const result = migrateState({ version: 0 }, 0, [bump(2, 3), bump(1, 2), bump(0, 1)], 3);
    expect(result).toEqual({
      kind: "migrated",
      json: { version: 3, via0: true, via1: true, via2: true },
      applied: [0, 1, 2],
    });
  });

  test("only steps whose `to` is above the file's version are due", () => {
    const result = migrateState({ version: 2 }, 2, [bump(0, 1), bump(1, 2), bump(2, 3)], 3);
    expect(result).toEqual({ kind: "migrated", json: { version: 3, via2: true }, applied: [2] });
  });

  test("a step spanning several versions is due for a version strictly inside its range", () => {
    const result = migrateState({ version: 1 }, 1, [bump(0, 3)], 3);
    expect(result).toEqual({ kind: "migrated", json: { version: 3, via0: true }, applied: [0] });
  });

  test("a version older than the oldest registered step is unreachable, never silently kept", () => {
    expect(migrateState({ version: 0 }, 0, [bump(1, 2)], 2)).toEqual({
      kind: "unreachable",
      oldest: 1,
    });
    expect(migrateState({ version: 0 }, 0, [], 1)).toEqual({ kind: "unreachable", oldest: 1 });
  });

  const broken: { title: string; registry: MigrationStep[]; target: number; error: RegExp }[] = [
    {
      title: "a hole between two steps",
      registry: [bump(0, 1), bump(2, 3)],
      target: 3,
      error: /arrives at 1 but the next leaves 2/,
    },
    {
      title: "two steps leaving the same version",
      registry: [bump(0, 1), bump(0, 2)],
      target: 2,
      error: /arrives at 1 but the next leaves 0/,
    },
    {
      title: "a chain that stops short of the current version",
      registry: [bump(0, 1)],
      target: 2,
      error: /ends at 1, not the current version 2/,
    },
    {
      title: "a chain that overshoots the current version",
      registry: [bump(0, 2)],
      target: 1,
      error: /ends at 2, not the current version 1/,
    },
    {
      title: "a step that does not move forward",
      registry: [bump(1, 1)],
      target: 1,
      error: /from 1 must move forward/,
    },
    {
      title: "a step that forgets to bump the version",
      registry: [{ from: 0, to: 1, migrate: (json) => json }],
      target: 1,
      error: /from 0 produced version 0, expected 1/,
    },
  ];
  test.each(broken)("throws on $title", ({ registry, target, error }) => {
    expect(() => migrateState({ version: 0 }, 0, registry, target)).toThrow(error);
  });
});
