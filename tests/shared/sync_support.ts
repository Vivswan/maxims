import type { SyncOptions } from "../../src/commands/types.ts";
import type { HarnessId } from "../../src/contracts/harness-id.ts";
import type { HarnessDefinition } from "../../src/harnesses/contract.ts";
import { readStateFile, sharedBlockHarness } from "../engine/harness.ts";

export const SYNC: SyncOptions = {
  quiet: false,
  dryRun: false,
  json: false,
  fetch: "due",
};
export const QUIET: SyncOptions = { ...SYNC, quiet: true };
export const NOW = new Date("2026-09-20T12:00:00.000Z");
export const DAY_MS = 24 * 60 * 60 * 1000;

export function budgetedReader(byteBudget: number): HarnessDefinition {
  return { ...sharedBlockHarness, id: "dsh", displayName: "Fixture Budgeted", byteBudget };
}

export function heldHint(key: string, harness: HarnessId = "dsh"): string {
  const reader = harness === "dsh" ? "Fixture Budgeted" : "Fixture Rules";
  return `narrow the install with --memory or split the source, or keep ${key} off ${reader} with maxims unlink ${key} -a ${harness}`;
}

export function fetchedOf(home: string, key: string) {
  const entry = readStateFile(home).sources[key];
  return entry !== undefined && "fetched" in entry ? entry.fetched : undefined;
}
