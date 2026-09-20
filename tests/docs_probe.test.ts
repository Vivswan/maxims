// Fails if the docs probe stops counting a `<placeholder>` inside a code span as a word: the
// inline-HTML strip would then eat it, a 71-word paragraph would pass the 70-word cap, and the
// docs:check gate would stay green on a page that is over it. Also fails if the locator stops
// placing a table's rows on consecutive lines under its header, or starts searching for a cell's
// text: a cell, or the paragraph after the table, would then be reported on the wrong line.
import { expect, test } from "bun:test";
import { DEFAULT_MAX_CELL_WORDS, DEFAULT_MAX_WORDS, probePage } from "../scripts/docs_probe.mts";

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
];

test.each(tableCases)("%s", (_name, body, expected) => {
  expect(probePage(page(body), "page.md", options)).toEqual(expected);
});
