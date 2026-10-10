// Guards each kind's upgrade path: a rung whose "before" document no longer lands on the current
// fixture, or a current fixture whose stamp drifted from the registry's derived version, would
// refuse or misread every upgraded file of that kind, and nothing is visible until a user's file
// is older than the binary.
import { expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parseUserConfig } from "../../../src/state/config.ts";
import { CONFIG_LADDER } from "../../../src/state/migrations/config-ladder.ts";
import { PROJECT_LOCK_LADDER } from "../../../src/state/migrations/project-lock-ladder.ts";
import { type Ladder, migrate, versionOf } from "../../../src/state/migrations/runner.ts";
import { STATE_LADDER } from "../../../src/state/migrations/state-ladder.ts";
import { parseProjectLock } from "../../../src/state/project-lock.ts";
import { parseState } from "../../../src/state/schema.ts";
import { srcPath } from "../../shared/src_path.ts";

type Kind = {
  file: string;
  ladder: Ladder;
  fixtures: string;
  parses(json: unknown): boolean;
};

const KINDS: Kind[] = [
  {
    file: "state.json",
    ladder: STATE_LADDER,
    fixtures: srcPath("state", "fixtures"),
    parses: (json) => parseState(json).ok === "parsed",
  },
  {
    file: "config.json",
    ladder: CONFIG_LADDER,
    fixtures: srcPath("state", "fixtures", "config"),
    parses: (json) => parseUserConfig(json).ok === "parsed",
  },
  {
    file: "maxims.lock",
    ladder: PROJECT_LOCK_LADDER,
    fixtures: srcPath("state", "fixtures", "project-lock"),
    parses: (json) => parseProjectLock(JSON.stringify(json)).ok === "parsed",
  },
];

function fixture(dir: string, name: string): unknown {
  return JSON.parse(readFileSync(join(dir, name), "utf8"));
}

// Every `before-*.json` is one rung's document as the user had it; replayed through the rest of
// the ladder it must be exactly current.json, the same user's file in the current shape. The
// fixture's own stamp says which rung it is, so no file name carries a version.
test.each(KINDS)(
  "$file: every rung's before fixture replays to current.json, which parses at the current version",
  ({ ladder, fixtures, parses }) => {
    const currentVersion = ladder.firstVersion + ladder.steps.length;
    const current = fixture(fixtures, "current.json");
    expect(versionOf(current)).toBe(currentVersion);
    expect(parses(current)).toBe(true);
    const priorDocuments = readdirSync(fixtures)
      .filter((name) => name.startsWith("before-"))
      .map((name) => {
        const json = fixture(fixtures, name);
        const version = versionOf(json);
        if (version === null) throw new Error(`${name} carries no integer version`);
        return { json, version };
      });
    const rungs = ladder.steps.map((_, index) => ladder.firstVersion + index);
    expect(priorDocuments.map(({ version }) => version).sort((a, b) => a - b)).toEqual(rungs);
    for (const { json, version } of priorDocuments) {
      expect(migrate(json, version, ladder)).toEqual({ kind: "migrated", json: current });
    }
  },
);
