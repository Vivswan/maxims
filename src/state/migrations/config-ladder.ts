// The one place that knows an older config.json shape; the mechanism is runner.ts.

import { util } from "zod";
import type { Ladder, MigrationStep } from "./runner.ts";

export const FIRST_VERSION = 1;

export const MIGRATIONS = [] as const satisfies readonly MigrationStep[];

export const CURRENT_CONFIG_VERSION = FIRST_VERSION + MIGRATIONS.length;

export const CONFIG_LADDER: Ladder = {
  kind: "config",
  firstVersion: FIRST_VERSION,
  steps: MIGRATIONS,
};

// config.json was written without a version before the envelope existed, and that shape is
// version 1 by definition, whatever FIRST_VERSION later becomes: once rung 1 retires such a file
// is unreachable and refused, never stamped current.
const VERSION_BEFORE_ENVELOPE = 1;

export function envelope(json: unknown): unknown {
  if (!util.isObject(json) || "version" in json) return json;
  return { version: VERSION_BEFORE_ENVELOPE, ...json };
}
