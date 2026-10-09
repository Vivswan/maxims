// Fails if an unclosed fence runs to the page's last line again instead of ending where micromark
// ends it: a `~~~mermaid` opener left open inside a block quote would hide every heading, region
// marker, and demonstration line after the quote, so the page test would read a page with no
// headings. Also fails if a fence left open at the end of the page stops hiding the lines after
// it.

import { expect, test } from "bun:test";
import { mermaidFences, readPage } from "../scripts/check_architecture_page.mts";

test("an unclosed fence inside a block quote ends with the quote, so the heading after it is page text", () => {
  const page = readPage("> ~~~mermaid\n> graph TD\n# Next\n\nAfter the quote.\n");
  expect(page.text).toEqual([undefined, undefined, "# Next", "", "After the quote.", ""]);
  expect(page.fences).toEqual([{ line: 0, end: 1, mermaid: true, body: "graph TD" }]);
  expect(mermaidFences("> ~~~mermaid\n> graph TD\n# Next\n")).toHaveLength(1);
});

test("an unclosed fence at the end of the page hides every line after its opener", () => {
  const markdown = "# Top\n\n```mermaid\ngraph TD\n# Not a heading\n";
  const page = readPage(markdown);
  expect(page.text.slice(0, 2)).toEqual(["# Top", ""]);
  expect(page.text.slice(2)).toEqual(page.text.slice(2).map(() => undefined));
  expect(mermaidFences(markdown)).toHaveLength(1);
});
