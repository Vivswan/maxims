// The one place that knows an older state.json shape. A step's position in MIGRATIONS is the
// version it leaves, so the current version is derived and never typed:
//
//   FIRST_VERSION + index  -> the version step `index` migrates away from
//   FIRST_VERSION + length -> the current version, what StateSchema pins
//
// Retiring the bottom rung means dropping it here and raising FIRST_VERSION. schema.ts imports
// the current version from here, so nothing on this module's import path may import schema.ts.

export type MigrationStep = {
  readonly description: string;
  /** Pure and idempotent on its own output: returns the next version's shape with `version` stamped. */
  up(raw: unknown): unknown;
};

export type Ladder = {
  /** The version the first step moves away from. */
  readonly firstVersion: number;
  readonly steps: readonly MigrationStep[];
};

export const FIRST_VERSION = 1;

export const MIGRATIONS = [] as const satisfies readonly MigrationStep[];

export const CURRENT_STATE_VERSION = FIRST_VERSION + MIGRATIONS.length;

const LADDER: Ladder = { firstVersion: FIRST_VERSION, steps: MIGRATIONS };

// The version is read before any shape judgment: the runner routes an older document by it and
// `parseState` refuses a newer one by it, so neither ever parses a shape it cannot know.
export function versionOf(json: unknown): number | null {
  if (typeof json !== "object" || json === null || !("version" in json)) return null;
  return typeof json.version === "number" && Number.isInteger(json.version) ? json.version : null;
}

/** The steps that carry a document from version `from` to `to`. */
export function dueMigrations(
  from: number,
  to: number,
  ladder: Ladder = LADDER,
): readonly MigrationStep[] {
  const start = Math.max(from, ladder.firstVersion) - ladder.firstVersion;
  const end = Math.max(to - ladder.firstVersion, 0);
  return ladder.steps.slice(start, end);
}

export type MigrationResult =
  | { kind: "migrated"; json: unknown }
  | { kind: "unreachable"; oldest: number };

// A document below the first rung has no step to climb: the caller refuses it and points at a
// re-add. The runner checks only the version each step arrives at, never that it ran once.
export function migrateState(
  json: unknown,
  version: number,
  ladder: Ladder = LADDER,
): MigrationResult {
  if (version < ladder.firstVersion) return { kind: "unreachable", oldest: ladder.firstVersion };
  const current = ladder.firstVersion + ladder.steps.length;
  let document = json;
  for (const [offset, step] of dueMigrations(version, current, ladder).entries()) {
    const expected = version + offset + 1;
    document = step.up(document);
    const arrived = versionOf(document);
    if (arrived !== expected) {
      throw new Error(
        `migration "${step.description}" produced version ${String(arrived)}, expected ${expected}`,
      );
    }
  }
  return { kind: "migrated", json: document };
}
