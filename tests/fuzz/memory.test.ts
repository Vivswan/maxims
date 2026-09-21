// What would drift silently: a memory file, a filename, a body or a description that makes the
// memory contract THROW instead of answering `{ ok: false, reason }`, report a hidden character at
// an index the text does not have, or hand back a wikilink the body never spelled. Every input here
// is bytes a source repository controls, so each parser must answer for all of them.
import { expect, test } from "bun:test";
import { basename } from "node:path";
import fc from "fast-check";
import {
  hiddenCharacters,
  type Memory,
  parseMemory,
  parseMemoryName,
} from "../../src/memory/contract.ts";
import { extractWikilinks, resolveWikilinks } from "../../src/memory/wikilinks.ts";
import { PROPERTY_TIMEOUT_MS } from "../convergence/property.ts";
import { anyText, budgetMs, describeError, fragments, fuzz, outcome, timed } from "./shared.ts";

// The frontmatter grammar's own tokens, so a near miss lands on the row-by-row checks rather than
// on the first byte. YAML anchors, tags and flow collections reach the branches where the YAML
// value is not a plain mapping of strings.
const FRONTMATTER_PIECES = [
  "---",
  "\n",
  "\r\n",
  "\r",
  "\ufeff",
  "name: ",
  "description: ",
  "metadata:",
  "\n  type: ",
  "\n  scope: ",
  "\n  internal: ",
  "\n  node_type: ",
  "memory",
  "user",
  "feedback",
  "project",
  "reference",
  "true",
  "no",
  "null",
  "~",
  "[[",
  "]]",
  "|",
  ">",
  "'",
  '"',
  ": ",
  "- ",
  "#",
  "&a ",
  "*a",
  "!!binary ",
  "!!map ",
  "{",
  "}",
  "[",
  "]",
  "<!--",
  "-->",
  "\u200b",
  "\u202e",
  "\x1b[0m",
  " ",
  "\t",
  "a",
  "z",
  "0",
  "-",
  "rule",
  "one-line",
];

// The long arm straddles the 200-character name cap, which the small default size never reaches.
const stem = fc.oneof(
  fc.stringMatching(/^[a-z0-9]+(-[a-z0-9]+){0,4}$/),
  fc.stringMatching(/^[a-zA-Z0-9._-]{0,12}$/),
  anyText({ maxLength: 20 }),
  fc
    .array(fc.constantFrom("a", "z", "0", "-"), { minLength: 190, maxLength: 212, size: "max" })
    .map((chars) => chars.join("")),
);

const filename = fc.oneof(
  stem.map((base) => `${base}.md`),
  stem,
  fc.constant("MEMORY.md"),
  fc.tuple(anyText({ maxLength: 10 }), stem).map(([dir, base]) => `${dir}/${base}.md`),
);

// A shaped file: a frontmatter whose name may or may not agree with the stem, a description that
// may be missing, empty, multi-line or a non-string, and a metadata mapping with wrong types.
function shapedFile(
  parts: {
    stem: string;
    nameLine: string | null;
    description: string | null;
    metadata: string | null;
    fence: string;
    body: string;
  },
  eol: string,
): string {
  const lines = ["---"];
  if (parts.nameLine !== null) lines.push(parts.nameLine.replace("{stem}", parts.stem));
  if (parts.description !== null) lines.push(`description: ${parts.description}`);
  if (parts.metadata !== null) lines.push(parts.metadata);
  lines.push(parts.fence);
  return `${lines.join(eol)}${eol}${parts.body}`;
}

const shaped = fc
  .tuple(
    fc.record({
      stem: fc.stringMatching(/^[a-z0-9]+(-[a-z0-9]+){0,3}$/),
      nameLine: fc.option(
        fc.constantFrom("name: {stem}", "name: '{stem}'", "name: other", "name: [{stem}]"),
      ),
      description: fc.option(
        fc.oneof(
          fc.constant(""),
          fc.constant("''"),
          fc.constant("|\n  two\n  lines"),
          fc.constant("123"),
          fc.constant("[a, b]"),
          anyText({ maxLength: 80 }).filter((text) => !/[\r\n]/.test(text)),
        ),
      ),
      metadata: fc.option(
        fc.constantFrom(
          "metadata:\n  type: user",
          "metadata:\n  type: 7",
          "metadata:\n  internal: yes",
          "metadata:\n  internal: maybe",
          "metadata:\n  node_type: memory",
          "metadata:\n  node_type: rule",
          "metadata:\n  scope: [x]",
          "metadata: []",
          "metadata: text",
          "metadata: null",
        ),
      ),
      fence: fc.constantFrom("---", "--- ", "---\t", "----", "--"),
      body: anyText({ maxLength: 200 }),
    }),
    fc.constantFrom("\n", "\r\n"),
  )
  .map(([parts, eol]) => ({
    filename: `${parts.stem}.md`,
    text: shapedFile(parts, eol),
  }));

const memoryFile = fc.oneof(
  fc.record({ filename, text: anyText({ maxLength: 4096, size: "large" }) }),
  fc.record({ filename, text: fragments(FRONTMATTER_PIECES, { maxLength: 200 }) }),
  shaped,
);

// The contract promises a `{ ok: false, reason }` for anything the row-by-row checks did not
// anticipate; a body is the file's own bytes after the closing fence, the raw text is the file,
// and an accepted name is one the name parser hands back unchanged.
// A YAML or regex blow-up on one file would stall a fetch of the whole source, so a file of a few
// KiB gets a budget far below what a human would notice.
test(
  "parseMemory returns a typed answer for any filename and file text",
  async () => {
    await fuzz("parseMemory", memoryFile, ({ filename, text }) => {
      const { value: result, ms } = timed(() => outcome(() => parseMemory(filename, text)));
      if (result.kind === "threw") throw new Error(`threw ${describeError(result.error)}`);
      expect(ms).toBeLessThan(budgetMs(text.length, 5));
      const parsed = result.value;
      if (!parsed.ok) {
        expect(parsed.reason.length).toBeGreaterThan(0);
        return;
      }
      const { memory } = parsed;
      expect(`${memory.name}.md`).toBe(basename(filename));
      expect(parseMemoryName(memory.name)).toBe(memory.name);
      expect(memory.raw).toBe(text);
      expect(text.endsWith(memory.body)).toBe(true);
      expect(memory.description).toBe(memory.description.trim());
      expect(memory.description).not.toBe("");
      expect(memory.description).not.toMatch(/[\r\n]/);
      expect(memory.contentHash).toMatch(/^sha256:[0-9a-f]{64}$/);
      if (memory.metadata.type !== undefined) {
        expect(["user", "feedback", "project", "reference"]).toContain(memory.metadata.type);
      }
    });
  },
  PROPERTY_TIMEOUT_MS,
);

const HIDDEN_PIECES = [
  "\u200b",
  "\u200c",
  "\u200d",
  "\u2060",
  "\ufeff",
  "\u061c",
  "\u200e",
  "\u200f",
  "\u202a",
  "\u202e",
  "\u2066",
  "\u2069",
  "\x1b",
  "\x00",
  "\x7f",
  "\x9f",
  "<!--",
  "<!-",
  "<",
  "-->",
  "\t",
  "\n",
  "\r",
  " ",
  "a",
  "\u{1F431}",
  "\u0301",
];

const hiddenInput = fc.oneof(
  anyText({ maxLength: 2048 }),
  fragments(HIDDEN_PIECES, { maxLength: 300 }),
);

test(
  "hiddenCharacters reports only indices the text has, in order, naming the code point there",
  async () => {
    await fuzz("hiddenCharacters", hiddenInput, (text) => {
      const result = outcome(() => hiddenCharacters(text));
      if (result.kind === "threw") throw new Error(`threw ${describeError(result.error)}`);
      let previous = -1;
      for (const found of result.value) {
        expect(found.index).toBeGreaterThan(previous);
        expect(found.index).toBeLessThan(text.length);
        previous = found.index;
        if (found.kind === "html-comment") expect(text.startsWith("<!--", found.index)).toBe(true);
        else expect(text.codePointAt(found.index)).toBe(found.codePoint);
      }
      const plain = /^[\t\n\r\x20-\x7e]*$/.test(text);
      if (plain && !text.includes("<!--")) expect(result.value).toEqual([]);
    });
  },
  PROPERTY_TIMEOUT_MS,
);

const WIKILINK_PIECES = ["[[", "]]", "[", "]", "|", "\n", " ", "a", "b-c", "-", "|alias", "[[x]]"];
const body = fc.oneof(anyText({ maxLength: 1024 }), fragments(WIKILINK_PIECES, { maxLength: 80 }));

test(
  "extractWikilinks hands back trimmed, unique targets the body spells",
  async () => {
    await fuzz("extractWikilinks", body, (text) => {
      const result = outcome(() => extractWikilinks(text));
      if (result.kind === "threw") throw new Error(`threw ${describeError(result.error)}`);
      expect(new Set(result.value).size).toBe(result.value.length);
      for (const target of result.value) {
        expect(target).toBe(target.trim());
        expect(target).not.toBe("");
        expect(target).not.toMatch(/[[\]\n|]/);
        expect(text).toContain(target);
      }
    });
  },
  PROPERTY_TIMEOUT_MS,
);

const memoryName = fc.stringMatching(/^[a-z][a-z0-9]{0,3}(-[a-z0-9]{1,3}){0,2}$/);

// A body is built from the links it is meant to carry, so the expected unmet set comes from the
// generator and not from the extractor under test.
function bodyWith(links: readonly string[], noise: string): string {
  return links.map((link) => `[[${link}]]`).join(noise === "" ? " " : noise);
}

// The name is quoted: YAML would read a generated "null" or "true" as a non-string scalar.
function memoryOf(name: string, text: string): Memory {
  const file = `---\nname: ${JSON.stringify(name)}\ndescription: d\n---\n${text}`;
  const parsed = parseMemory(`${name}.md`, file);
  if (!parsed.ok) throw new Error(`fixture memory ${name} did not parse: ${parsed.reason}`);
  return parsed.memory;
}

const resolveInput = fc.record({
  incoming: fc.uniqueArray(
    fc.record({
      name: memoryName,
      links: fc.array(memoryName, { maxLength: 4 }),
      noise: fc.stringMatching(/^[ a-z\n]{0,6}$/),
    }),
    { maxLength: 6, selector: (memory) => memory.name },
  ),
  installed: fc.array(memoryName, { maxLength: 6 }),
  rename: fc.dictionary(memoryName, memoryName, { maxKeys: 4 }),
});

// The documented rule: a link resolves through the rename map to the local name and ONLY to it,
// so an installed memory under the pre-rename name never satisfies a renamed link.
test(
  "resolveWikilinks reports exactly the links whose local name nothing provides",
  async () => {
    await fuzz("resolveWikilinks", resolveInput, ({ incoming, installed, rename }) => {
      const memories = incoming.map(({ name, links, noise }) =>
        memoryOf(name, bodyWith(links, noise)),
      );
      const result = outcome(() => resolveWikilinks(memories, new Set<string>(installed), rename));
      if (result.kind === "threw") throw new Error(`threw ${describeError(result.error)}`);
      const local = (name: string) => (Object.hasOwn(rename, name) ? rename[name] : name);
      const available = new Set<string>([...installed, ...incoming.map((m) => local(m.name))]);
      const expected = incoming.flatMap(({ name, links }) =>
        [...new Set(links)]
          .filter((link) => !available.has(local(link)))
          .map((link) => `${name} -> ${link}`),
      );
      const reported = result.value.unmet.map(({ memory, link }) => `${memory} -> ${link}`);
      expect(reported.sort()).toEqual(expected.sort());
    });
  },
  PROPERTY_TIMEOUT_MS,
);
