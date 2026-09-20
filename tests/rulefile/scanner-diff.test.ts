// Differential gate: the shipped scanner in src/rulefile/block.ts must read every non-blank line
// and place every closer exactly as the micromark oracle does, or the row names the CommonMark
// section where the shipped reading is an accepted deviation. A silent divergence would move a
// marker line into or out of a block on some rule file, and a block sync cannot find again is
// appended forever. The oracle never ships: micromark is 20x to 30x slower on 3 MB files and
// quadratic in list nesting, which a session-start hook cannot afford.
import { describe, expect, test } from "bun:test";
import { closerFor, scanLines } from "../../src/rulefile/block.ts";
import { scanDocument } from "./scanner-oracle.ts";

const BEGIN = "<!-- maxims:begin @Vivswan/skills sha=3f2a9c1e -->";
const END = "<!-- maxims:end @Vivswan/skills -->";
const RULE = "- Codex rubber-duck review before EVERY commit (detail: /home/user/x.md, a1b2c3d)";
const BLOCK = `${BEGIN}\n${RULE}\n${END}\n`;

type Line = { text: string; start: number; end: number; kind: string };
type Reading = { lines: string[]; closer: string };

function shippedReading(text: string): Reading {
  const { lines, open } = scanLines(text);
  return reading(lines, open === null ? "" : closerFor(open, "\n"));
}

function oracleReading(text: string): Reading {
  const { lines, open } = scanDocument(text);
  return reading(lines, open === null ? "" : `${" ".repeat(open.column)}${open.closer}\n`);
}

function reading(lines: Line[], closer: string): Reading {
  const kinds = canonical(lines);
  return {
    lines: lines.map(
      (line, i) => `${line.start}-${line.end} ${kinds[i]} ${JSON.stringify(line.text)}`,
    ),
    closer,
  };
}

// Every line is compared exactly except blank lines inside a fence or a raw HTML block, which
// read as "text" in both: the shipped scanner gives the blank line that ends a block-tag HTML
// block the block's kind, and keeps the kind of a leaf a list leaves open through the blank lines
// after it, where micromark ends the leaf before them; no consumer reads those kinds. A blank line inside
// a comment keeps its kind, since budget.ts strips a comment only when its lines stay together,
// except the trailing blank lines of a comment left open, which budget.ts keeps whole either way.
function canonical(lines: Line[]): string[] {
  const kinds = lines.map((line) => line.kind);
  let index = 0;
  while (index < lines.length) {
    if (!isBlank(lines[index])) {
      index += 1;
      continue;
    }
    let end = index;
    while (end < lines.length && isBlank(lines[end]) && kinds[end] === kinds[index]) end += 1;
    const kind = kinds[index];
    const trailing = kind === "comment-continuation" && kinds[end] !== "comment-continuation";
    if (kind === "fenced" || kind === "html" || trailing) {
      for (let i = index; i < end; i += 1) kinds[i] = "text";
    }
    index = end;
  }
  return kinds;
}

function isBlank(line: Line): boolean {
  return /^[ \t]*$/.test(line.text);
}

function oracleKinds(text: string): string[] {
  return scanDocument(text).lines.map((line) => line.kind);
}

function shippedKinds(text: string): string[] {
  return scanLines(text).lines.map((line) => line.kind);
}

describe("both scanners agree", () => {
  const agreed: [string, string][] = [
    ["an empty file", ""],
    ["a block alone", BLOCK],
    ["a block after a heading", `# Mine\n\n${BLOCK}`],
    ["a marker indented four spaces, which is code", `    ${BEGIN}\n${RULE}\n    ${END}\n`],
    ["a marker indented three spaces, which is a comment", `   ${BEGIN}\n${RULE}\n   ${END}\n`],
    ["a marker inside a pre block", `<pre>\n${BLOCK}</pre>\n`],
    ["a marker inside a comment", `<!--\n${BLOCK}-->\n`],
    ["a marker inside a processing instruction", `<?xml\n${BLOCK}?>\n`],
    ["a marker inside a declaration", `<!DOCTYPE\n${BLOCK}>\n`],
    ["a marker inside a lowercase declaration", `<!doctype\n${BLOCK}>\n`],
    ["a lowercase declaration left open", "<!doctype\nx\n"],
    ["a marker inside a CDATA section", `<![CDATA[\n${BLOCK}]]>\n`],
    ["a marker inside a div block", `<div>\n${BLOCK}</div>\n`],
    ["a marker inside a custom tag block", `<custom>\n${BLOCK}</custom>\n`],
    ["a marker after a block-tag block ended by a blank line", `<div>\nx\n\n${BLOCK}`],
    ["a marker after a custom tag block with no blank line", `<custom>\nx\n${BLOCK}`],
    ["a marker interrupting a paragraph", `text\n${BLOCK}`],
    ["a marker after a one-line comment", `<!-- note -->\n${BLOCK}`],
    ["a marker after a self-closing comment", `<!-->\n${BLOCK}`],
    ["a marker after a one-line pre block", `<pre>x</pre>\n${BLOCK}`],
    ["a marker inside a backtick fence", `\`\`\`md\n${BLOCK}\`\`\`\n`],
    ["a marker inside a tilde fence", `~~~\n${BLOCK}~~~\n`],
    ["a marker inside an unclosed fence", `\`\`\`\n${BLOCK}`],
    [
      "a fence closed only by a fence at least as long",
      `\`\`\`\`\n${BEGIN}\n\`\`\`\n${END}\n\`\`\`\`\`\n${BLOCK}`,
    ],
    ["a backtick fence whose info string holds a backtick, which is text", `\`\`\`a\`b\n${BLOCK}`],
    ["a fence opened behind three spaces", `   \`\`\`\n${BLOCK}\`\`\`\n`],
    ["a fence behind a byte order mark", `\ufeff\`\`\`md\n${BLOCK}\`\`\`\n`],
    ["a block behind a byte order mark", `\ufeff${BLOCK}`],
    [
      "a fence closer with a trailing non-breaking space, which leaves it open",
      `\`\`\`\nx\n\`\`\`\u00a0\n${BLOCK}`,
    ],
    ["a fence closed on a line ended by a lone carriage return", `\`\`\`\n\`\`\`\rtext\n${BLOCK}`],
    ["CRLF line endings throughout", BLOCK.replaceAll("\n", "\r\n")],
    ["a CRLF file ending inside a list item's fence", "- a\r\n  ```\r\n  x\r\n"],
    ["a fence inside a list item, ended by the next item", `- a\n  \`\`\`\n  x\n- b\n${BLOCK}`],
    ["a fence inside a list item, ended by the markers", `- a\n  \`\`\`\n  x\n${BLOCK}`],
    ["a fence inside a list item, left open", "- a\n  ```\n  x\n"],
    ["a fence inside a list item, left open behind a blank line", "- a\n  ```\n  x\n\n"],
    ["a fence inside a list item, left open behind two blank lines", "- ```\n\n\n"],
    ["a comment inside a list item, left open behind a blank line", "- <!--\n\n"],
    [
      "a fence inside a list item, closed by a column-0 fence",
      `- a\n  \`\`\`\n  x\n\`\`\`\n${BLOCK}`,
    ],
    [
      "a fence inside a nested item, ended by the outer item",
      `- a\n  - b\n    \`\`\`\n  - c\n${BLOCK}`,
    ],
    ["a fence inside a nested item, left open", "- a\n  - b\n    ~~~\n    x\n"],
    ["a fence indented past its item's column, left open", "- a\n    ```\n    x\n"],
    ["a fence under a tab-padded item, left open", "-\t```\n\tx\n"],
    ["a fence inside an item indented with a tab", `- a\n\t\`\`\`\n\tx\n- b\n${BLOCK}`],
    ["a fence inside an item after a blank line in it", `- a\n  \`\`\`\n\n  x\n- b\n${BLOCK}`],
    [
      "an item's fence indented by a tab reaching column four",
      `- a\n  \t\`\`\`\nx\n  \`\`\`\n${BLOCK}`,
    ],
    ["a fence reached across a lazy paragraph line", `- a\nlazy\n  \`\`\`\n- b\n${BLOCK}`],
    ["a fence reached across a lazy heading-shaped line", "-    a\n    # h\n     ```\n"],
    ["a list item whose content column is five", `1.   a\n     \`\`\`\n     x\n`],
    ["a list item whose content column is six, left open", `10.   a\n      \`\`\`\n`],
    ["a marker after an item whose marker is followed by five spaces", `-     code\n${BLOCK}`],
    ["indented code after a blank line in a list", `- a\n\n      code\n${BLOCK}`],
    ["mixed bullets ending each other", `- a\n+ b\n* c\n  \`\`\`\n- d\n${BLOCK}`],
    [
      "an ordered marker numbered two continuing its own item's paragraph",
      `1. a\n   2. b\n   \`\`\`\n- c\n${BLOCK}`,
    ],
    [
      "an ordered marker numbered two lazily continuing a paragraph",
      `- a\n2. b\n  \`\`\`\n- c\n${BLOCK}`,
    ],
    [
      "an ordered marker numbered one interrupting a paragraph",
      `- a\n1. b\n  \`\`\`\n- c\n${BLOCK}`,
    ],
    ["an empty item ended by a blank line, then an indented fence", `-\n\n  \`\`\`\n${BLOCK}`],
    [
      "an empty item that ends its sibling's paragraph and holds a fence",
      `- a\n-\n  \`\`\`\n${BLOCK}`,
    ],
    ["a heading item ended by a lazy line", `- # h\nfoo\n  \`\`\`\n- b\n${BLOCK}`],
    ["a div inside a list item, ended by the markers", `- <div>\n  x\n${BLOCK}`],
    ["a div inside a list item, left open", "- a\n  <div>\n  x\n"],
    ["a pre block inside a list item, left open", "- a\n  <pre>\n  x\n"],
    ["a pre block opened past its item's column, left open", "- a\n   <pre>\n  x\n"],
    ["a comment inside a list item, left open", "- a\n  <!--\n  x\n"],
    ["a comment inside a list item, ended by the markers", `- <!--\n  x\n${BLOCK}`],
    ["a blockquote holding a fence, ended by the markers", `> \`\`\`\n> x\n${BLOCK}`],
    ["a blockquote holding a fence, left open at the end", "> ```\n> x\n"],
    ["a blockquote holding a comment, left open at the end", "> <!--\n> x"],
    ["a blockquote inside an item holding a fence", `- > \`\`\`\n  > x\n${BLOCK}`],
    [
      "a blockquoted fence inside an item, which a lone tag cannot continue",
      `- > \`\`\`\n<custom>\n${BLOCK}`,
    ],
    ["a lone tag after a blockquote ending in a fence", `> \`\`\`\n> x\n<custom>\n${BLOCK}`],
    [
      "a lazy line continuing a blockquote's paragraph inside an item",
      `- > a\nlazy\n  \`\`\`\n- b\n${BLOCK}`,
    ],
    ["nested quotes whose tabs reach an indented code block", `>\t>\t  x\n<custom>\n${BLOCK}`],
    ["nested quotes whose tab reaches a paragraph", `> >\t  x\n<custom>\n${BLOCK}`],
    ["a lone tag continuing a paragraph, which it cannot interrupt", `text\n<custom>\n${BLOCK}`],
    [
      "a paragraph underlined by equals signs, after which a lone tag opens a block",
      `text\n===\n<custom>\n${BLOCK}`,
    ],
    ["a setext underline under a marker-like line", `${BEGIN}x\n===\n${BLOCK}`],
    ["a thematic break under a marker-like line", `${BEGIN}x\n---\n${BLOCK}`],
    [
      "a paragraph of link reference definitions, which equals signs cannot underline",
      `[x]: /url\n===\n<custom>\n${BLOCK}`,
    ],
    [
      "a definition-shaped line with text after it, which equals signs underline",
      `[x]: /url junk\n===\n<custom>\n${BLOCK}`,
    ],
    ["a definition ended by a thematic break", `[x]: /url\n---\n<custom>\n${BLOCK}`],
    ["a definition whose destination sits on the next line", `[x]:\n/url\n===\n<custom>\n${BLOCK}`],
    [
      "a definition whose title sits on the next line",
      `[x]: /url\n"title"\n===\n<custom>\n${BLOCK}`,
    ],
    ["a label alone, which equals signs underline", `[x]:\n===\n<custom>\n${BLOCK}`],
    ["a title spanning two lines", `[x]: /url "hello\nworld"\n===\n<custom>\n${BLOCK}`],
    ["a label spanning two lines", `[hello\nworld]: /url\n===\n<custom>\n${BLOCK}`],
    [
      "a title left open, which equals signs underline",
      `[x]: /url "hello\n===\n<custom>\n${BLOCK}`,
    ],
    ["a label left open, which equals signs underline", `[hello\n===\n<custom>\n${BLOCK}`],
    ["a destination with an escaped space, which is prose", `[x]: /a\\ b\n===\n<custom>\n${BLOCK}`],
    ["a destination ending in a lone backslash", `[x]: /a\\\n===\n<custom>\n${BLOCK}`],
    ["a destination with balanced parentheses", `[x]: /a(b)\n===\n-\n  \`\`\`\n${BLOCK}`],
    ["a destination holding a NUL", `[x]: /a\0b\n===\n<custom>\n${BLOCK}`],
    [
      "a label of a thousand characters written as escape pairs",
      `[${"\\!".repeat(500)}]: /url\n===\n<custom>\n${BLOCK}`,
    ],
    ["a pre block closed by another literal tag's end", `<pre>\nx\n</style>\n${BLOCK}`],
    ["a pre block left open", "<pre>\ncode\n"],
    ["a processing instruction left open", "<?php\n"],
    ["a comment left open", "# Mine\n<!--\nnote\n"],
    ["a comment left open behind blank lines", "<!--\nnote\n\n\n"],
    ["a declaration left open", "<!X\nx\n"],
    ["a CDATA section left open", "<![CDATA[\nx\n"],
    ["a block-tag block left open, which the blank line closes", "<div>\nx\n"],
    ["a custom tag block left open, which the blank line closes", "<custom>\nx\n"],
    ["an indented pre block left open", "  <pre>\nx\n"],
    ["a fence left open with no final newline", "```js\nx"],
    ["a fence closed with no final newline", "```\nx\n```"],
    ["a comment closed with no final newline", "<!--\nx\n-->"],
    ["a fence whose info string holds a line separator", "```js\u2028\nx\n```\n"],
    [
      "a marker whose source holds a line separator",
      `<!-- maxims:begin /home/user/n\u2028m sha=1 -->\n<!-- maxims:end /home/user/n\u2028m -->\n`,
    ],
    ["a lone tag with attributes", `<custom attr="x" data-y='z' flag>\n${BLOCK}`],
    ["a closing tag alone", `</custom>\n${BLOCK}`],
    ["a custom tag followed by text, which is a paragraph", `<custom>text\n${BLOCK}`],
    ["sixty-four nested list items", `${"- ".repeat(64)}x\n${BLOCK}`],
    ["sixty-four nested blockquotes", `${">".repeat(64)}x\n${BLOCK}`],
    ["a hundred lazy lines", `- x\n${"x\n".repeat(100)}${BLOCK}`],
    ["a pre block behind a tab an item's indent consumes in part", "- a\n\t<pre>\n"],
    ["a comment inside an item that starts with a blank line", "-\n  <!--\n"],
    [
      "a pre block inside an item whose marker's tab padding is partly indented code",
      "-\t\tcode\n\n  <pre>\n",
    ],
    ["a pre block inside an item whose marker is followed by whitespace only", "-   \n  <pre>\n"],
    [
      "a pre block inside an item whose marker is followed by five spaces",
      "-     code\n\n  <pre>\n",
    ],
    ["a pre block inside an ordered item that starts with a blank line", "1.\n   <pre>\n"],
    ["a fence behind a tab an item's indent consumes in part", "- a\n\t```\n"],
    ["a comment closed across blank lines inside an item", `- <!--\n\n  x\n\n-->\n${BLOCK}`],
    ["a comment left open across blank lines inside an item", "- <!--\n\n  x\n\n"],
    ["a lone tag lazily continuing a blockquote's paragraph", `>\tx\n<custom>\n${BLOCK}`],
    ["a lone tag after a lazy equals-sign line under a blockquote", `> a\n===\n<custom>\n${BLOCK}`],
    ["a lone tag with text after it on a lazy line under an item", `- a\n<custom> x\n${BLOCK}`],
  ];
  test.each(agreed)("%s", (_label, text) => {
    expect(oracleReading(text)).toEqual(shippedReading(text));
  });
});

// Accepted deviations: rows where the shipped scanner reads whitespace as JavaScript does, as
// commonmark.js and markdown-it do, where the CommonMark 0.31.2 text (and the oracle) mean spaces
// and tabs only. Each row pins the shipped reading as the behavior that ships, names the section,
// and says where the reference parsers stand; marked is Claude Code's lexer.
describe("accepted deviations of the shipped scanner from the specification", () => {
  // Columns: what the shipped scanner does, the section it deviates from, where the reference
  // parsers stand (JS = commonmark.js and markdown-it), the document, the shipped kinds and closer.
  const deviations: [string, string, string, string, string[], string][] = [
    [
      "a tag holding a form feed opens a block that hides the marker under it",
      "6.6: attributes are separated by spaces, tabs and up to one line ending",
      "JS agrees; marked reads a paragraph and the marker",
      `<custom\f>\n${BLOCK}`,
      ["html", "html", "html", "html"],
      "",
    ],
    [
      "a tag followed by a form feed opens a block that hides the marker under it",
      "4.6 start condition 7: followed only by spaces or tabs",
      "JS agrees; marked reads a paragraph and the marker",
      `<custom>\f\n${BLOCK}`,
      ["html", "html", "html", "html"],
      "",
    ],
    [
      "a tag followed by a non-breaking space opens a block that hides the marker under it",
      "4.6 start condition 7",
      "JS agrees; marked reads a paragraph and the marker",
      `<b>\u00a0\n${BLOCK}`,
      ["html", "html", "html", "html"],
      "",
    ],
    [
      "a pre tag broken by a non-breaking space opens a block-tag block, closed by the blank line",
      "6.6: tag whitespace is spaces, tabs and one line ending",
      "JS and marked agree",
      "<pre\u00a0>\nx\n",
      ["html", "html"],
      "",
    ],
    [
      "a label of only a non-breaking space is no link label, so the equals signs underline a heading and the lone tag opens a block",
      "6.3: a label holds a character that is not a space, tab or line ending",
      "JS and marked agree",
      `[\u00a0]: /url\n===\n<custom>\n${BLOCK}`,
      ["text", "text", "html", "html", "html", "html"],
      "",
    ],
  ];
  test.each(deviations)(
    "%s (spec %s; %s)",
    (_label, _spec, _sides, text, expectedKinds, expectedCloser) => {
      expect(shippedKinds(text)).toEqual(expectedKinds);
      expect(shippedReading(text).closer).toBe(expectedCloser);
      expect(oracleReading(text)).not.toEqual(shippedReading(text));
    },
  );
});

// Where the oracle departs from the other CommonMark parsers. Each row pins the oracle's reading
// so that a micromark release changing it is noticed, and says what the marker after the
// construct becomes.
describe("the oracle departs from the reference parsers", () => {
  // A complete tag alone on a lazy line under a list item: the spec's laziness rule (5.2) makes it
  // paragraph text, as the shipped scanner and commonmark.js read it, since the tag could not
  // interrupt the paragraph behind the item's indentation. micromark opens an HTML block inside
  // the item, which the unindented marker line then ends, so the marker is recognized either way;
  // cmark and marked open the block at the top level and hide the marker in it.
  test("a lone tag on a lazy line under a list item reads as HTML, and the marker after it stays a marker", () => {
    const text = `- a\n<custom>\n${BLOCK}`;
    expect(shippedKinds(text)).toEqual(["text", "text", "comment", "text", "comment"]);
    expect(oracleKinds(text)).toEqual(["text", "html", "comment", "text", "comment"]);
    expect(oracleKinds(`- a\n<custom>\n\n${BLOCK}`)).toEqual([
      "text",
      "html",
      "text",
      "comment",
      "text",
      "comment",
    ]);
  });

  // A self-closing raw tag alone on a line: spec 4.6 condition 7 excludes the four raw names, so
  // marked reads a paragraph and the marker under it; cmark, commonmark.js, micromark and the
  // shipped scanner all open a block that hides the marker until a blank line.
  test("a self-closing pre tag alone opens an HTML block, as every CommonMark parser but the specification reads it", () => {
    const text = `<pre/>\n${BLOCK}`;
    expect(oracleReading(text)).toEqual(shippedReading(text));
    expect(oracleKinds(text)).toEqual(["html", "html", "html", "html"]);
  });

  // micromark keeps the paragraph-interrupting rule (spec 5.3, example 304: an ordered list that
  // interrupts a paragraph starts at 1) switched on for every container opened later on the same
  // line, so `2)` after `1. +` reads as paragraph text; cmark, commonmark.js, markdown-it and
  // marked all open the list. micromark also ends an unquoted attribute value at a slash, which
  // spec 6.6 allows there, so a tag holding one is no tag and the marker under it interrupts the
  // paragraph; cmark, commonmark.js, marked and the shipped scanner read the block. Each row
  // fails on purpose until a micromark release corrects it.
  const defects: [string, string][] = [
    [
      "an ordered marker numbered two after containers opened on a paragraph-interrupting line",
      "x\n1. + 2) <pre>\n",
    ],
    ["a tag whose unquoted attribute value holds a slash", `<custom a=b/c>\n${BLOCK}`],
  ];
  test.failing.each(defects)("%s", (_label, text) => {
    expect(oracleReading(text)).toEqual(shippedReading(text));
  });
});

// mulberry32 and the inline pieces, copied from src/rulefile/block.test.ts so that a failing case
// is reproducible from its index alone. The copy leaves out the inline tags and the non-breaking
// space: a lone tag under a list item and a non-breaking space beside a tag are the two readings
// the rows above attribute, and every generated document must read alike. The pieces can still
// spell a bare tag such as `<a-->` from `<`, `a` and `-->`; the seeds in use never place one
// lazily under an item, and a seed that did would fail the comparison rather than hide it.
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const PIECES = [
  "-->",
  "<!--",
  "<!-->",
  "@",
  "@~/.ssh/id_rsa",
  "@../../secrets.env",
  "#file:x",
  "`",
  "``",
  "```",
  "\\",
  "\\`",
  "<",
  "[x](",
  "](`",
  "]",
  "*",
  "_",
  "~~",
  "[x]: ",
  "<![CDATA[",
  "<?",
  "<div>",
  "\u2028",
  '"',
  "<pre>",
  "~~~",
  "\n",
  "\r\n",
  " ",
  "\t",
  "\u65e5\u672c\u8a9e",
  "\u00e9",
  "\u{1F600}",
  "a",
  "word",
  "-",
  "(",
  ")",
  END,
  BEGIN,
  "<!-- maxims:end @Vivswan/skills",
];

// Block-structure pieces: every container and leaf opener the scanner classifies, in two lists.
// The first holds the list markers and no lone inline tag; the second holds the inline tags and
// no list marker, since a lone inline tag on a lazy line under a list item is the micromark
// departure pinned above. The only ordered marker is `1. `, because a later number after another
// container on a paragraph-interrupting line hits the micromark defect pinned above.
const LISTS = [
  "- ",
  "* ",
  "+ ",
  "1. ",
  "> ",
  "  ",
  "   ",
  "    ",
  "\t",
  "\n",
  "\n\n",
  "\r\n",
  "```",
  "~~~",
  "````",
  "```js",
  "<pre>",
  "</pre>",
  "<!--",
  "-->",
  "<!-->",
  "<div>",
  "</div>",
  "<?x",
  "?>",
  "<![CDATA[",
  "]]>",
  "<!X",
  ">",
  "# h",
  "===",
  "---",
  "***",
  "[x]: /url",
  "[x]:",
  "/url",
  '"title"',
  "[x",
  "]: ",
  "x",
  "word",
  "a",
  "\\",
  END,
  BEGIN,
  "<!-- maxims:begin s sha=1 -->",
  "<!-- maxims:end s -->",
];
const TAGS = [
  "> ",
  "  ",
  "   ",
  "    ",
  "\t",
  "\n",
  "\n\n",
  "\r\n",
  "```",
  "~~~",
  "````",
  "```js",
  "<pre>",
  "</pre>",
  "<!--",
  "-->",
  "<!-->",
  "<div>",
  "<custom>",
  "<custom attr='x'>",
  "</custom>",
  "</div>",
  "<?x",
  "?>",
  "<![CDATA[",
  "]]>",
  "<!X",
  ">",
  "# h",
  "===",
  "---",
  "***",
  "[x]: /url",
  "[x]:",
  "/url",
  '"title"',
  "[x",
  "]: ",
  "x",
  "word",
  "a",
  "\\",
  END,
  BEGIN,
  "<!-- maxims:begin s sha=1 -->",
  "<!-- maxims:end s -->",
];

function pick<T>(random: () => number, items: readonly T[]): T {
  return items[Math.floor(random() * items.length)];
}

function text(random: () => number, pieces: readonly string[], target: number): string {
  let out = "";
  while (out.length < target) out += pick(random, pieces);
  return out;
}

function length(random: () => number): number {
  return random() < 0.05 ? 10_000 : Math.floor(random() * 64);
}

describe("random documents", () => {
  const CASES = 2000;
  const generators: [string, readonly string[], string][] = [
    ["inline pieces", PIECES, ""],
    ["list pieces", LISTS, "\n"],
    ["tag pieces", TAGS, "\n"],
  ];
  test.each(generators)(
    "%s: both scanners read every generated document alike",
    (_label, pieces, separator) => {
      for (let i = 0; i < CASES; i += 1) {
        const random = rng(20260920 + i);
        const body = text(random, pieces, length(random));
        for (const doc of [body, `${body}${separator}${BLOCK}`]) {
          expect(oracleReading(doc), `case ${i}: ${JSON.stringify(doc)}`).toEqual(
            shippedReading(doc),
          );
        }
      }
    },
  );
});
