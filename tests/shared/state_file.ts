import { readFileSync } from "node:fs";
import { parseState, type State } from "../../src/state/schema.ts";
import { homePaths } from "../../src/util/home.ts";

/** Returns the state a maxims home holds, read through the state schema; throws with the parse outcome when the schema refuses the file. */
export function readStateFile(maximsHome: string): State {
  const parsed = parseState(JSON.parse(readFileSync(homePaths(maximsHome).state, "utf8")));
  if (parsed.ok !== "parsed") {
    throw new Error(`state.json did not parse: ${JSON.stringify(parsed)}`);
  }

  return parsed.state;
}
