// The one place that knows an older project lock shape; the mechanism is runner.ts. The lock is
// small and written whole from state by `share`, so its read boundary refuses a version below the
// current one and points at a fresh `share` rather than climbing; the registry still derives the
// version the schema pins and records each shape change as a step.

import type { Ladder, MigrationStep } from "./runner.ts";

export const FIRST_VERSION = 1;

export const MIGRATIONS = [] as const satisfies readonly MigrationStep[];

export const CURRENT_PROJECT_LOCK_VERSION = FIRST_VERSION + MIGRATIONS.length;

export const PROJECT_LOCK_LADDER: Ladder = {
  kind: "project lock",
  firstVersion: FIRST_VERSION,
  steps: MIGRATIONS,
};
