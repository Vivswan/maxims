import type { BlockInput, ExpansionSyntax, RuleLine, Staleness } from "./types.ts";

const DESCRIPTION_MAX_CHARS = 300;
const ELLIPSIS = "...";

// dotAll: a local-source path may carry U+2028 or U+2029, which `.` alone would refuse.
const BEGIN_LINE = /^<!-- maxims:begin (.+) sha=(\S+) -->$/s;
const END_LINE = /^<!-- maxims:end (.+) -->$/s;
const SELF_REFRESH_LINE =
  "- If the staleness line above is present, run `maxims sync --quiet` before continuing.";

const STALE_REASON: Record<Staleness["kind"], string> = {
  age: "no successful fetch",
  network: "network unreachable",
  ratelimit: "rate limited",
  missing: "source repository gone or unreadable, they will never refresh",
  auth: "authentication failed",
  invalid: "source content invalid",
};

export function renderBlock(input: BlockInput): string {
  const { source, sha, expands } = input;
  assertMarkerField("source", source);
  assertMarkerField("sha", sha);
  const lines = [`<!-- maxims:begin ${source} sha=${sha} -->`];
  if (input.markers === "stripped") {
    lines.push(
      `<!-- managed by maxims: ${source} - edits will be overwritten -->`,
      `<!-- update: npx maxims add ${source} | remove: npx maxims remove ${source} -->`,
    );
  }
  if (input.stale !== undefined) {
    const notice = `maxims: the rules below from ${source} have not refreshed since ${input.stale.since} (${STALE_REASON[input.stale.kind]}) and may be out of date.`;
    lines.push(`- ${escapeText(notice, expands)}`);
    if (input.selfRefresh) lines.push(SELF_REFRESH_LINE);
  }
  for (const line of input.lines) lines.push(renderRuleLine(line, expands));
  lines.push(`<!-- maxims:end ${source} -->`);
  const block = `${lines.join("\n")}\n`;
  return input.frontmatter === undefined ? block : withNewline(input.frontmatter) + block;
}

// A source or sha that could break or end its own marker has no valid rendering; both come from
// state, whose schema is the place to refuse them, so this is an invariant check, not an error path.
function assertMarkerField(field: string, value: string): void {
  if (value === "" || value.trim() !== value || /[\r\n]/.test(value) || value.includes("-->")) {
    throw new Error(`${field} ${JSON.stringify(value)} cannot sit inside a managed-block marker`);
  }
  if (field === "sha" && /\s/.test(value)) {
    throw new Error(`sha ${JSON.stringify(value)} must be a single token`);
  }
}

function renderRuleLine(line: RuleLine, expands: readonly ExpansionSyntax[]): string {
  const description = truncate(oneLine(line.description));
  const body = `${description} (detail: ${oneLine(line.detailPath)}, ${line.shortHash})`;
  return `- ${escapeText(body, expands)}`;
}

function oneLine(text: string): string {
  return text.replace(/\r\n|\r|\n/g, " ");
}

function truncate(text: string): string {
  const points = Array.from(text);
  if (points.length <= DESCRIPTION_MAX_CHARS) return text;
  return points.slice(0, DESCRIPTION_MAX_CHARS - ELLIPSIS.length).join("") + ELLIPSIS;
}

function escapeText(text: string, expands: readonly ExpansionSyntax[]): string {
  const commentSafe = text.replaceAll("-->", "--&gt;").replaceAll("<!--", "&lt;!--");
  return escapeReferences(commentSafe, expands);
}

// A reference token is wrapped in a code span, which every documented import parser skips. Every
// whitespace-split token holding `@` (or `#name:`) anywhere is one: an import walker matches a
// bare `@` at the start of a lexed text token, and which inline constructs (emphasis, a link label,
// an escape, an email autolink, an inline tag) start a fresh one differs by parser, so the rule
// models none of them. So that every parser agrees where each span is, a line carrying such a
// token first loses everything that could pair with, escape or swallow one of its fences: existing
// backticks, backslashes, `<`, `[` and any `~~~` run become entities (a leading `~~~` would
// otherwise turn the whole rule into a fence's info string). The fences are then the only
// backticks in the line, each glued to its token with no escape or link syntax left to reach
// across them, so a construct that steals an opener swallows the token with it and none can leave
// it exposed.
const AT_REFERENCE = /@/;
const HASH_REFERENCE = /#[A-Za-z]+:/;

function escapeReferences(text: string, expands: readonly ExpansionSyntax[]): string {
  const wrapAt = expands.length === 0 || expands.includes("at-import");
  const wrapHash = expands.length === 0;
  const isReference = (token: string): boolean =>
    (wrapAt && AT_REFERENCE.test(token)) || (wrapHash && HASH_REFERENCE.test(token));
  if (!text.split(/\s+/).some(isReference)) return text;
  return text
    .replaceAll("\\", "&#92;")
    .replaceAll("`", "&#96;")
    .replaceAll("<", "&lt;")
    .replaceAll("[", "&#91;")
    .replace(/~{3,}/g, (run) => "&#126;".repeat(run.length))
    .split(/(\s+)/)
    .map((token) => (isReference(token) ? `\`${token}\`` : token))
    .join("");
}

function withNewline(text: string): string {
  return text.endsWith("\n") ? text : `${text}\n`;
}

// "comment" is the line that starts an HTML comment block (a one-line comment is only that line);
// "comment-continuation" is every later line of one that spans several. "html" is a line of any
// other raw HTML block, whose content a Markdown parser keeps literal. Only a comment's starting
// line can be a marker: one swallowed by an earlier open block is not.
export type MarkdownLine = {
  text: string;
  start: number;
  end: number;
  kind: "text" | "fenced" | "comment" | "comment-continuation" | "html";
};

// An HTML block ends at the first line matching `until`, or at a blank line for the CommonMark
// block-tag kinds (div, details, a lone tag of any other name, ...); `closer` is what an append
// writes to end one left open at EOF, empty when the blank line the append already writes does that.
type OpenBlock =
  | { kind: "fence"; opener: string; indent: number }
  | { kind: "comment" }
  | { kind: "html"; until: RegExp | "blank-line"; closer: string };

// `items` holds the content column of each open list item, outermost first; a non-blank line
// indented short of one ends it unless it lazily continues an open paragraph, and a blank line
// ends an item that was opened with nothing after its marker (`emptyItem`). A leaf lives in the
// innermost item, and a line that ends that item ends the leaf too, so a column-0 marker line can
// sit inside a leaf only while no item is open, and only such a leaf needs a closer when a block is
// appended. A blockquote's content is scanned by a scanner of its own, held in the innermost item
// and dropped whenever `items` changes; `paragraph` then mirrors whether the quote ends in one.
// `definitions` tracks whether the open paragraph holds only link reference definitions so far,
// which decides whether an `===` line under it is a heading underline or new paragraph text.
type Scanner = {
  items: number[];
  leaf: OpenBlock | null;
  quote: Scanner | null;
  paragraph: boolean;
  definitions: Definitions;
  emptyItem: boolean;
};

// What the paragraph's link reference definitions still await. "complete" and "title" (a title
// may still follow) leave a following `===` as text; every other state lets it underline a
// heading, since CommonMark parses definitions off the front of a paragraph only when it closes
// and an unfinished one then fails: "destination" (a label with nothing after it), "label" and
// "label-blank" (a label still open across lines, with or without text so far), the three
// "quoted-" states (a title still open across lines), and "none" (the paragraph holds prose).
type Definitions =
  | "none"
  | "complete"
  | "destination"
  | "title"
  | "label"
  | "label-blank"
  | "quoted-double"
  | "quoted-single"
  | "quoted-paren";

function newScanner(): Scanner {
  return {
    items: [],
    leaf: null,
    quote: null,
    paragraph: false,
    definitions: "none",
    emptyItem: false,
  };
}

// A line's text past some column: the columns of whitespace still leading it, the text from its
// first non-whitespace character on, and the physical column that character sits at (which fixes
// the tab stops of whatever follows). Slicing there copies nothing, so a line of thousands of `>`
// or list markers costs one pass over its whitespace however deep it nests.
type Content = { indent: number; body: string; column: number };

// A block may open behind up to three spaces, as CommonMark allows, and a marker inside one is
// then quoted text. Whitespace in these rules is CommonMark's space and tab, never other Unicode
// whitespace; an info string may hold any character (dotAll). A declaration starts with an
// uppercase letter, as Bun's parser and CommonMark 0.29 require. Each rule reads a `Content`
// body, so none carries the leading indentation itself.
const FENCE_OPEN = /^(`{3,}|~{3,})(.*)$/s;
const FENCE_CLOSE = /^(`{3,}|~{3,})[ \t]*$/;
const COMMENT_OPEN = /^<!--/;
const LITERAL_TAG_OPEN = /^<(pre|script|style|textarea)(?=[ \t>]|$)/i;
const LITERAL_TAG_END = /<\/(pre|script|style|textarea)>/i;
const INSTRUCTION_OPEN = /^<\?/;
const CDATA_OPEN = /^<!\[CDATA\[/;
const DECLARATION_OPEN = /^<![A-Z]/;
const BLOCK_TAGS = [
  "address|article|aside|base|basefont|blockquote|body|caption|center|col|colgroup|dd|details",
  "dialog|dir|div|dl|dt|fieldset|figcaption|figure|footer|form|frame|frameset|h[1-6]|head|header",
  "hr|html|iframe|legend|li|link|main|menu|menuitem|nav|noframes|ol|optgroup|option|p|param|search",
  "section|summary|table|tbody|td|tfoot|th|thead|title|tr|track|ul",
].join("|");
const BLOCK_TAG_OPEN = new RegExp(`^</?(?:${BLOCK_TAGS})(?=[ \\t>]|/>|$)`, "i");
// A complete open or closing tag of any name alone on its line (CommonMark's seventh HTML block
// kind); unlike the kinds above it cannot interrupt a paragraph. Whitespace inside the tag is `\s`,
// as commonmark.js and markdown-it read it, wider than the specification's space and tab: the
// wider reading only ever hides a marker line inside a raw HTML block, never exposes one.
const TAG_NAME = "[A-Za-z][A-Za-z0-9-]*";
const ATTRIBUTE = `\\s+[A-Za-z_:][A-Za-z0-9_.:-]*(?:\\s*=\\s*(?:[^\\s"'=<>\`]+|'[^']*'|"[^"]*"))?`;
const LONE_TAG_OPEN = new RegExp(
  `^(?:<${TAG_NAME}(?:${ATTRIBUTE})*\\s*/?>|</${TAG_NAME}\\s*>)\\s*$`,
);
const ATX_HEADING = /^#{1,6}(?:[ \t]|$)/;
const SETEXT_UNDERLINE = /^(?:=+|-+)[ \t]*$/;
const LIST_MARKER = /^(?:[-+*]|(\d{1,9})[.)])(?=[ \t]|$)/;
// The pieces of a link reference definition, as commonmark.js and markdown-it read them: a label
// of up to 999 characters, a destination in angle brackets or bare with parentheses balanced two
// deep, and a title in one of three quotings. A backslash in a bare destination escapes only
// ASCII punctuation; a destination refuses ASCII control characters but not the C1 range; a
// label or title left open may end its line in a backslash, which escapes the line ending. Each
// piece is matched one way only, so an unterminated label cannot make a rule backtrack across
// its length.
const ESCAPABLE = String.raw`[!-/:-@[-\x60{-~]`;
const LABEL_CHAR = String.raw`(?:[^[\]\\]|\\.)`;
const DESTINATION_CHAR = String.raw`(?:\\${ESCAPABLE}|\\(?!${ESCAPABLE})|[^ ()\\\p{Cc}]|[\u0080-\u009f])`;
const DESTINATION = String.raw`(?:<(?:[^<>\\]|\\.)*>|(?!<)(?:${DESTINATION_CHAR}|\((?:${DESTINATION_CHAR}|\((?:${DESTINATION_CHAR})*\))*\))+)`;
const TITLE_BODY = {
  "quoted-double": String.raw`(?:[^"\\]|\\.)*`,
  "quoted-single": String.raw`(?:[^'\\]|\\.)*`,
  "quoted-paren": String.raw`(?:[^()\\]|\\.)*`,
} as const;
const TITLE = String.raw`(?:"${TITLE_BODY["quoted-double"]}"|'${TITLE_BODY["quoted-single"]}'|\(${TITLE_BODY["quoted-paren"]}\))`;
const UNTERMINATED_TITLE = String.raw`(?:"${TITLE_BODY["quoted-double"]}|'${TITLE_BODY["quoted-single"]}|\(${TITLE_BODY["quoted-paren"]})\\?$`;
const DEFINITION_START = new RegExp(String.raw`^\[(${LABEL_CHAR}{0,999})\]:([\s\S]*)$`, "u");
const LABEL_OPEN = new RegExp(String.raw`^\[(${LABEL_CHAR}*)\\?$`, "u");
const LABEL_CLOSE = new RegExp(String.raw`^(${LABEL_CHAR}*)\]:([\s\S]*)$`, "u");
const LABEL_CONTINUES = new RegExp(String.raw`^${LABEL_CHAR}*\\?$`, "u");
const DESTINATION_LINE = new RegExp(
  String.raw`^${DESTINATION}(?:[ \t]*$|[ \t]+(${TITLE})[ \t]*$|[ \t]+(${UNTERMINATED_TITLE}))`,
  "u",
);
const TITLE_LINE = new RegExp(String.raw`^${TITLE}[ \t]*$`, "u");
const UNTERMINATED_TITLE_LINE = new RegExp(String.raw`^${UNTERMINATED_TITLE}`, "u");
const TITLE_CLOSES = {
  "quoted-double": new RegExp(String.raw`^${TITLE_BODY["quoted-double"]}"[ \t]*$`, "u"),
  "quoted-single": new RegExp(String.raw`^${TITLE_BODY["quoted-single"]}'[ \t]*$`, "u"),
  "quoted-paren": new RegExp(String.raw`^${TITLE_BODY["quoted-paren"]}\)[ \t]*$`, "u"),
} as const;
const TITLE_CONTINUES = {
  "quoted-double": new RegExp(String.raw`^${TITLE_BODY["quoted-double"]}\\?$`, "u"),
  "quoted-single": new RegExp(String.raw`^${TITLE_BODY["quoted-single"]}\\?$`, "u"),
  "quoted-paren": new RegExp(String.raw`^${TITLE_BODY["quoted-paren"]}\\?$`, "u"),
} as const;
const LINE_ENDING = /\r\n|\r|\n/g;
const LAST_LINE_ENDING = /(\r\n|\r|\n)$/;
const FIRST_LINE_ENDING = /^(\r\n|\r|\n)/;
const BOM = "\uFEFF";

export function markdownLines(fileText: string): MarkdownLine[] {
  return scanLines(fileText).lines;
}

// A leading byte order mark is not part of the first line: Markdown parsers drop it, so the line
// behind it opens a block as if it were at column 0, and the mark stays outside any block's span.
function scanLines(fileText: string): { lines: MarkdownLine[]; open: OpenBlock | null } {
  const lines: MarkdownLine[] = [];
  const scanner = newScanner();
  let start = fileText.startsWith(BOM) ? BOM.length : 0;
  while (start < fileText.length) {
    LINE_ENDING.lastIndex = start;
    const ending = LINE_ENDING.exec(fileText);
    const textEnd = ending === null ? fileText.length : ending.index;
    const end = ending === null ? fileText.length : ending.index + ending[0].length;
    const text = fileText.slice(start, textEnd);
    lines.push({ text, start, end, kind: scanLine(scanner, text) });
    start = end;
  }
  return { lines, open: scanner.items.length === 0 ? scanner.leaf : null };
}

// A level's reading of its part of the line, or the blockquote the rest of the line belongs to.
type Step = MarkdownLine["kind"] | { quote: Scanner; content: Content };

// Each `>` hands the rest of the line to the blockquote's own scanner; the chain is walked as a
// loop rather than by recursion so that a line of thousands of `>` cannot exhaust the stack. On
// the way down a quote learns whether lazy lines kept its paragraph to definitions; on the way
// back each level learns whether its quote still ends in a paragraph. A line that enters a
// blockquote at all is text to the levels above it.
function scanLine(scanner: Scanner, text: string): MarkdownLine["kind"] {
  const tail = breakTail(text);
  const chain = [scanner];
  let content = contentAfter(text, 0, 0);
  let kind: MarkdownLine["kind"] = "text";
  for (;;) {
    const step = scanLevel(chain[chain.length - 1], content, tail);
    if (typeof step === "string") {
      kind = step;
      break;
    }
    step.quote.definitions = chain[chain.length - 1].definitions;
    chain.push(step.quote);
    content = step.content;
  }
  for (let level = chain.length - 2; level >= 0; level -= 1) {
    const quote = chain[level + 1];
    chain[level].paragraph = quote.leaf === null && quote.paragraph;
    chain[level].definitions = quote.definitions;
  }
  return chain.length === 1 ? kind : "text";
}

// A fence or HTML block has no lazy continuation: a non-blank line indented short of the item that
// holds it ends both, and is then read afresh at the level it does reach. A paragraph has one: a
// line indented short of its item that starts no block continues it, and the item stays open.
function scanLevel(scanner: Scanner, content: Content, tail: number): Step {
  const blank = content.body === "";
  if (scanner.leaf !== null) {
    const block = scanner.leaf;
    const column = contentColumn(scanner, scanner.items.length);
    if (blank || content.indent >= column) {
      if (closes(past(content, column), block)) scanner.leaf = null;
      return leafKind(block);
    }
    scanner.leaf = null;
  }
  const emptyItem = scanner.emptyItem;
  scanner.emptyItem = false;
  if (blank) {
    if (emptyItem) scanner.items.pop();
    scanner.quote = null;
    scanner.paragraph = false;
    return "text";
  }
  const depth = itemsReached(scanner.items, content.indent);
  const column = contentColumn(scanner, depth);
  const rest = past(content, column);
  if (depth < scanner.items.length) {
    if (scanner.paragraph && !startsBlock(rest, tail)) {
      scanner.definitions = advanceDefinitions(scanner.definitions, rest);
      return "text";
    }
    scanner.items.length = depth;
    scanner.quote = null;
    scanner.paragraph = false;
  }
  return openBlocks(scanner, rest, column, tail);
}

function leafKind(block: OpenBlock): MarkdownLine["kind"] {
  return block.kind === "fence"
    ? "fenced"
    : block.kind === "comment"
      ? "comment-continuation"
      : "html";
}

// How many of the open items, whose content columns rise outward to inward, a line's indent
// reaches; found by bisection so that a lazy line under deep nesting costs a logarithm, not a walk.
function itemsReached(items: readonly number[], indent: number): number {
  let low = 0;
  let high = items.length;
  while (low < high) {
    const middle = (low + high) >>> 1;
    if (items[middle] <= indent) low = middle + 1;
    else high = middle;
  }
  return low;
}

function contentColumn(scanner: Scanner, depth: number): number {
  return depth === 0 ? 0 : scanner.items[depth - 1];
}

// Reads a line's content, which begins at `column`: a paragraph absorbs any line that cannot
// interrupt it, a setext underline being the one that also ends it unless the paragraph is only
// link reference definitions; a paragraph inside an open blockquote is continued only by a line
// that starts no block at all, and no underline reaches it lazily. A list marker opens an item
// whose content is read again at the item's own column; a `>` then hands the rest to the
// blockquote's scanner (the open one only while no item was opened before it on this line); the
// remaining text opens a leaf, an indented code block, a heading or a paragraph.
function openBlocks(scanner: Scanner, content: Content, column: number, tail: number): Step {
  if (scanner.paragraph && scanner.quote !== null && !startsBlock(content, tail)) {
    scanner.definitions = advanceDefinitions(scanner.definitions, content);
    return "text";
  }
  if (scanner.paragraph && scanner.quote === null && !interruptsParagraph(content, tail)) {
    if (isSetextUnderline(content) && !onlyDefinitions(scanner.definitions)) {
      scanner.paragraph = false;
    }
    scanner.definitions = advanceDefinitions(scanner.definitions, content);
    return "text";
  }
  let quote = scanner.quote;
  scanner.quote = null;
  let rest = content;
  let itemColumn = column;
  for (;;) {
    if (isThematicBreak(rest, tail)) {
      scanner.paragraph = false;
      return "text";
    }
    const item = listItem(rest);
    if (item === null) break;
    itemColumn += item.width;
    scanner.items.push(itemColumn);
    scanner.paragraph = false;
    quote = null;
    rest = item.content;
    if (rest.body === "") {
      scanner.emptyItem = true;
      return "text";
    }
  }
  if (rest.indent <= 3 && rest.body.startsWith(">")) {
    scanner.quote = quote ?? newScanner();
    return { quote: scanner.quote, content: contentAfter(rest.body.slice(1), 1, rest.column + 1) };
  }
  const opened = opens(rest, false);
  if (opened !== null) {
    scanner.paragraph = false;
    if (opened.kind === "fence" || !closes(rest, opened)) scanner.leaf = opened;
    return opened.kind === "fence" ? "fenced" : opened.kind;
  }
  scanner.paragraph = rest.indent < 4 && !isAtxHeading(rest);
  scanner.definitions = advanceDefinitions("complete", rest);
  return "text";
}

// Whether a line's content, read where an item ended, starts a block rather than lazily continuing
// the paragraph: anything but a lone tag, an indented line and plain text. Read inside the
// paragraph's own container the rules are stricter (`interruptsParagraph`): CommonMark also keeps
// an empty item, and an ordered item numbered other than one, as paragraph text there.
function startsBlock(rest: Content, tail: number): boolean {
  if (rest.indent >= 4) return false;
  if (isThematicBreak(rest, tail) || isAtxHeading(rest) || rest.body.startsWith(">")) return true;
  return opens(rest, true) !== null || listItem(rest) !== null;
}

function interruptsParagraph(rest: Content, tail: number): boolean {
  if (rest.indent >= 4) return false;
  if (isThematicBreak(rest, tail) || isAtxHeading(rest) || rest.body.startsWith(">")) return true;
  if (opens(rest, true) !== null) return true;
  const item = listItem(rest);
  return item !== null && item.content.body !== "" && (item.ordered === null || item.ordered === 1);
}

function isAtxHeading(rest: Content): boolean {
  return rest.indent <= 3 && ATX_HEADING.test(rest.body);
}

function isSetextUnderline(rest: Content): boolean {
  return rest.indent <= 3 && SETEXT_UNDERLINE.test(rest.body);
}

function onlyDefinitions(state: Definitions): boolean {
  return state === "complete" || state === "title";
}

// The state after one more paragraph line. A label must hold a non-whitespace character in
// JavaScript's sense, as the reference parsers trim it, and no more than 999 characters as
// written. A NUL reads as U+FFFD, as the parsers replace it before reading. A line that fits
// nowhere turns the paragraph to prose for good, since CommonMark reads definitions only off its
// front.
function advanceDefinitions(state: Definitions, rest: Content): Definitions {
  const body = rest.body.replaceAll("\0", "\uFFFD");
  switch (state) {
    case "none":
      return "none";
    case "complete":
      return startDefinition(body);
    case "destination":
      return readDestination(body);
    case "title": {
      if (TITLE_LINE.test(body)) return "complete";
      const open = UNTERMINATED_TITLE_LINE.exec(body);
      return open === null ? startDefinition(body) : quotedBy(open[0]);
    }
    case "label":
    case "label-blank": {
      const close = LABEL_CLOSE.exec(body);
      if (close !== null) {
        return state === "label" || /\S/.test(close[1]) ? afterLabel(close[2]) : "none";
      }
      if (!LABEL_CONTINUES.test(body)) return "none";
      return state === "label" || /\S/.test(body) ? "label" : "label-blank";
    }
    case "quoted-double":
    case "quoted-single":
    case "quoted-paren":
      if (TITLE_CLOSES[state].test(body)) return "complete";
      return TITLE_CONTINUES[state].test(body) ? state : "none";
  }
}

function startDefinition(body: string): Definitions {
  const start = DEFINITION_START.exec(body);
  if (start !== null) {
    return start[1].length <= 999 && /\S/.test(start[1]) ? afterLabel(start[2]) : "none";
  }
  const open = LABEL_OPEN.exec(body);
  if (open !== null) return /\S/.test(open[1]) ? "label" : "label-blank";
  return "none";
}

function afterLabel(tail: string): Definitions {
  const trimmed = tail.replace(/^[ \t]+/, "");
  return trimmed === "" ? "destination" : readDestination(trimmed);
}

function readDestination(body: string): Definitions {
  const line = DESTINATION_LINE.exec(body);
  if (line === null) return "none";
  if (line[1] !== undefined) return "complete";
  return line[2] === undefined ? "title" : quotedBy(line[2]);
}

function quotedBy(title: string): Definitions {
  return title.startsWith('"')
    ? "quoted-double"
    : title.startsWith("'")
      ? "quoted-single"
      : "quoted-paren";
}

// The length of the line's tail made of one of `-`, `_` or `*` and whitespace holding at least
// three of that character, or 0. Content that lies within it behind at most three spaces is a
// thematic break; measured once per line, so nested list markers and quotes never rescan the line.
function breakTail(text: string): number {
  let end = text.length;
  while (end > 0 && (text[end - 1] === " " || text[end - 1] === "\t")) end -= 1;
  const marker = text[end - 1];
  if (marker !== "-" && marker !== "_" && marker !== "*") return 0;
  let start = end;
  let count = 0;
  while (start > 0) {
    const char = text[start - 1];
    if (char === marker) count += 1;
    else if (char !== " " && char !== "\t") break;
    start -= 1;
  }
  return count >= 3 ? text.length - start : 0;
}

function isThematicBreak(rest: Content, tail: number): boolean {
  return tail > 0 && rest.indent <= 3 && rest.body.length <= tail;
}

// A marker followed by one to four spaces puts the item's content after them; followed by five or
// more, or by nothing, the content starts one column past the marker (indented code, or an empty
// item).
function listItem(
  rest: Content,
): { width: number; content: Content; ordered: number | null } | null {
  if (rest.indent > 3) return null;
  const marker = LIST_MARKER.exec(rest.body);
  if (marker === null) return null;
  const trimmed = contentAfter(
    rest.body.slice(marker[0].length),
    0,
    rest.column + marker[0].length,
  );
  const padding = trimmed.body === "" || trimmed.indent >= 5 ? 1 : trimmed.indent;
  return {
    width: rest.indent + marker[0].length + padding,
    content: { ...trimmed, indent: Math.max(0, trimmed.indent - padding) },
    ordered: marker[1] === undefined ? null : Number(marker[1]),
  };
}

// The content past `columns` more columns of `text`, whose first character sits at column `from`;
// a tab reaching past the columns leaves the excess as indentation.
function contentAfter(text: string, columns: number, from: number): Content {
  let column = from;
  let index = 0;
  while (index < text.length && (text[index] === " " || text[index] === "\t")) {
    column += text[index] === " " ? 1 : 4 - (column % 4);
    index += 1;
  }
  return { indent: Math.max(0, column - from - columns), body: text.slice(index), column };
}

function past(content: Content, columns: number): Content {
  return { ...content, indent: Math.max(0, content.indent - columns) };
}

// A backtick fence's info string may not contain a backtick; such a line is not a fence at all. A
// comment or HTML block may end on the line that opens it (`<!-- x -->`, even `<!-->`, `<pre>x</pre>`);
// a fence never does, since its opening line is not a closing fence however it is spelled. A
// literal block opened by one of pre, script, style or textarea ends at the end tag of any of them.
// A lone tag opens a block only where no paragraph is open for it to continue (`interrupting`).
function opens(rest: Content, interrupting: boolean): OpenBlock | null {
  if (rest.indent > 3) return null;
  const text = rest.body;
  const fence = FENCE_OPEN.exec(text);
  if (fence !== null) {
    if (fence[1].startsWith("`") && fence[2].includes("`")) return null;
    return { kind: "fence", opener: fence[1], indent: rest.indent };
  }
  if (COMMENT_OPEN.test(text)) return { kind: "comment" };
  const literal = LITERAL_TAG_OPEN.exec(text);
  if (literal !== null) {
    return { kind: "html", until: LITERAL_TAG_END, closer: `</${literal[1].toLowerCase()}>` };
  }
  if (INSTRUCTION_OPEN.test(text)) return { kind: "html", until: /\?>/, closer: "?>" };
  if (CDATA_OPEN.test(text)) return { kind: "html", until: /\]\]>/, closer: "]]>" };
  if (DECLARATION_OPEN.test(text)) return { kind: "html", until: />/, closer: ">" };
  if (BLOCK_TAG_OPEN.test(text) || (!interrupting && LONE_TAG_OPEN.test(text))) {
    return { kind: "html", until: "blank-line", closer: "" };
  }
  return null;
}

function closes(rest: Content, open: OpenBlock): boolean {
  switch (open.kind) {
    case "fence": {
      const closer = rest.indent <= 3 ? FENCE_CLOSE.exec(rest.body) : null;
      return (
        closer !== null && closer[1][0] === open.opener[0] && closer[1].length >= open.opener.length
      );
    }
    case "comment":
      return rest.body.includes("-->");
    case "html":
      return open.until === "blank-line" ? rest.body === "" : open.until.test(rest.body);
  }
}

export type ParsedBlock = {
  source: string;
  sha: string;
  start: number;
  end: number;
};

export type ParsedBlocks = {
  blocks: ParsedBlock[];
  warnings: string[];
};

// A BEGIN pairs only with the very next marker line, and only when that is its own END: a block's
// body never holds a marker, so an orphaned or mismatched BEGIN is plain text rather than a span
// that swallows the user's lines and a later valid block.
export function parseBlocks(fileText: string): ParsedBlocks {
  const lines = markdownLines(fileText);
  const blocks: ParsedBlock[] = [];
  const warnings: string[] = [];
  const seen = new Set<string>();
  let i = 0;
  while (i < lines.length) {
    const begin = lines[i].kind === "comment" ? BEGIN_LINE.exec(lines[i].text) : null;
    if (begin === null) {
      i += 1;
      continue;
    }
    const [, source, sha] = begin;
    let j = i + 1;
    while (j < lines.length && !isMarker(lines[j])) j += 1;
    if (j === lines.length || lines[j].text !== `<!-- maxims:end ${source} -->`) {
      i += 1;
      continue;
    }
    if (seen.has(source)) warnings.push(`two managed blocks for ${source}; keeping the first`);
    else {
      seen.add(source);
      blocks.push({ source, sha, start: lines[i].start, end: lines[j].end });
    }
    i = j + 1;
  }
  return { blocks, warnings };
}

function isMarker(line: MarkdownLine): boolean {
  return line.kind === "comment" && (BEGIN_LINE.test(line.text) || END_LINE.test(line.text));
}

// Appending closes a block the file left open at its end: a fence, comment or raw HTML block runs
// to the end of the document anyway, so closing it there renders identically and keeps the new
// markers where the parser can find them on the next run. The blank line before the block is what
// closes a block-tag HTML block, so that kind needs no closer of its own; one opened inside a list
// item needs none either, since the block's own column-0 marker line ends the item and it.
export function replaceBlock(fileText: string, source: string, newBlock: string): string {
  const block = firstBlock(fileText, source);
  const rendered = withNewline(newBlock);
  if (block !== undefined)
    return fileText.slice(0, block.start) + rendered + fileText.slice(block.end);
  if (fileText === "") return rendered;
  const { open } = scanLines(fileText);
  const closer = open === null ? "" : closerFor(open);
  const ending = LAST_LINE_ENDING.exec(fileText)?.[1];
  const terminated = ending === undefined ? `${fileText}\n` : fileText;
  return `${terminated}${closer}${ending ?? "\n"}${rendered}`;
}

function closerFor(open: OpenBlock): string {
  if (open.kind === "fence") return `${" ".repeat(open.indent)}${open.opener}\n`;
  if (open.kind === "comment") return "-->\n";
  return open.closer === "" ? "" : `${open.closer}\n`;
}

export function stripBlock(fileText: string, source: string): { text: string; emptied: boolean } {
  const block = firstBlock(fileText, source);
  if (block === undefined) return { text: fileText, emptied: false };
  let before = fileText.slice(0, block.start);
  const after = fileText.slice(block.end);
  const endings = trailingLineEndings(before);
  if (endings.length >= 2 && (after === "" || FIRST_LINE_ENDING.test(after))) {
    before = before.slice(0, -endings[endings.length - 1].length);
  }
  const text = before + after;
  return { text, emptied: text.trim() === "" };
}

// The blank line an append wrote is the last of two consecutive line endings before the block;
// endings are read left to right so a CRLF is one ending, never a CR followed by an LF.
function trailingLineEndings(text: string): string[] {
  const run = /(?:\r\n|\r|\n)+$/.exec(text);
  return run === null ? [] : (run[0].match(/\r\n|\r|\n/g) ?? []);
}

function firstBlock(fileText: string, source: string): ParsedBlock | undefined {
  return parseBlocks(fileText).blocks.find((block) => block.source === source);
}
