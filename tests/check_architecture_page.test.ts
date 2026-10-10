// Fails if an unclosed fence runs to the page's last line again instead of ending where micromark
// ends it: a `~~~mermaid` opener left open inside a block quote would hide every heading, region
// marker, and demonstration line after the quote, so the page test would read a page with no
// headings.
//
// Also fails if a fence left open at the end of the page stops hiding the lines after it or stops
// counting as a mermaid diagram.

import { expect, test } from "bun:test";
import { type Fence, mermaidFences, readPage } from "../scripts/lib/page.ts";

const unclosed: [where: string, markdown: string, text: (string | undefined)[], fence: Fence][] = [
  [
    "inside a block quote ends with the quote, so the heading after it is page text",
    "> ~~~mermaid\n> graph TD\n# Next\n\nAfter the quote.\n",
    [undefined, undefined, "# Next", "", "After the quote.", ""],
    { line: 0, end: 1, mermaid: true, body: "graph TD" },
  ],
  [
    "at the end of the page hides every line after its opener",
    "# Top\n\n```mermaid\ngraph TD\n# Not a heading\n",
    ["# Top", "", undefined, undefined, undefined, undefined],
    { line: 2, end: 5, mermaid: true, body: "graph TD\n# Not a heading\n" },
  ],
];

test.each(unclosed)("an unclosed fence %s", (_where, markdown, text, fence) => {
  const page = readPage(markdown);
  expect({ text: page.text, fences: page.fences, mermaid: mermaidFences(markdown) }).toEqual({
    text,
    fences: [fence],
    mermaid: [fence],
  });
});
