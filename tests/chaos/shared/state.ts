// Reads and edits of a maxims home a row makes between two runs: the fetch clock moved back so a
// refresh falls due, the debounce stamp cleared so a quiet run does work, the cooldown shortened.
import { existsSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { LastError } from "../../../src/contracts/last-error.ts";
import type { Fetched, State } from "../../../src/state/schema.ts";
import { serializeState } from "../../../src/state/store.ts";
import { homePaths } from "../../../src/util/home.ts";
import { readStateFile } from "../../shared/state_file.ts";
import { daysAgo } from "../../shared/time.ts";

export function fetchedOf(state: State, key: string): Fetched {
  const entry = state.sources[key];
  if (entry === undefined || !("fetched" in entry) || entry.fetched === undefined) {
    throw new Error(`${key} has no fetch record`);
  }
  return entry.fetched;
}

// Moves the last success back `days` days, and a recorded failure with it: a refresh falls due
// on the success clock, and is retried only once its failure is an hour old.
export function ageFetch(maximsHome: string, key: string, days: number, now = new Date()): void {
  const state = readStateFile(maximsHome);
  const fetched = fetchedOf(state, key);
  fetched.at = daysAgo(now, days);
  if (fetched.lastError !== null) fetched.lastError.at = fetched.at;
  writeFileSync(homePaths(maximsHome).state, serializeState(state));
}

export function lastErrorOf(maximsHome: string, key: string): LastError | null {
  return fetchedOf(readStateFile(maximsHome), key).lastError;
}

// The stamp every `sync --quiet` debounces on for a minute; a row that runs two quiet syncs in a
// row clears it in between.
export function clearDebounce(maximsHome: string): void {
  rmSync(homePaths(maximsHome).lastSync, { force: true });
}

export function setCooldownDays(maximsHome: string, days: number): void {
  writeFileSync(homePaths(maximsHome).config, `${JSON.stringify({ cooldownDays: days })}\n`);
}

export function refreshLog(maximsHome: string): string {
  const path = homePaths(maximsHome).log;
  return existsSync(path) ? readFileSync(path, "utf8") : "";
}

// The rule files the real Claude Code definition writes at user scope, sorted by name.
export function ruleFiles(userHome: string): string[] {
  const dir = join(userHome, ".claude", "rules");
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .sort()
    .map((name) => join(dir, name));
}

export function onlyRuleFile(userHome: string): string {
  const [only, ...rest] = ruleFiles(userHome);
  if (only === undefined || rest.length > 0) {
    throw new Error(`expected exactly one rule file, found ${JSON.stringify(ruleFiles(userHome))}`);
  }
  return only;
}

export function quarantinedStates(maximsHome: string): string[] {
  return readdirSync(maximsHome).filter((name) => name.startsWith("state.json.corrupt-"));
}
