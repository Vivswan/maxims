import { CURRENT_STATE_VERSION } from "../schema.ts";

// A step is authored against the version it leaves, so the file that carries it is named for
// `from` (v3.ts migrates 3 away) and needs no guess at the next release number. `migrate` must be a
// no-op on input it already produced: the runner checks only the version a step arrives at, never
// that it ran once.
export type MigrationStep = {
  readonly from: number;
  readonly to: number;
  migrate(json: unknown): unknown;
};

// Every shipped step is registered here, one line each; a step is deleted once no installation
// can still hold its `from` version. Version 1 is the only one that has shipped.
export const MIGRATIONS: readonly MigrationStep[] = [];

export type MigrationResult =
  | { kind: "migrated"; json: unknown; applied: number[] }
  | { kind: "unreachable"; oldest: number };

// The chain is checked whole before any step runs, so a registry with a hole fails on every
// migrating read, not only for the user whose version sits in the hole.
export function migrateState(
  json: unknown,
  version: number,
  registry: readonly MigrationStep[] = MIGRATIONS,
  target: number = CURRENT_STATE_VERSION,
): MigrationResult {
  const chain = contiguousChain(registry, target);
  const oldest = chain[0]?.from ?? target;
  if (version < oldest) return { kind: "unreachable", oldest };
  const applied: number[] = [];
  let current = json;
  for (const step of chain) {
    if (step.to <= version) continue;
    current = step.migrate(current);
    if (versionOf(current) !== step.to) {
      throw new Error(
        `migration from ${step.from} produced version ${String(versionOf(current))}, expected ${step.to}`,
      );
    }
    applied.push(step.from);
  }
  return { kind: "migrated", json: current, applied };
}

function contiguousChain(registry: readonly MigrationStep[], target: number): MigrationStep[] {
  const chain = [...registry].sort((a, b) => a.from - b.from);
  let expected: number | null = null;
  for (const step of chain) {
    if (step.to <= step.from) {
      throw new Error(`migration from ${step.from} must move forward, not to ${step.to}`);
    }
    if (expected !== null && step.from !== expected) {
      throw new Error(
        `migration chain broken: one step arrives at ${expected} but the next leaves ${step.from}`,
      );
    }
    expected = step.to;
  }
  if (expected !== null && expected !== target) {
    throw new Error(`migration chain ends at ${expected}, not the current version ${target}`);
  }
  return chain;
}

export function versionOf(json: unknown): number | null {
  if (typeof json !== "object" || json === null || !("version" in json)) return null;
  return typeof json.version === "number" && Number.isInteger(json.version) ? json.version : null;
}
