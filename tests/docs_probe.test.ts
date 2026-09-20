// Fails if the docs probe stops counting a `<placeholder>` inside a code span as a word: the
// inline-HTML strip would then eat it, a 71-word paragraph would pass the 70-word cap, and the
// docs:check gate would stay green on a page that is over it.
import { expect, test } from "bun:test";
import { DEFAULT_MAX_WORDS, probePage } from "../scripts/docs_probe.mts";

const words = (count: number) => Array.from({ length: count }, (_, i) => `word${i}`).join(" ");
const page = (paragraph: string) => `# Title\n\n${paragraph}\n`;

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
  const findings = probePage(page(paragraph), "page.md", {
    root: "/",
    maxWords: DEFAULT_MAX_WORDS,
    paths: false,
  });
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
