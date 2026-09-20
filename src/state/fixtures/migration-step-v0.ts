import type { MigrationStep } from "../migrations/index.ts";

// Test-only step over an invented version 0 whose `hooks` recorded registration facts per harness;
// version 1 keeps only the ids the user asked for. Never registered: no version 0 ever shipped.
export const legacyHooksStep: MigrationStep = {
  from: 0,
  to: 1,
  migrate(json) {
    if (typeof json !== "object" || json === null || !("version" in json) || json.version !== 0) {
      return json;
    }
    const hooks =
      "hooks" in json && typeof json.hooks === "object" && json.hooks !== null
        ? Object.keys(json.hooks)
        : [];
    return { ...json, version: 1, hooks };
  },
};
