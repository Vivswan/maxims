// Fails if an unclosed fence runs to the page's last line again instead of ending where micromark
// ends it: a `~~~mermaid` opener left open inside a block quote would hide every region marker
// after the quote, so `regionBounds` would find no region for `docs:tables` to splice.
//
// Also fails if a fence left open at the end of the page stops hiding the lines after it.

import { expect, test } from "bun:test";
import { type Fence, readPage } from "../../scripts/lib/page.ts";

const unclosed: [where: string, markdown: string, text: (string | undefined)[], fence: Fence][] = [
  [
    "inside a block quote ends with the quote, so the heading after it is page text",
    "> ~~~mermaid\n> graph TD\n# Next\n\nAfter the quote.\n",
    [undefined, undefined, "# Next", "", "After the quote.", ""],
    { line: 0, end: 1, mermaid: true, body: "graph TD" },
  ],
  [
    "at the end of the page ends on the page's last line, loses exactly one final line ending from its body, and hides every line after its opener",
    "# Top\n\n```mermaid\ngraph TD\n# Not a heading\n",
    ["# Top", "", undefined, undefined, undefined, undefined],
    { line: 2, end: 5, mermaid: true, body: "graph TD\n# Not a heading" },
  ],
];

test.each(unclosed)("an unclosed fence %s", (_where, markdown, text, fence) => {
  const page = readPage(markdown);
  expect({ text: page.text, fences: page.fences }).toEqual({ text, fences: [fence] });
});

const vendor: [where: string, markdown: string, fences: Fence[], text: (string | undefined)[]][] = [
  [
    "a bare fence quotes text",
    "```\nx\n```\n",
    [{ line: 0, end: 2, mermaid: false, body: "x" }],
    [undefined, undefined, undefined, ""],
  ],
  [
    "an info string with spaces is judged whole",
    "```  mermaid   title here \nx\n```\n",
    [{ line: 0, end: 2, mermaid: false, body: "x" }],
    [undefined, undefined, undefined, ""],
  ],
  [
    "an unclosed fence loses only a final line ending the page has: with none, the body stays whole and the fence ends on the page's last line",
    "```\na\nb",
    [{ line: 0, end: 2, mermaid: false, body: "a\nb" }],
    [undefined, undefined, undefined],
  ],
  [
    "indented code is page text, not a fence",
    "Text\n\n    ```js\n    x\n",
    [],
    ["Text", "", "    ```js", "    x", ""],
  ],
  [
    "a CRLF page's body is joined with LF, as nodeLabels splits it",
    "```mermaid\r\ngraph TD\r\nA --> B\r\n```\r\n",
    [{ line: 0, end: 3, mermaid: true, body: "graph TD\nA --> B" }],
    [undefined, undefined, undefined, undefined, ""],
  ],
  [
    "one leading BOM shifts no position: the fence after it is found and the heading after that is page text",
    "\uFEFF```mermaid\ngraph TD\n```\n# Next\n",
    [{ line: 0, end: 2, mermaid: true, body: "graph TD" }],
    [undefined, undefined, undefined, "# Next", ""],
  ],
  [
    "a second BOM is page text, so the lines and the parse skip the same one",
    "\uFEFF\uFEFF```\nx\n```\n",
    [{ line: 2, end: 3, mermaid: false, body: "" }],
    ["\uFEFF```", "x", undefined, undefined],
  ],
  [
    "a quoted fence with mixed line endings keeps its blank line",
    "> ```mermaid\n> graph TD\r>\n> A --> B\n> ```",
    [{ line: 0, end: 4, mermaid: true, body: "graph TD\n\nA --> B" }],
    [undefined, undefined, undefined, undefined, undefined],
  ],
];

// mdast-util-from-markdown behaviours the fences lean on and nothing here enforces.
//   `lang` and `meta` rejoined -> the info string whole
//   an unclosed fence          -> ends with its container or the page
//   the body                   -> loses exactly one final line ending
//   indented code              -> the same node type
//   a node's value             -> keeps the page's line endings
//   one leading BOM            -> shifts every position by one
test.each(vendor)("%s", (_where, markdown, fences, text) => {
  const page = readPage(markdown);
  expect({ fences: page.fences, text: page.text }).toEqual({ fences, text });
});
