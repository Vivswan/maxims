// Reads and edits of a maxims home a row makes between two runs: the fetch clock moved back so a
// refresh falls due, the debounce stamp cleared so a quiet run does work, the cooldown shortened.
import { existsSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { type Fetched, type LastError, parseState, type State } from "../../../src/state/schema.ts";
import { serializeState } from "../../../src/state/store.ts";
import { homePaths } from "../../../src/util/home.ts";

const DAY_MS = 24 * 60 * 60 * 1000;

export function readStateFile(maximsHome: string): State {
  const parsed = parseState(JSON.parse(readFileSync(homePaths(maximsHome).state, "utf8")));
  if (parsed.ok !== "parsed")
    throw new Error(`state.json did not parse: ${JSON.stringify(parsed)}`);
  return parsed.state;
}

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
  fetched.at = new Date(now.getTime() - days * DAY_MS).toISOString();
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

// The rule lines of a rendered file, without the markers and management comments around them.
export function ruleLines(text: string): string[] {
  return text.split("\n").filter((line) => line.startsWith("- "));
}

export function quarantinedStates(maximsHome: string): string[] {
  return readdirSync(maximsHome).filter((name) => name.startsWith("state.json.corrupt-"));
}
