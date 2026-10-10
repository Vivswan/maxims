// The managed block's ladder; the mechanism is src/state/migrations/runner.ts. The begin marker
// carries the version as its last field, read before the rest of the line is judged. The scanner
// refuses every version but the current one rather than climbing: a block is rendered whole from
// state on every sync, so a shape change raises FIRST_VERSION and ships the fixture that pins the
// refusal, and MIGRATIONS stays empty.

import type { Ladder, MigrationStep } from "../../state/migrations/runner.ts";

export const FIRST_VERSION = 1;

export const MIGRATIONS = [] as const satisfies readonly MigrationStep[];

export const CURRENT_BLOCK_VERSION = FIRST_VERSION + MIGRATIONS.length;

export const BLOCK_LADDER: Ladder = {
  kind: "managed block",
  firstVersion: FIRST_VERSION,
  steps: MIGRATIONS,
};
