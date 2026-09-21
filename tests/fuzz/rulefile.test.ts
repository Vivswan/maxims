// What would drift silently: a rule file whose bytes make the block scanner THROW, report lines
// that do not partition the file, find a block whose span does not start and end on its own
// markers, lose the user's bytes around an appended block, fail to strip what it just appended, or
// go quadratic on a large file; the name index throwing on odd names or timestamps or handing a
// name to a later installer. Every rule file is one the user also edits by hand, so the scanner must answer for
// any bytes it finds there.
import { expect, test } from "bun:test";
import fc from "fast-check";
import { type MemoryName, parseMemoryName } from "../../src/memory/contract.ts";
import {
  markdownLines,
  ownLineMatcher,
  parseBlocks,
  replaceBlock,
  scanLines,
  stripBlock,
} from "../../src/rulefile/block.ts";
import { buildNameIndex, compareInstalled, type IndexedSource } from "../../src/rulefile/dedupe.ts";
import { PROPERTY_TIMEOUT_MS } from "../convergence/property.ts";
import { anyText, budgetMs, describeError, fragments, fuzz, outcome, timed } from "./shared.ts";

const SOURCE = "@example-user/rules";
const BEGIN = `<!-- maxims:begin ${SOURCE} sha=3f2a9c1e -->`;
const END = `<!-- maxims:end ${SOURCE} -->`;
const BLOCK = `${BEGIN}\n- Rule one. (detail: rules/one.md, 3f2a9c1)\n${END}\n`;

// Marker fragments, every block opener the scanner knows, list and quote prefixes, link
// reference definition pieces and the three line endings, so a random join lands on the
// scanner's own state transitions.
const FILE_PIECES = [
  "<!-- maxims:begin ",
  SOURCE,
  "@other/source",
  " sha=",
  "3f2a9c1e",
  " -->",
  "<!-- maxims:end ",
  "-->",
  "<!--",
  BEGIN,
  END,
  "```",
  "~~~",
  "````",
  "\n",
  "\r\n",
  "\r",
  "> ",
  ">",
  "- ",
  "* ",
  "1. ",
  "  ",
  "    ",
  "\t",
  "<pre>",
  "</pre>",
  "<script>",
  "<div>",
  "<details>",
  "<?",
  "?>",
  "<![CDATA[",
  "]]>",
  "<!DOCTYPE",
  "<b>",
  "</b>",
  "[label]: ",
  "[label]:",
  "<dest>",
  '"title',
  "'title",
  "(title",
  "===",
  "---",
  "# ",
  "\ufeff",
  "\\",
  "`",
  "*",
  "a",
  "text",
  " ",
];

// Whole blocks for this and other sources, duplicates included, between user lines, unterminated
// begins and fence openers: the shapes that reach the span, duplicate and round-trip assertions,
// which random fragments almost never assemble.
const blockFor = fc
  .tuple(
    fc.constantFrom(SOURCE, "@other/source", "@third/one#v2"),
    fc.stringMatching(/^[0-9a-f]{7}$/),
  )
  .map(
    ([source, sha]) =>
      `<!-- maxims:begin ${source} sha=${sha} -->\n- Rule. (detail: d.md, ${sha})\n<!-- maxims:end ${source} -->`,
  );
const segment = fc.oneof(
  blockFor,
  fc.constant(BEGIN),
  fc.constant(END),
  fc.constant("```"),
  fc.constant("<!--"),
  fc.constant(""),
  fragments(FILE_PIECES, { maxLength: 6 }),
  anyText({ maxLength: 40 }),
);
const structured = fc
  .tuple(fc.array(segment, { maxLength: 8 }), fc.constantFrom("\n", "\r\n", "\r"))
  .map(([segments, ending]) => segments.join(ending));

const fileText = fc.oneof(
  anyText({ maxLength: 4096, size: "large" }),
  fragments(FILE_PIECES, { maxLength: 200 }),
  structured,
);

// The scanner is documented linear; the 3 MiB rows below finish in well under a second on a
// slow runner, so a millisecond per KiB is the rate every random file is held to.
const MS_PER_KIB = 1;

const LINE_ENDING = /^(\r\n|\r|\n)?$/;

test(
  "markdownLines partitions any file into lines that carry their own bytes",
  async () => {
    await fuzz("markdownLines", fileText, (text) => {
      const { value: result, ms } = timed(() => outcome(() => markdownLines(text)));
      if (result.kind === "threw") throw new Error(`threw ${describeError(result.error)}`);
      expect(ms).toBeLessThan(budgetMs(text.length, MS_PER_KIB));
      let cursor = text.startsWith("\ufeff") ? 1 : 0;
      for (const line of result.value) {
        expect(line.start).toBe(cursor);
        expect(line.end).toBeGreaterThan(line.start);
        const raw = text.slice(line.start, line.end);
        expect(raw.startsWith(line.text)).toBe(true);
        expect(raw.slice(line.text.length)).toMatch(LINE_ENDING);
        cursor = line.end;
      }
      expect(cursor).toBe(text.length);
    });
  },
  PROPERTY_TIMEOUT_MS,
);

test(
  "parseBlocks finds only spans that open and close on their own markers, one per source",
  async () => {
    await fuzz("parseBlocks", fileText, (text) => {
      const result = outcome(() => parseBlocks(text));
      if (result.kind === "threw") throw new Error(`threw ${describeError(result.error)}`);
      const { blocks, warnings } = result.value;
      expect(new Set(blocks.map((block) => block.source)).size).toBe(blocks.length);
      let previousEnd = 0;
      for (const block of blocks) {
        expect(block.start).toBeGreaterThanOrEqual(previousEnd);
        const span = text.slice(block.start, block.end);
        expect(span.startsWith(`<!-- maxims:begin ${block.source} sha=${block.sha} -->`)).toBe(
          true,
        );
        const body = span.replace(/(\r\n|\r|\n)$/, "");
        expect(body.endsWith(`<!-- maxims:end ${block.source} -->`)).toBe(true);
        previousEnd = block.end;
      }
      for (const warning of warnings) expect(warning).toContain("two managed blocks for ");
    });
  },
  PROPERTY_TIMEOUT_MS,
);

// Appending never touches the user's bytes and leaves exactly one block for the source; when the
// file ended on a line ending with no block left open, stripping hands the user's bytes back.
test(
  "replaceBlock keeps the user's text and stripBlock removes what it appended",
  async () => {
    await fuzz("replaceBlock and stripBlock", fileText, (before) => {
      const hadBlock = parseBlocks(before).blocks.some((block) => block.source === SOURCE);
      const untouched = outcome(() => stripBlock(before, SOURCE));
      if (untouched.kind === "threw") throw new Error(`threw ${describeError(untouched.error)}`);
      if (!hadBlock) expect(untouched.value).toEqual({ text: before, emptied: false });

      const appended = outcome(() => replaceBlock(before, SOURCE, BLOCK));
      if (appended.kind === "threw") throw new Error(`threw ${describeError(appended.error)}`);
      const after = appended.value;
      const found = parseBlocks(after).blocks.filter((block) => block.source === SOURCE);
      expect(found).toHaveLength(1);
      if (hadBlock) return;
      expect(after.startsWith(before)).toBe(true);
      const terminated = before === "" || /[\r\n]$/.test(before);
      if (terminated && scanLines(before).open === null) {
        expect(stripBlock(after, SOURCE).text).toBe(before);
      }
    });
  },
  PROPERTY_TIMEOUT_MS,
);

// One huge line, a marker flood, a blockquote and list nesting flood, opener floods and a CR flood
// at 3 MiB: the shapes where a scanner that re-reads a line per level or per marker goes quadratic.
const MIB = 1024 * 1024;
const large: [string, string][] = [
  ["one 3 MiB line", "a".repeat(3 * MIB)],
  ["3 MiB of begin markers", `${BEGIN}\n`.repeat(Math.ceil((3 * MIB) / (BEGIN.length + 1)))],
  ["3 MiB of nested quotes and items", "> - ".repeat(Math.ceil((3 * MIB) / 4))],
  ["3 MiB of fence openers", "```\n".repeat(Math.ceil((3 * MIB) / 4))],
  ["3 MiB of comment openers", "<!--\n".repeat(Math.ceil((3 * MIB) / 5))],
  ["3 MiB of CR", "\r".repeat(3 * MIB)],
];

test.each(large)("parseBlocks stays linear on %s", (_label, text) => {
  const { ms } = timed(() => parseBlocks(text));
  expect(ms).toBeLessThan(budgetMs(text.length, MS_PER_KIB));
});

const sourceKey = fc.oneof(
  anyText({ maxLength: 60 }),
  fc.constant(SOURCE),
  fc.stringMatching(/^@[a-z]{1,5}\/[a-z]{1,5}(#[a-z0-9.]{1,4})?$/),
);
const line = fc.oneof(
  anyText({ maxLength: 200 }),
  fragments(FILE_PIECES, { maxLength: 8 }),
  fc.constant(BEGIN),
  fc.constant(END),
);

test(
  "ownLineMatcher builds for any source, owns its end marker and never a line without maxims in it",
  async () => {
    await fuzz("ownLineMatcher", fc.tuple(sourceKey, line), ([source, text]) => {
      const built = outcome(() => ownLineMatcher(source));
      if (built.kind === "threw") throw new Error(`threw ${describeError(built.error)}`);
      const matcher = built.value;
      const judged = outcome(() => matcher(text));
      if (judged.kind === "threw") throw new Error(`threw ${describeError(judged.error)}`);
      if (!text.includes("maxims")) expect(judged.value).toBe(false);
      else expect(typeof judged.value).toBe("boolean");
      if (source !== "") expect(matcher(`<!-- maxims:end ${source} -->`)).toBe(true);
    });
  },
  PROPERTY_TIMEOUT_MS,
);

function memoryName(candidate: string): MemoryName {
  const name = parseMemoryName(candidate);
  if (name === null) throw new Error(`generator produced a non-kebab name: ${candidate}`);
  return name;
}

const name = fc.stringMatching(/^[a-z][a-z0-9]{0,2}(-[a-z0-9]{1,2}){0,1}$/).map(memoryName);
const timestamp = fc.oneof(
  fc.date({ noInvalidDate: true }).map((date) => date.toISOString()),
  fc.constantFrom("2026-01-01T00:00:00Z", "2026-01-01T00:00:00.000Z", "not a date", ""),
  anyText({ maxLength: 30 }),
);
const indexedSource: fc.Arbitrary<IndexedSource> = fc.record({
  key: fc.stringMatching(/^@[a-z]{1,4}\/[a-z]{1,4}$/),
  addedAt: timestamp,
  intent: fc.record({
    select: fc.oneof(fc.constant("*" as const), fc.array(name, { maxLength: 4 })),
    rename: fc.dictionary(name, name, { maxKeys: 3 }),
  }),
  names: fc.array(name, { maxLength: 5 }),
});

function localNames(source: IndexedSource): MemoryName[] {
  const selected =
    source.intent.select === "*"
      ? source.names
      : source.names.filter((candidate) => source.intent.select.includes(candidate));
  return selected.map((candidate) =>
    Object.hasOwn(source.intent.rename, candidate) ? source.intent.rename[candidate] : candidate,
  );
}

// Installation order as the contract states it: the earlier instant first, the smaller key on a
// tie; spelled without the comparator under test.
function installedBefore(a: IndexedSource, b: IndexedSource): boolean {
  const gap = Date.parse(a.addedAt) - Date.parse(b.addedAt);
  return gap !== 0 ? gap < 0 : a.key < b.key;
}

test(
  "compareInstalled is antisymmetric and buildNameIndex gives each name to the earliest carrier",
  async () => {
    await fuzz(
      "buildNameIndex",
      fc.uniqueArray(indexedSource, { maxLength: 5, selector: (source) => source.key }),
      (sources) => {
        for (const a of sources) {
          expect(compareInstalled(a, a)).toBe(0);
          for (const b of sources) {
            expect(Math.sign(compareInstalled(a, b)) + Math.sign(compareInstalled(b, a))).toBe(0);
          }
        }
        const result = outcome(() => buildNameIndex(sources));
        if (result.kind === "threw") throw new Error(`threw ${describeError(result.error)}`);
        const index = result.value;
        const carriers = new Map<string, IndexedSource[]>();
        for (const source of sources) {
          for (const local of localNames(source)) {
            carriers.set(local, [...(carriers.get(local) ?? []), source]);
          }
        }
        expect([...index.keys()].map(String).sort()).toEqual([...carriers.keys()].sort());
        // The state boundary admits only ISO instants, so the earliest-carrier fact is pinned for
        // those; a timestamp that is not one still gets an answer, never a throw.
        if (sources.some((source) => Number.isNaN(Date.parse(source.addedAt)))) return;
        for (const [local, owner] of index) {
          let earliest: IndexedSource | undefined;
          for (const candidate of carriers.get(local) ?? []) {
            if (earliest === undefined || installedBefore(candidate, earliest))
              earliest = candidate;
          }
          expect<string | undefined>(owner).toBe(earliest?.key);
        }
      },
    );
  },
  PROPERTY_TIMEOUT_MS,
);
