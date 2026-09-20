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

// A reference token is wrapped in a code span, which every documented import parser skips. So
// that every parser agrees where that span is, a line carrying such a token first loses everything
// that could pair with, escape or swallow one of its fences: existing backticks, backslashes, `<`,
// `[` and any `~~~` run become entities (a leading `~~~` would otherwise turn the whole rule into
// a fence's info string). The fences are then the only backticks in the line, each glued to its token with
// no escape or link syntax left to reach across them, so a construct that steals an opener
// swallows the token with it and none can leave it exposed.
//
// A token behind leading backslashes counts as a reference too, since CommonMark renders `\@x` as
// a bare `@x`; once the backslash is an entity the token is inert and needs no fence.
function escapeReferences(text: string, expands: readonly ExpansionSyntax[]): string {
  const wrapAt = expands.length === 0 || expands.includes("at-import");
  const wrapHash = expands.length === 0;
  const isReference = (token: string): boolean =>
    (wrapAt && /^\\*@/.test(token)) || (wrapHash && /^\\*#[A-Za-z]+:/.test(token));
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
// block-tag kind (div, details, table, ...); `closer` is what an append writes to end one left
// open at EOF, empty when the blank line the append already writes does that.
type OpenBlock =
  | { kind: "fence"; opener: string; indent: string }
  | { kind: "comment" }
  | { kind: "html"; until: RegExp | "blank-line"; closer: string }
  | null;

// A block may open behind up to three spaces, as CommonMark allows, and a marker inside one is
// then quoted text. Whitespace in these rules is CommonMark's space and tab, never other Unicode
// whitespace; an info string may hold any character (dotAll). A declaration starts with an
// uppercase letter, as Bun's parser and CommonMark 0.29 require.
const FENCE_OPEN = /^( {0,3})(`{3,}|~{3,})(.*)$/s;
const FENCE_CLOSE = /^ {0,3}(`{3,}|~{3,})[ \t]*$/;
const BLANK_LINE = /^[ \t]*$/;
const COMMENT_OPEN = /^ {0,3}<!--/;
const LITERAL_TAG_OPEN = /^ {0,3}<(pre|script|style|textarea)(?=[ \t>]|$)/i;
const LITERAL_TAG_END = /<\/(pre|script|style|textarea)>/i;
const INSTRUCTION_OPEN = /^ {0,3}<\?/;
const CDATA_OPEN = /^ {0,3}<!\[CDATA\[/;
const DECLARATION_OPEN = /^ {0,3}<![A-Z]/;
const BLOCK_TAG_OPEN =
  /^ {0,3}<\/?(address|article|aside|base|basefont|blockquote|body|caption|center|col|colgroup|dd|details|dialog|dir|div|dl|dt|fieldset|figcaption|figure|footer|form|frame|frameset|h[1-6]|head|header|hr|html|iframe|legend|li|link|main|menu|menuitem|nav|noframes|ol|optgroup|option|p|param|search|section|summary|table|tbody|td|tfoot|th|thead|title|tr|track|ul)(?=[ \t>]|\/>|$)/i;
const LINE_ENDING = /\r\n|\r|\n/g;
const LAST_LINE_ENDING = /(\r\n|\r|\n)$/;
const FIRST_LINE_ENDING = /^(\r\n|\r|\n)/;
const BOM = "\uFEFF";

export function markdownLines(fileText: string): MarkdownLine[] {
  return scanLines(fileText).lines;
}

// A leading byte order mark is not part of the first line: Markdown parsers drop it, so the line
// behind it opens a block as if it were at column 0, and the mark stays outside any block's span.
function scanLines(fileText: string): { lines: MarkdownLine[]; open: OpenBlock } {
  const lines: MarkdownLine[] = [];
  let open: OpenBlock = null;
  let start = fileText.startsWith(BOM) ? BOM.length : 0;
  while (start < fileText.length) {
    LINE_ENDING.lastIndex = start;
    const ending = LINE_ENDING.exec(fileText);
    const textEnd = ending === null ? fileText.length : ending.index;
    const end = ending === null ? fileText.length : ending.index + ending[0].length;
    const text = fileText.slice(start, textEnd);
    let kind: MarkdownLine["kind"];
    if (open === null) {
      const opened = opens(text);
      kind = opened === null ? "text" : opened.kind === "fence" ? "fenced" : opened.kind;
      if (opened !== null && (opened.kind === "fence" || !closes(text, opened))) open = opened;
    } else {
      kind =
        open.kind === "fence"
          ? "fenced"
          : open.kind === "comment"
            ? "comment-continuation"
            : "html";
      if (closes(text, open)) open = null;
    }
    lines.push({ text, start, end, kind });
    start = end;
  }
  return { lines, open };
}

// A backtick fence's info string may not contain a backtick; such a line is not a fence at all. A
// comment or HTML block may end on the line that opens it (`<!-- x -->`, even `<!-->`, `<pre>x</pre>`);
// a fence never does, since its opening line is not a closing fence however it is spelled. A
// literal block opened by one of pre, script, style or textarea ends at the end tag of any of them.
function opens(text: string): NonNullable<OpenBlock> | null {
  const fence = FENCE_OPEN.exec(text);
  if (fence !== null) {
    if (fence[2].startsWith("`") && fence[3].includes("`")) return null;
    return { kind: "fence", opener: fence[2], indent: fence[1] };
  }
  if (COMMENT_OPEN.test(text)) return { kind: "comment" };
  const literal = LITERAL_TAG_OPEN.exec(text);
  if (literal !== null) {
    return { kind: "html", until: LITERAL_TAG_END, closer: `</${literal[1].toLowerCase()}>` };
  }
  if (INSTRUCTION_OPEN.test(text)) return { kind: "html", until: /\?>/, closer: "?>" };
  if (CDATA_OPEN.test(text)) return { kind: "html", until: /\]\]>/, closer: "]]>" };
  if (DECLARATION_OPEN.test(text)) return { kind: "html", until: />/, closer: ">" };
  if (BLOCK_TAG_OPEN.test(text)) return { kind: "html", until: "blank-line", closer: "" };
  return null;
}

function closes(text: string, open: NonNullable<OpenBlock>): boolean {
  switch (open.kind) {
    case "fence": {
      const closer = FENCE_CLOSE.exec(text);
      return (
        closer !== null && closer[1][0] === open.opener[0] && closer[1].length >= open.opener.length
      );
    }
    case "comment":
      return text.includes("-->");
    case "html":
      return open.until === "blank-line" ? BLANK_LINE.test(text) : open.until.test(text);
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
// closes a block-tag HTML block, so that kind needs no closer of its own. A fence is closed at its
// opener's indentation: if the opener belonged to a list item that a later item already ended, the
// closer lands inside that item too, and the column-0 block after it stands outside both.
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

function closerFor(open: NonNullable<OpenBlock>): string {
  if (open.kind === "fence") return `${open.indent}${open.opener}\n`;
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
