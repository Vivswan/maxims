import { parse, preprocess } from "micromark";
import { subtokenize } from "micromark-util-subtokenize";
import type { Event, Token } from "micromark-util-types";

// "comment" is the line that starts an HTML comment block (a one-line comment is only that line);
// "comment-continuation" is every later line of one that spans several. "fenced" is every line of
// a fenced code block, its fences included; "html" is a line of any other raw HTML block. A line
// inside a blockquote is "text" whatever the quote holds: only a comment's own starting line can be
// a marker, and one behind a quote marker or swallowed by an earlier open block is not.
export type MarkdownLine = {
  text: string;
  start: number;
  end: number;
  kind: "text" | "fenced" | "comment" | "comment-continuation" | "html";
};

// What an append writes, and at which column, to end the fence or raw HTML block the file leaves
// open at its end. A closer written at the column of the fence's own opener, or at the content
// column of the list item holding a raw HTML block, stays inside the item: at column 0 it would end
// the item and open a new block that swallows what follows.
export type OpenLeaf = { column: number; closer: string };

export type ScannedDocument = { lines: MarkdownLine[]; open: OpenLeaf | null };

const LINE_ENDING = /\r\n|\r|\n/g;
const BLANK_TAIL = /^[ \t\r\n]*$/;
const BOM = "\uFEFF";

// CommonMark's raw HTML block kinds 1 to 5 end on the line holding their end string; kinds 6 and 7
// end at a blank line, which an append writes anyway. The kind is read off the block's first line,
// as the specification orders its start conditions.
const RAW_TAG_OPEN = /^<(pre|script|style|textarea)(?=[ \t>]|$)/i;
const RAW_TAG_END = /<\/(pre|script|style|textarea)>/i;
const DELIMITED_KINDS: { open: RegExp; end: RegExp; closer: string }[] = [
  { open: /^<!--/, end: /-->/, closer: "-->" },
  { open: /^<\?/, end: /\?>/, closer: "?>" },
  { open: /^<!\[CDATA\[/, end: /\]\]>/, closer: "]]>" },
  { open: /^<![A-Za-z]/, end: />/, closer: ">" },
];

// `column` is the content column of the innermost list item holding the leaf, 0 outside any item.
type Leaf =
  | { kind: "fence"; token: Token; sequence: Token | null; fences: number; quoted: boolean }
  | { kind: "html"; token: Token; column: number; quoted: boolean };

// micromark drops a leading byte order mark and counts offsets from the character after it; the
// mark stays outside every line and every block's span here too.
export function scanDocument(fileText: string): ScannedDocument {
  const bom = fileText.startsWith(BOM) ? BOM.length : 0;
  const lines = splitLines(fileText, bom);
  const events = flowEvents(fileText);
  let leaf: Leaf | null = null;
  let quoteDepth = 0;
  let lineIndex = 0;
  const itemColumns: number[] = [];
  for (const [step, token] of events) {
    if (token.type === "blockQuote") {
      quoteDepth += step === "enter" ? 1 : -1;
      continue;
    }
    if (token.type === "listOrdered" || token.type === "listUnordered") {
      if (step === "enter") itemColumns.push(0);
      else itemColumns.pop();
      continue;
    }
    if (step !== "enter") continue;
    if (token.type === "listItemMarker") {
      itemColumns[itemColumns.length - 1] = contentColumn(lines, token.end.offset + bom);
    } else if (token.type === "codeFenced" || token.type === "htmlFlow") {
      const quoted = quoteDepth > 0;
      const column = itemColumns[itemColumns.length - 1] ?? 0;
      leaf =
        token.type === "codeFenced"
          ? { kind: "fence", token, sequence: null, fences: 0, quoted }
          : { kind: "html", token, column, quoted };
      if (quoted) continue;
      lineIndex = markLines(lines, lineIndex, token, bom, leaf.kind);
    } else if (leaf?.kind === "fence" && token.type === "codeFencedFence") {
      leaf.fences += 1;
    } else if (leaf?.kind === "fence" && token.type === "codeFencedFenceSequence") {
      leaf.sequence ??= token;
    }
  }
  return { lines, open: openLeaf(fileText, lines, leaf, bom) };
}

// The document tokenizer yields containers around flow chunks; one subtokenize pass turns the
// chunks into the flow blocks read here. A second pass would tokenize inline text, which nothing
// here reads and which costs as much again.
function flowEvents(fileText: string): Event[] {
  const events = parse()
    .document()
    .write(preprocess()(fileText, undefined, true));
  subtokenize(events);
  return events;
}

function splitLines(fileText: string, from: number): MarkdownLine[] {
  const lines: MarkdownLine[] = [];
  let start = from;
  while (start < fileText.length) {
    LINE_ENDING.lastIndex = start;
    const ending = LINE_ENDING.exec(fileText);
    const textEnd = ending === null ? fileText.length : ending.index;
    const end = ending === null ? fileText.length : ending.index + ending[0].length;
    lines.push({ text: fileText.slice(start, textEnd), start, end, kind: "text" });
    start = end;
  }
  return lines;
}

// Leaf blocks never share a line and come in document order, so the lines a token covers are the
// run from the first line reaching its start to the last line starting before its end.
function markLines(
  lines: MarkdownLine[],
  from: number,
  token: Token,
  bom: number,
  kind: "fence" | "html",
): number {
  const start = token.start.offset + bom;
  const end = token.end.offset + bom;
  let index = from;
  while (index < lines.length && lines[index].end <= start) index += 1;
  const first = index;
  const opening = lines[first].text.slice(start - lines[first].start).replace(/^[ \t]+/, "");
  const comment = kind === "html" && opening.startsWith("<!--");
  while (index < lines.length && lines[index].start < end) {
    lines[index].kind =
      kind === "fence"
        ? "fenced"
        : !comment
          ? "html"
          : index === first
            ? "comment"
            : "comment-continuation";
    index += 1;
  }
  return index;
}

// A leaf is open when nothing but blank lines follows it: a fence that never met its closing
// fence, or a delimited HTML block whose last line lacks its end string. A leaf inside a
// blockquote is never open, since the blank line before an appended block ends the quote and
// everything in it. Trailing blank lines count as inside the leaf, as CommonMark reads them,
// where micromark ends a list's last leaf before the blank lines that follow the list. A fence
// closes at its opener's column, keeping the fence's own indentation; an HTML closer sits at the
// item's content column, since indentation past it would land inside the raw HTML.
function openLeaf(
  fileText: string,
  lines: MarkdownLine[],
  leaf: Leaf | null,
  bom: number,
): OpenLeaf | null {
  if (leaf === null || leaf.quoted) return null;
  if (!BLANK_TAIL.test(fileText.slice(leaf.token.end.offset + bom))) return null;
  if (leaf.kind === "fence") {
    if (leaf.fences !== 1 || leaf.sequence === null) return null;
    const start = leaf.sequence.start.offset + bom;
    return {
      column: columnAt(lines, start),
      closer: fileText.slice(start, leaf.sequence.end.offset + bom),
    };
  }
  const start = leaf.token.start.offset + bom;
  const first = lineAt(lines, start);
  const opening = first.text.slice(start - first.start).replace(/^[ \t]+/, "");
  const delimited = delimitedKind(opening);
  if (delimited === null) return null;
  const last = lineAt(lines, leaf.token.end.offset + bom - 1);
  if (delimited.end.test(last.text)) return null;
  return { column: leaf.column, closer: delimited.closer };
}

function delimitedKind(opening: string): { end: RegExp; closer: string } | null {
  const raw = RAW_TAG_OPEN.exec(opening);
  if (raw !== null) return { end: RAW_TAG_END, closer: `</${raw[1].toLowerCase()}>` };
  return DELIMITED_KINDS.find((kind) => kind.open.test(opening)) ?? null;
}

function lineAt(lines: MarkdownLine[], offset: number): MarkdownLine {
  let low = 0;
  let high = lines.length - 1;
  while (low < high) {
    const middle = (low + high + 1) >>> 1;
    if (lines[middle].start <= offset) low = middle;
    else high = middle - 1;
  }
  return lines[low];
}

// The column the character at `offset` sits at, with a tab reaching the next multiple of four as
// CommonMark reads it; micromark's own columns count characters, so a tab-padded item would
// misplace a closer.
function columnAt(lines: MarkdownLine[], offset: number): number {
  const line = lineAt(lines, offset);
  return advance(line.text, 0, 0, offset - line.start).column;
}

// The content column of a list item whose marker ends at `markerEnd` (CommonMark 5.2): one to
// four columns of whitespace after the marker put the content after them; five or more (indented
// code), or nothing but whitespace (an item starting with a blank line), put it one column past
// the marker. micromark's prefix token ends at a character, so it cannot say how much of a tab
// the marker's padding took.
function contentColumn(lines: MarkdownLine[], markerEnd: number): number {
  const line = lineAt(lines, markerEnd);
  const marker = advance(line.text, 0, 0, markerEnd - line.start);
  const padded = advance(line.text, marker.index, marker.column, line.text.length, true);
  const padding = padded.column - marker.column;
  const blank = padded.index === line.text.length;
  return marker.column + (blank || padding === 0 || padding > 4 ? 1 : padding);
}

function advance(
  text: string,
  index: number,
  column: number,
  until: number,
  whitespaceOnly = false,
): { index: number; column: number } {
  let i = index;
  let col = column;
  while (i < until) {
    const char = text[i];
    if (whitespaceOnly && char !== " " && char !== "\t") break;
    col += char === "\t" ? 4 - (col % 4) : 1;
    i += 1;
  }
  return { index: i, column: col };
}
