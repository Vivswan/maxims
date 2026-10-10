// Fails if a page states a timing window the code no longer uses: the lock wait, the lock
// staleness, and the quiet-mode debounce are each one constant in src, and the pages repeat them
// as "N seconds" in prose nothing renders from the constant. Every "N seconds" a page says must
// sit inside exactly one phrase here, and carry that phrase's constant.
import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { QUIET_DEBOUNCE_MS } from "../src/commands/shared/debounce.ts";
import { DEFAULT_LOCK_STALE_MS, DEFAULT_LOCK_WAIT_MS } from "../src/util/lock.ts";

const ROOT = resolve(import.meta.dir, "..");

// Each phrase captures its number; `ms: null` marks a window no constant in src owns (a harness's
// own timeout, a measured startup). A mention that fits none fails by location, so a new wording
// is classified here before it ships with a number.
type Phrase = { constant: string; ms: number | null; pattern: RegExp };

const PHRASES: Phrase[] = [
  {
    constant: "DEFAULT_LOCK_WAIT_MS",
    ms: DEFAULT_LOCK_WAIT_MS,
    pattern: /(?:polls|waits) up to (\d+) seconds/dg,
  },
  {
    constant: "DEFAULT_LOCK_STALE_MS",
    ms: DEFAULT_LOCK_STALE_MS,
    pattern: /older than (\d+) seconds is stolen/dg,
  },
  {
    constant: "DEFAULT_LOCK_STALE_MS",
    ms: DEFAULT_LOCK_STALE_MS,
    pattern: /stolen after (\d+) seconds/dg,
  },
  {
    constant: "DEFAULT_LOCK_STALE_MS",
    ms: DEFAULT_LOCK_STALE_MS,
    pattern: /breaks the lock at (\d+) seconds/dg,
  },
  {
    constant: "QUIET_DEBOUNCE_MS",
    ms: QUIET_DEBOUNCE_MS,
    pattern: /within (\d+) seconds of the last/dg,
  },
  { constant: "QUIET_DEBOUNCE_MS", ms: QUIET_DEBOUNCE_MS, pattern: /debounced by (\d+) seconds/dg },
  {
    constant: "cline hook timeout",
    ms: null,
    pattern: /Cline stops a hook that has not finished after (\d+) seconds/dg,
  },
  { constant: "measured startup", ms: null, pattern: /takes about (\d+) seconds/dg },
];

const SECONDS = /\b(\d+)[ -]seconds?\b/g;

function pages(): string[] {
  const docs = [...new Bun.Glob("docs/*.md").scanSync({ cwd: ROOT })].sort();
  return ["README.md", ...docs];
}

type Reading = { where: string; constant: string; said: number; actual: number };

// The phrases whose captured number starts exactly where this mention's number does, so two
// mentions on one line are each judged by their own phrase.
function phrasesAt(line: string, at: number): Phrase[] {
  return PHRASES.filter((phrase) =>
    [...line.matchAll(phrase.pattern)].some((match) => match.indices?.[1]?.[0] === at),
  );
}

function readings(page: string, text: string): Reading[] {
  const found: Reading[] = [];
  text.split("\n").forEach((line, index) => {
    const where = `${page}:${index + 1}`;
    for (const mention of line.matchAll(SECONDS)) {
      const fits = phrasesAt(line, mention.index);
      const [phrase] = fits;
      if (fits.length !== 1 || phrase === undefined) {
        throw new Error(
          `${where}: "${mention[0]}" fits ${fits.length} phrases; classify the sentence`,
        );
      }
      if (phrase.ms === null) continue;
      found.push({
        where,
        constant: phrase.constant,
        said: Number(mention[1]),
        actual: phrase.ms / 1000,
      });
    }
  });
  return found;
}

test("every timing window a page states in seconds is the constant the code uses", () => {
  const all = pages().flatMap((page) => readings(page, readFileSync(resolve(ROOT, page), "utf8")));
  expect(all.length).toBeGreaterThan(0);
  const drifted = all.filter((reading) => reading.said !== reading.actual);
  expect(drifted).toEqual([]);
});

const wait = DEFAULT_LOCK_WAIT_MS / 1000;
const stale = DEFAULT_LOCK_STALE_MS / 1000;

test.each([
  [
    "two windows on one line are each read by their own phrase",
    `it waits up to ${wait} seconds; a lock is stolen after ${stale + 1} seconds`,
    [
      { where: "docs/x.md:1", constant: "DEFAULT_LOCK_WAIT_MS", said: wait, actual: wait },
      { where: "docs/x.md:1", constant: "DEFAULT_LOCK_STALE_MS", said: stale + 1, actual: stale },
    ],
  ],
  ["a window no constant owns is classified and skipped", "it takes about 70 seconds", []],
])("%s", (_name, line, expected) => {
  expect(readings("docs/x.md", line)).toEqual(expected);
});

test("an unclassified timing sentence fails by location", () => {
  expect(() => readings("docs/x.md", "ok\na retry every 7 seconds\n")).toThrow(
    'docs/x.md:2: "7 seconds" fits 0 phrases',
  );
});
