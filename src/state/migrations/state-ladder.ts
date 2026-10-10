// The one place that knows an older state.json shape; the mechanism is runner.ts.

import type { Ladder, MigrationStep } from "./runner.ts";

export const FIRST_VERSION = 1;

export const MIGRATIONS = [] as const satisfies readonly MigrationStep[];

export const CURRENT_STATE_VERSION = FIRST_VERSION + MIGRATIONS.length;

export const STATE_LADDER: Ladder = {
  kind: "state",
  firstVersion: FIRST_VERSION,
  steps: MIGRATIONS,
};
