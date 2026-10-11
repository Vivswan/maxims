import { fromMarkdown } from "mdast-util-from-markdown";
import { visit } from "unist-util-visit";

export interface Fence {
  /** Zero-based line of the opening fence. */
  line: number;
  /** Zero-based line of the closing fence, or the last line of a fence that never closes: the end of the block quote or list item holding it, or of the page. */
  end: number;
  /** The info string names mermaid; other fences are text the page quotes. */
  mermaid: boolean;
  /** The lines between the fences, without the final line ending whether or not the fence closed. */
  body: string;
}

const MERMAID_INFO = /^\s*mermaid\s*$/;

/**
 * The opener's text after the marker is judged whole: "mermaid title" quotes a diagram, it is not
 * one. Indented code arrives as the same `code` node and stays page text: its position starts at
 * the indentation, a fence's at its marker.
 */
function fences(markdown: string, lines: readonly string[]): Fence[] {
  const found: Fence[] = [];
  visit(fromMarkdown(markdown), "code", (node) => {
    if (node.position === undefined)
      throw new Error("mdast-util-from-markdown positions every node");
    const { start, end } = node.position;
    const marker = lines[start.line - 1]?.charAt(start.column - 1);
    if (marker !== "`" && marker !== "~") return;
    const info = [node.lang, node.meta].filter((part) => typeof part === "string").join(" ");
    found.push({
      line: start.line - 1,
      end: end.line - 1,
      mermaid: MERMAID_INFO.test(info),
      body: node.value,
    });
  });
  return found;
}

/** The live mermaid diagrams of `markdown`. */
export function mermaidFences(markdown: string): Fence[] {
  return readPage(markdown).fences.filter((fence) => fence.mermaid);
}

export interface Page {
  lines: readonly string[];
  fences: readonly Fence[];
  /**
   * `lines[i]` when line i is page text, undefined inside any fence: headings, region markers, and
   * demonstration lines are read from here only, so a quoted example never steers the walk.
   */
  text: ReadonlyArray<string | undefined>;
}

export function readPage(markdown: string): Page {
  // micromark reads LF, CRLF, and a lone CR alike, and a node's value keeps the page's own
  // endings: normalizing before the parse keeps a CR beside an LF across a stripped `> ` prefix
  // from merging into one CRLF. micromark also skips one leading BOM and counts every position
  // from the next character.
  const source = markdown.replace(/\r\n?/g, "\n");
  const lines = (source.startsWith("\uFEFF") ? source.slice(1) : source).split("\n");
  const all = fences(source, lines);
  const text = lines.map((line, index) =>
    all.some((fence) => index >= fence.line && index <= fence.end) ? undefined : line,
  );
  return { lines, fences: all, text };
}
