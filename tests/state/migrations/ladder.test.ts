// Guards the upgrade path: a slice that skips or repeats a rung, a step that forgets to stamp
// `version`, or a rung whose "before" document no longer lands on the current fixture would each
// refuse or misread every upgraded install, and none of it is visible until a user's file is older
// than the binary.
import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  CURRENT_STATE_VERSION,
  dueMigrations,
  FIRST_VERSION,
  type Ladder,
  type MigrationStep,
  migrateState,
  versionOf,
} from "../../../src/state/migrations/ladder.ts";
import { parseState } from "../../../src/state/schema.ts";
import { srcPath } from "../../shared/src_path.ts";

const FIXTURES = srcPath("state", "fixtures");

function fixture(name: string): unknown {
  return JSON.parse(readFileSync(join(FIXTURES, name), "utf8"));
}

function record(json: unknown): Record<string, unknown> {
  if (typeof json !== "object" || json === null || Array.isArray(json)) {
    throw new Error("expected an object");
  }
  return { ...json };
}

// A step that stamps the version it arrives at and leaves a mark, so a run shows which rungs it
// climbed and in what order.
function rung(to: number): MigrationStep {
  return {
    description: `climb to ${to}`,
    up: (json) => ({ ...record(json), version: to, [`via${to - 1}`]: true }),
  };
}

// Two rungs starting above zero: a slice that counts from zero instead of the first version, or
// one that is off by one at either end, picks a different step here.
const TWO_RUNGS: Ladder = { firstVersion: 3, steps: [rung(4), rung(5)] };

describe("the shipped ladder", () => {
  // Every `before-*.json` is one rung's document as the user had it; replayed through the rest of
  // the ladder it must be exactly current.json, the same user's file in the current shape. The
  // fixture's own stamp says which rung it is, so no file name carries a version.
  test("every rung's before fixture replays to current.json, which parses at the current version", () => {
    const current = fixture("current.json");
    expect(versionOf(current)).toBe(CURRENT_STATE_VERSION);
    expect(parseState(current)).toMatchObject({ ok: "parsed" });
    const priorDocuments = readdirSync(FIXTURES)
      .filter((name) => name.startsWith("before-"))
      .map((name) => {
        const json = fixture(name);
        const version = versionOf(json);
        if (version === null) throw new Error(`${name} carries no integer version`);
        return { json, version };
      });
    const rungs = Array.from(
      { length: CURRENT_STATE_VERSION - FIRST_VERSION },
      (_, index) => FIRST_VERSION + index,
    );
    expect(priorDocuments.map(({ version }) => version).sort((a, b) => a - b)).toEqual(rungs);
    for (const { json, version } of priorDocuments) {
      expect(migrateState(json, version)).toEqual({ kind: "migrated", json: current });
    }
  });
});

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

describe("migrateState", () => {
  test("runs the due steps in registry order, each seeing the previous output", () => {
    expect(migrateState({ version: 3 }, 3, TWO_RUNGS)).toEqual({
      kind: "migrated",
      json: { version: 5, via3: true, via4: true },
    });
    expect(migrateState({ version: 4 }, 4, TWO_RUNGS)).toEqual({
      kind: "migrated",
      json: { version: 5, via4: true },
    });
  });

  test("a version below the first rung is unreachable, never silently kept", () => {
    expect(migrateState({ version: 2 }, 2, TWO_RUNGS)).toEqual({ kind: "unreachable", oldest: 3 });
  });

  test("a step that does not stamp the version it arrives at throws, naming the step", () => {
    const forgetful: Ladder = {
      firstVersion: 3,
      steps: [{ description: "forgets the stamp", up: (json) => json }],
    };
    expect(() => migrateState({ version: 3 }, 3, forgetful)).toThrow(
      /"forgets the stamp" produced version 3, expected 4/,
    );
  });
});
