// Guards the shared mechanism: a slice that skips or repeats a rung, or a step that forgets to
// stamp `version`, would refuse or misread every upgraded file of every kind, and none of it is
// visible until a user's file is older than the binary.
import { describe, expect, test } from "bun:test";
import { util } from "zod";
import {
  dueMigrations,
  type Ladder,
  type MigrationStep,
  migrate,
} from "../../../src/state/migrations/runner.ts";

function record(json: unknown): Record<string, unknown> {
  if (!util.isObject(json)) throw new Error("expected an object");
  return { ...json };
}

function rung(to: number): MigrationStep {
  return {
    description: `climb to ${to}`,
    up: (json) => ({ ...record(json), version: to, [`via${to - 1}`]: true }),
  };
}

// Two rungs starting above zero: a slice that counts from zero instead of the first version, or
// one that is off by one at either end, picks a different step here.
const TWO_RUNGS: Ladder = { kind: "test", firstVersion: 3, steps: [rung(4), rung(5)] };

describe("dueMigrations", () => {
  const slices: [from: number, to: number, expected: readonly MigrationStep[]][] = [
    [3, 5, TWO_RUNGS.steps],
    [4, 5, [TWO_RUNGS.steps[1] as MigrationStep]],
    [5, 5, []],
    [0, 4, [TWO_RUNGS.steps[0] as MigrationStep]],
    // Unclamped, `to - firstVersion` below zero would slice from the end and pick the first step.
    [0, 2, []],
  ];
  test.each(slices)(
    "versions [%i, %i) select the steps at those positions",
    (from, to, expected) => {
      expect(dueMigrations(from, to, TWO_RUNGS)).toEqual(expected);
    },
  );
});

describe("migrate", () => {
  test("runs the due steps in registry order, each seeing the previous output", () => {
    expect(migrate({ version: 3 }, 3, TWO_RUNGS)).toEqual({
      kind: "migrated",
      json: { version: 5, via3: true, via4: true },
    });
    expect(migrate({ version: 4 }, 4, TWO_RUNGS)).toEqual({
      kind: "migrated",
      json: { version: 5, via4: true },
    });
  });

  test("a version below the first rung is unreachable, never silently kept", () => {
    expect(migrate({ version: 2 }, 2, TWO_RUNGS)).toEqual({ kind: "unreachable", oldest: 3 });
  });

  test("a step that does not stamp the version it arrives at throws, naming the kind and the step", () => {
    const forgetful: Ladder = {
      kind: "test",
      firstVersion: 3,
      steps: [{ description: "forgets the stamp", up: (json) => json }],
    };
    expect(() => migrate({ version: 3 }, 3, forgetful)).toThrow(
      /^test migration "forgets the stamp" produced version 3, expected 4$/,
    );
  });
});
