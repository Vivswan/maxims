// Fails if a page states a timing window the code no longer uses: the lock wait, the lock
// staleness, the quiet-mode debounce, and the hook timeout are each one constant in src, and the
// pages repeat them as "N seconds" or "N s" in prose nothing renders from the constant. Every such
// mention a page makes must sit inside exactly one phrase here, and carry that phrase's constant.
import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { QUIET_DEBOUNCE_MS } from "../../src/commands/frame/debounce.ts";
import { HOOK_TIMEOUT_SECONDS } from "../../src/harnesses/contract.ts";
import { DEFAULT_LOCK_STALE_MS, DEFAULT_LOCK_WAIT_MS } from "../../src/util/lock.ts";

const ROOT = resolve(import.meta.dir, "..", "..");

const N = String.raw`(\d+(?:\.\d+)?) s(?:econds?)?`;

// Each phrase captures its number; `ms: null` marks a window this test does not check, and the
// entry says why. A mention that fits none fails by location, so a new wording is classified here
// before it ships with a number.
type Phrase = { constant: string; ms: number | null; pattern: RegExp };

function phrase(constant: string, ms: number | null, wording: string): Phrase {
  return { constant, ms, pattern: new RegExp(wording, "dg") };
}

const PHRASES: Phrase[] = [
  phrase("DEFAULT_LOCK_WAIT_MS", DEFAULT_LOCK_WAIT_MS, String.raw`(?:polls|waits?) up to ${N}`),
  phrase("DEFAULT_LOCK_STALE_MS", DEFAULT_LOCK_STALE_MS, String.raw`older than ${N} is stolen`),
  phrase("DEFAULT_LOCK_STALE_MS", DEFAULT_LOCK_STALE_MS, String.raw`stolen after ${N}`),
  phrase("DEFAULT_LOCK_STALE_MS", DEFAULT_LOCK_STALE_MS, String.raw`stolen past ${N} of age`),
  phrase("DEFAULT_LOCK_STALE_MS", DEFAULT_LOCK_STALE_MS, String.raw`breaks the lock at ${N}`),
  phrase("QUIET_DEBOUNCE_MS", QUIET_DEBOUNCE_MS, String.raw`within ${N} of the last`),
  phrase("QUIET_DEBOUNCE_MS", QUIET_DEBOUNCE_MS, String.raw`debounced by ${N}`),
  phrase("QUIET_DEBOUNCE_MS", QUIET_DEBOUNCE_MS, String.raw`a stamp younger than ${N}`),
  phrase(
    "HOOK_TIMEOUT_SECONDS",
    HOOK_TIMEOUT_SECONDS * 1000,
    String.raw`HookSpec: the command, ${N}`,
  ),
  // Cline's own limit on a hook; maxims only describes it.
  phrase(
    "cline hook timeout",
    null,
    String.raw`Cline stops a hook that has not finished after ${N}`,
  ),
  // OpenCode startup times measured on one machine, in prose and in the two rows of one table.
  phrase("measured startup", null, String.raw`takes about ${N}`),
  phrase("measured startup", null, String.raw`(?:as installed|together) \| ${N} \|`),
  // The whole stdin budget is private to src/harnesses/hook-stdin.ts; only its first-chunk share is exported.
  phrase("hook stdin budget", null, String.raw`${N} in all`),
];

const SECONDS = /\b(\d+(?:\.\d+)?)[ -]s(?:econds?)?\b/g;

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

test("two windows on one line are each read by their own phrase", () => {
  const line = `it waits up to ${wait} s; a lock is stolen after ${stale + 1} seconds`;
  expect(readings("docs/x.md", line)).toEqual([
    { where: "docs/x.md:1", constant: "DEFAULT_LOCK_WAIT_MS", said: wait, actual: wait },
    { where: "docs/x.md:1", constant: "DEFAULT_LOCK_STALE_MS", said: stale + 1, actual: stale },
  ]);
});

test("an unclassified timing sentence fails by location", () => {
  expect(() => readings("docs/x.md", "ok\na retry every 7 s\n")).toThrow(
    'docs/x.md:2: "7 s" fits 0 phrases',
  );
});
