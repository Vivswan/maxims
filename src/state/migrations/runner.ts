// The one migration mechanism, shared by every versioned document maxims writes (state.json,
// config.json, the project lock, the managed block). Each kind registers a ladder; a step's
// position in it is the version the step leaves, so a kind's current version is derived and never
// typed:
//
//   firstVersion + index  -> the version step `index` migrates away from
//   firstVersion + length -> the current version, what the kind's schema pins
//
// Retiring a bottom rung means dropping it from its registry and raising that FIRST_VERSION. A
// kind's schema imports its current version from its ladder, so nothing on a ladder's import
// path may import a schema. `Document` is the shape a step carries: parsed JSON for the files,
// text for the block, so a ladder of one kind cannot be climbed as another.

import { z } from "zod";

export type MigrationStep<Document = unknown> = {
  readonly description: string;
  /** Pure and idempotent on its own output: returns the next version's shape with `version` stamped. */
  readonly up: (raw: Document) => Document;
};

export type Ladder<Document = unknown> = {
  /** Names the document in a thrown message: "state", "config", "project lock". */
  readonly kind: string;
  /** The version the first step moves away from. */
  readonly firstVersion: number;
  readonly steps: readonly MigrationStep<Document>[];
};

// The version is read before any shape judgment: a boundary routes an older document by it and
// refuses a newer one by it, so neither ever parses a shape it cannot know. `Number.isInteger`
// rather than zod's own checks: `int()` refuses an integer past the safe range, which is still a
// version to stop on, and `multipleOf(1)` admits 1.0000000000000002 within its tolerance.
const Versioned = z.object({ version: z.number().refine(Number.isInteger) });

export function versionOf(json: unknown): number | null {
  const result = Versioned.safeParse(json);
  return result.success ? result.data.version : null;
}

/** The steps that carry a document from version `from` to `to`. */
export function dueMigrations<Document>(
  from: number,
  to: number,
  ladder: Ladder<Document>,
): readonly MigrationStep<Document>[] {
  const start = Math.max(from, ladder.firstVersion) - ladder.firstVersion;
  const end = Math.max(to - ladder.firstVersion, 0);
  return ladder.steps.slice(start, end);
}

export type MigrationResult =
  | { kind: "migrated"; json: unknown }
  | { kind: "unreachable"; oldest: number };

// A document below the first rung has no step to climb: the caller refuses it and says how the
// file is made again. The runner checks only the version each step arrives at, never that it ran
// once. This is the JSON climber; the block's ladder is refused at its boundary, never climbed.
export function migrate(json: unknown, version: number, ladder: Ladder): MigrationResult {
  if (version < ladder.firstVersion) return { kind: "unreachable", oldest: ladder.firstVersion };
  const current = ladder.firstVersion + ladder.steps.length;
  let document = json;
  for (const [offset, step] of dueMigrations(version, current, ladder).entries()) {
    const expected = version + offset + 1;
    document = step.up(document);
    const arrived = versionOf(document);
    if (arrived !== expected) {
      throw new Error(
        `${ladder.kind} migration "${step.description}" produced version ${String(arrived)}, expected ${expected}`,
      );
    }
  }
  return { kind: "migrated", json: document };
}
