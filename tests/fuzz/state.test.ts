// What would drift silently: a state file or project lock whose bytes make the boundary THROW
// instead of answering parsed, corrupt or newer; a document the parser accepts but cannot accept
// again once written back (a state the next run quarantines); a timestamp folded to a different
// instant; or a newer-version file read as corrupt and rewritten by an older binary.
import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import fc from "fast-check";
import { parseProjectLock, serializeProjectLock } from "../../src/state/project-lock.ts";
import { CURRENT_STATE_VERSION, parseState, type State } from "../../src/state/schema.ts";
import { PROPERTY_TIMEOUT_MS } from "../convergence/property.ts";
import { anyText, describeError, fragments, fuzz, mutatedJson, outcome } from "./shared.ts";

const FIXTURES = join(import.meta.dir, "..", "..", "src", "state", "fixtures");

function fixture(name: string): unknown {
  return JSON.parse(readFileSync(join(FIXTURES, name), "utf8"));
}

const VALID_STATE = fixture("v1-valid.json");
const ODD_PRECISION_STATE = fixture("v1-valid-odd-precision.json");

function validState(): State {
  const parsed = parseState(VALID_STATE);
  if (parsed.ok !== "parsed") throw new Error("the valid fixture parses");
  return structuredClone(parsed.state);
}

// Every spelling a hand edit or another writer's clock library produces for one instant, plus the
// shapes zod's ISO check refuses (a bare date, no zone, a zone offset, prose).
const timestamp = fc.oneof(
  fc.date({ noInvalidDate: true }).map((date) => date.toISOString()),
  fc.date({ noInvalidDate: true }).map((date) => date.toISOString().replace(".000Z", "Z")),
  fc.date({ noInvalidDate: true }).map((date) => `${date.toISOString().slice(0, -1)}000Z`),
  fc.constantFrom(
    "2026-01-01",
    "2026-01-01T00:00:00",
    "2026-01-01T00:00:00+02:00",
    "2026-01-01T00:00:00.1Z",
    "2026-13-01T00:00:00Z",
    "2026-02-30T00:00:00Z",
    "0000-00-00T00:00:00.000Z",
    "+010000-01-01T00:00:00.000Z",
    "",
  ),
  anyText({ maxLength: 40 }),
);

const timestampedState = fc
  .tuple(fc.constantFrom("@example-user/rules#main", "@example-user/team-rules"), timestamp)
  .map(([key, at]) => {
    const doc = validState();
    const entry = doc.sources[key];
    if (entry === undefined) throw new Error(`fixture lacks ${key}`);
    entry.addedAt = at;
    return { doc, at, key };
  });

const stateDocument = fc.oneof(
  fc.jsonValue({ maxDepth: 4 }),
  fc.anything(),
  mutatedJson(VALID_STATE),
  mutatedJson(ODD_PRECISION_STATE),
  timestampedState.map(({ doc }) => doc),
);

function versionOf(json: unknown): unknown {
  return typeof json === "object" && json !== null && "version" in json ? json.version : undefined;
}

test(
  "parseState answers parsed, corrupt or newer for any document, and accepts what it parsed",
  async () => {
    await fuzz("parseState", stateDocument, (json) => {
      const result = outcome(() => parseState(json));
      if (result.kind === "threw") throw new Error(`threw ${describeError(result.error)}`);
      const parsed = result.value;
      const version = versionOf(json);
      const isNewer =
        typeof version === "number" && Number.isInteger(version) && version > CURRENT_STATE_VERSION;
      expect(parsed.ok === "newer").toBe(isNewer);
      switch (parsed.ok) {
        case "newer":
          expect<unknown>(parsed.version).toBe(version);
          return;
        case "corrupt":
          expect(parsed.issues.length).toBeGreaterThan(0);
          for (const issue of parsed.issues) expect(issue).not.toBe("");
          return;
        case "parsed": {
          const again = parseState(JSON.parse(JSON.stringify(parsed.state)));
          expect(again).toEqual(parsed);
          for (const entry of Object.values(parsed.state.sources)) {
            expect(entry.addedAt).toBe(new Date(entry.addedAt).toISOString());
          }
        }
      }
    });
  },
  PROPERTY_TIMEOUT_MS,
);

test(
  "an accepted timestamp folds to the same instant in the canonical spelling",
  async () => {
    await fuzz("IsoTimestamp", timestampedState, ({ doc, at, key }) => {
      const result = parseState(doc);
      expect(result.ok).not.toBe("newer");
      if (result.ok !== "parsed") return;
      const folded = result.state.sources[key]?.addedAt;
      expect(folded).toBe(new Date(at).toISOString());
      expect(Date.parse(folded ?? "")).toBe(Date.parse(at));
    });
  },
  PROPERTY_TIMEOUT_MS,
);

const VALID_LOCK = {
  version: 1,
  sources: {
    "./memories": {
      from: { type: "local", path: "./memories", live: true },
      select: ["short-rule"],
      rule: true,
      harnesses: ["claude-code"],
      memoryPath: "rules",
    },
    "@example-user/rules": {
      from: { type: "github", repo: "example-user/rules" },
      select: "*",
      rename: { zeta: "zeta-local" },
      rule: true,
      harnesses: ["claude-code", "codex"],
    },
    "https://gitlab.example.com/team/rules.git#v2": {
      from: { type: "git", url: "https://gitlab.example.com/team/rules.git" },
      pin: "v2",
      select: "*",
      rule: false,
      harnesses: ["codex"],
    },
  },
  disabled: ["alpha", "beta"],
};

const JSON_PIECES = [
  "{",
  "}",
  "[",
  "]",
  ",",
  ":",
  '"',
  '"version"',
  "1",
  "2",
  '"sources"',
  " ",
  "\n",
];

const lockText = fc.oneof(
  anyText({ maxLength: 300 }),
  fragments(JSON_PIECES, { maxLength: 40 }),
  fc.json({ maxDepth: 3 }),
  mutatedJson(VALID_LOCK).map((doc) => JSON.stringify(doc)),
  fc.constant(JSON.stringify(VALID_LOCK)),
);

// A lock that parses serializes to bytes that parse back to the same lock: the committed file is
// what two machines diff, so the canonical form must be a fixed point.
test(
  "parseProjectLock answers parsed or corrupt for any text, and its serialization is a fixed point",
  async () => {
    await fuzz("parseProjectLock", lockText, (text) => {
      const result = outcome(() => parseProjectLock(text));
      if (result.kind === "threw") throw new Error(`threw ${describeError(result.error)}`);
      const parsed = result.value;
      if (parsed.ok === "corrupt") {
        expect(parsed.issues.length).toBeGreaterThan(0);
        return;
      }
      const serialized = serializeProjectLock(parsed.lock);
      expect(serialized.endsWith("\n")).toBe(true);
      const again = parseProjectLock(serialized);
      expect(again).toEqual(parsed);
      if (again.ok === "parsed") expect(serializeProjectLock(again.lock)).toBe(serialized);
    });
  },
  PROPERTY_TIMEOUT_MS,
);
