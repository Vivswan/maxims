// The project lock's ladder; the mechanism is runner.ts. The read boundary refuses every version
// below the current one rather than climbing, so a lock shape change raises FIRST_VERSION and ships
// the fixture that pins the refusal, and MIGRATIONS stays empty.

import type { Ladder, MigrationStep } from "./runner.ts";

export const FIRST_VERSION = 1;

export const MIGRATIONS = [] as const satisfies readonly MigrationStep[];

export const CURRENT_PROJECT_LOCK_VERSION = FIRST_VERSION + MIGRATIONS.length;

export const PROJECT_LOCK_LADDER: Ladder = {
  kind: "project lock",
  firstVersion: FIRST_VERSION,
  steps: MIGRATIONS,
};
