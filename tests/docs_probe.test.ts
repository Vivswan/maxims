// Fails if the docs probe stops counting a `<placeholder>` inside a code span as a word: the
// inline-HTML strip would then eat it, a 71-word paragraph would pass the 70-word cap, and the
// docs:check gate would stay green on a page that is over it. Also fails if the locator stops
// placing a table's rows on consecutive lines under its header, starts searching for a cell's
// text, or lets a code block, an HTML block, or a generated region sit under the cursor when the
// next table is located: a cell, or the paragraph after the table, would then be reported on the
// wrong line. Also fails if a list item's own text is located before the nested blocks that
// precede it in the source: a fence inside the item would then pass under the cursor after the
// item, and the paragraph it quotes, and every unit after it, would be reported lines too late.
import { expect, test } from "bun:test";
import {
  DEFAULT_MAX_CELL_WORDS,
  DEFAULT_MAX_WORDS,
  probePage,
  scanPage,
} from "../scripts/docs_probe.mts";

const words = (count: number) => Array.from({ length: count }, (_, i) => `word${i}`).join(" ");
const page = (paragraph: string) => `# Title\n\n${paragraph}\n`;
const options = {
  root: "/",
  maxWords: DEFAULT_MAX_WORDS,
  maxCellWords: DEFAULT_MAX_CELL_WORDS,
  paths: false,
};

const cases: [name: string, paragraph: string, reportedWords: number | null][] = [
  ["seventy-one plain words", words(71), 71],
  ["seventy plain words", words(70), null],
  ["a code-span placeholder counts its words", `${words(69)} \`--expect <name>\``, 71],
  ["a code-span placeholder on the cap stays clean", `${words(68)} \`--expect <name>\``, null],
  ["an HTML comment inside a code span is text", `${words(69)} \`<!-- x -->\``, 72],
  ["an inline tag outside a code span is not a word", `${words(70)} <br>`, null],
  [
    "an HTML comment outside a code span is not text",
    `${words(70)} <!-- three hidden words -->`,
    null,
  ],
  [
    "a paragraph opening with a link plus a suffix is found on its own line",
    `[GitHub](https://github.com)-hosted ${words(70)}`,
    71,
  ],
];

test.each(cases)("%s", (_name, paragraph, reportedWords) => {
  const findings = probePage(page(paragraph), "page.md", options);
  if (reportedWords === null) {
    expect(findings).toEqual([]);
    return;
  }
  expect(findings).toEqual([
    {
      file: "page.md",
      line: 3,
      message: `paragraph of ${reportedWords} words; the cap is 70. Split it, or turn its facts into bullets, a table, or numbered steps`,
    },
  ]);
});

const table = (...rows: string[][]) =>
  ["| a | b |", "| --- | --- |", ...rows.map((cells) => `| ${cells.join(" | ")} |`)].join("\n");
const cell = (line: number, count: number) => ({
  file: "page.md",
  line,
  message: `table cell of ${count} words; the cap is 15. Move the explanation below the table`,
});
const paragraph = (line: number, count: number) => ({
  file: "page.md",
  line,
  message: `paragraph of ${count} words; the cap is 70. Split it, or turn its facts into bullets, a table, or numbered steps`,
});

const tableCases: [name: string, body: string, findings: ReturnType<typeof cell>[]][] = [
  ["a cell at the cap is clean", table([words(15), "x"]), []],
  [
    "a cell over the cap is reported on its row's line",
    table(["x", "y"], [words(16), "x"]),
    [cell(6, 16)],
  ],
  [
    "two rows that open alike are each reported on their own line",
    table([`same ${words(15)}`, "x"], [`same ${words(17)}`, "y"]),
    [cell(5, 16), cell(6, 18)],
  ],
  [
    "a paragraph after the table keeps its own cap",
    `${table([words(15), "x"])}\n\n${words(70)}`,
    [],
  ],
  [
    "a cell opening with a link plus a suffix lands on its row, not the separator",
    table([`[maxims](https://example.com)-owned ${words(15)}`, "x"]),
    [cell(5, 16)],
  ],
  [
    "an empty header anchors nothing, and the body row still lands on its own line",
    `| | |\n| :--- | ---: |\n| [maxims](https://example.com)-owned ${words(15)} | x |`,
    [cell(5, 16)],
  ],
  [
    "a body row that looks like a separator is not skipped, so the next paragraph keeps its line",
    `${table(["---", "---"])}\n\n${words(71)}`,
    [paragraph(7, 71)],
  ],
  [
    "a table inside a blockquote skips its separator too",
    `> | a | b |\n> | --- | --- |\n> | [maxims](https://example.com)-owned ${words(15)} | x |`,
    [cell(5, 16)],
  ],
  [
    "a header-only table steps past its separator, so the next table's header keeps its line",
    `${table()}\n\n| [maxims](https://example.com)-owned ${words(15)} | x |\n| --- | --- |`,
    [cell(6, 16)],
  ],
  [
    "a cell no probe matches never borrows the next row's line, even when that row repeats it",
    table(
      [`[GitHub](https://github.com)-hosted ${words(15)}`, "yes"],
      [`GitHub-hosted ${words(15)}`, "yes"],
    ),
    [cell(5, 16), cell(6, 16)],
  ],
  [
    "a header no probe matches is reported on its own line, not on a body row that repeats its words",
    `| [GitHub](https://github.com)-hosted ${words(15)} | |\n| --- | --- |\n| GitHub-hosted ${words(5)} | |`,
    [cell(3, 16)],
  ],
  [
    "the cursor steps past the last row, so a paragraph repeating that row's opening words keeps its line",
    `${table([`same words ${words(13)}`, "x"])}\n\nsame words ${words(69)}`,
    [paragraph(7, 71)],
  ],
];

test.each(tableCases)("%s", (_name, body, expected) => {
  expect(probePage(page(body), "page.md", options)).toEqual(expected);
});

// A block the stream omits still occupies source lines; a table it quotes must not be where the
// next real table's header is found.
const quoted = "| demo | sample |\n| --- | --- |";
const skippedCases: [name: string, skipped: string, bodyLine: number][] = [
  ["a fenced code block", `\`\`\`md\n${quoted}\n\`\`\``, 10],
  ["an HTML block", `<div>\n${quoted}\n</div>`, 10],
  ["an indented code block", quoted.replace(/^/gm, "    "), 8],
  [
    "a generated region",
    `<!-- BEGIN GENERATED: x -->\n\n${quoted}\n\n<!-- END GENERATED: x -->`,
    12,
  ],
  ["a fenced code block whose lines have no letters", "```md\n| | |\n| --- | --- |\n```", 10],
  [
    "a fenced code block whose info string repeats a line",
    "```md\n| | |\n| --- | --- |\nmd\n```",
    11,
  ],
  ["a code block opening a list item", `-     | demo | sample |\n      | --- | --- |`, 8],
];

test.each(skippedCases)(
  "a table after %s quoting a table lands on its own lines",
  (_name, skipped, bodyLine) => {
    const body = `${skipped}\n\n${table([words(16), "ok"])}`;
    expect(probePage(page(body), "page.md", options)).toEqual([cell(bodyLine, 16)]);
  },
);

// A list item's inner stream holds nested blocks and the item's own text in source order, and
// the cursor walks it in that order: a block before the item's text, or between two runs of it,
// passes under the cursor at its place. The pages carry no title so the expected lines are the
// source lines the reader counts; a link's line is pinned too, since a link whose label shows
// nothing is located from where its segment sits, not from where the item's blocks left the cursor.
const itemCases: [name: string, text: string, placed: string[]][] = [
  [
    "a fence opening a list item quotes the paragraph after the item, as a list item of its own",
    "- ```\n  - foo\n  bar\n  baz\n  ```\n  after\n\nfoo\n\n| h |\n| --- |\n| 1 |\n",
    ["item@6", "paragraph@8", "cell@10", "cell@12"],
  ],
  [
    "a fence opening a list item quotes the paragraph after the item",
    "- ```\n  foo\n  ```\n  trailing text\n\nfoo\n",
    ["item@4", "paragraph@6"],
  ],
  [
    "an item's text after its fence is passed before the paragraph repeating it is located",
    "- first two words\n  ```\n  code words\n  ```\n  last words\n\nlast words\n",
    ["item@1", "paragraph@7"],
  ],
  [
    "an item's text after its fence is passed whole, so a paragraph quoting the fence keeps its line",
    "- first two words\n  ```\n  code words\n  ```\n  last words\n  extra words\n  more words\n\ncode words\n",
    ["item@1", "paragraph@9"],
  ],
  [
    "a link whose label shows nothing is located where it sits, ahead of the fence that follows it",
    "- [<br>](./missing.md)\n  ```\n  code words\n  ```\n\nafter words\n",
    ["paragraph@6", "link@1"],
  ],
  [
    "a link whose label shows nothing still passes its line, so a fence quoting it cannot match there",
    "- [<br>](./missing.md)\n  ```\n  [<br>](./missing.md)\n  alpha beta\n  ```\n\nalpha beta\n",
    ["paragraph@7", "link@1"],
  ],
  [
    "tags before an item's words hold their own lines, so only the words' lines pass under the cursor",
    "- <span></span>\n  <span></span>\n  alpha beta\n  ```\n  alpha beta\n  ```\n\nalpha beta\n",
    ["item@3", "paragraph@8"],
  ],
  [
    "an item that is only a tag still passes its line, so a fence quoting it cannot match there",
    "- <span></span>\n  ```\n  <span></span>\n  alpha beta\n  ```\n\nalpha beta\n",
    ["paragraph@7"],
  ],
  [
    "every badge line of an item passes under the cursor, so a fence quoting the last one cannot match there",
    "- [![Build](build.svg)](https://example.com/build)\n  [![Test](test.svg)](https://example.com/test)\n  ```md\n  [![Test](test.svg)](https://example.com/test)\n  alpha beta\n  ```\n\nalpha beta\n",
    ["paragraph@8", "link@1", "link@2"],
  ],
  [
    "an item with words is bounded by its words, not by a wrapped code span found again in a later fence",
    "- Run `echo\n  hello`.\n  > This prints a greeting.\n  ```sh\n  echo hello\n  ```\n\nAll done now.\n",
    ["item@1", "paragraph@3", "paragraph@8"],
  ],
  [
    "an item that is only a blank code span anchors nothing, so the quote after it keeps its line",
    "- ` `\n  > Copy a space between arguments.\n\nAll done.\n",
    ["paragraph@2", "paragraph@4"],
  ],
  [
    "an item's text after its fence opening with a link plus a suffix is found on its own line",
    "- Start here.\n  ```sh\n  echo hello\n  ```\n  [GitHub](https://github.com)-hosted workflows run here.\n  > Read the warning.\n\nGitHub-hosted workflows are supported.\n",
    ["item@1", "paragraph@6", "paragraph@8", "link@5"],
  ],
  [
    "a link whose destination holds parentheses is still removed whole when its suffix is searched for",
    "- ```sh\n  cargo build\n  ```\n  [Rust](https://en.wikipedia.org/wiki/Rust_(programming_language)#History)-based tools work here.\n",
    ["item@4", "link@4"],
  ],
];

test.each(itemCases)("%s", (_name, text, placed) => {
  const scan = scanPage(text);
  expect([
    ...scan.units.map((unit) => `${unit.kind}@${unit.line}`),
    ...scan.links.map((link) => `link@${link.line}`),
  ]).toEqual(placed);
});
