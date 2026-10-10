import { readFile } from "node:fs/promises";
import {
  createScanner,
  type Node,
  type ParseError,
  parseTree,
  printParseErrorCode,
} from "jsonc-parser";
import { ExitCode, MaximsError } from "./exit-codes.ts";

// Edits to a JSON or JSONC config the user also owns are byte-range splices on the user's own
// text, located through the jsonc-parser tree: only the touched node and the one separator joining
// it to a neighbour change, so comments, irregular spacing and trailing commas outside it come
// back byte-identical. jsonc-parser's `modify` is not used because it reformats every line an edit
// touches, and a compact hand-written file does not survive that. Every splice invalidates the
// offsets of the tree it was computed from: callers re-parse before the next edit.

// Null text means "no config here": the file is missing, or it exists and holds only whitespace
// (`touch` creates one, and nobody has put a config in it yet), so a fresh config may replace it.
// `present` tells those two apart for an editor that fills the blank file on disk rather than
// creating a sibling. A file that exists but cannot be read is exit 4, never a fresh file.
export type ConfigRead = { present: false; text: null } | { present: true; text: string | null };

export async function readConfigFile(path: string): Promise<ConfigRead> {
  try {
    return await readPresentFile(path);
  } catch (cause) {
    const detail = cause instanceof Error ? cause.message : String(cause);
    throw new MaximsError(ExitCode.DestinationWriteFailed, `cannot read ${path}: ${detail}`, {
      cause,
    });
  }
}

export async function readConfigText(path: string): Promise<string | null> {
  return (await readConfigFile(path)).text;
}

// The same reading with every other failure thrown as it came, for a probe that reports the
// reason instead of refusing.
export async function readPresentFile(path: string): Promise<ConfigRead> {
  try {
    const text = await readFile(path, "utf8");
    return { present: true, text: text.trim() === "" ? null : text };
  } catch (cause) {
    if (cause instanceof Error && "code" in cause && cause.code === "ENOENT") {
      return { present: false, text: null };
    }
    throw cause;
  }
}

// What a vendor's parser takes beyond strict JSON. Claude Code's settings and Codex's hooks.json
// are strict; Gemini CLI strips comments before `JSON.parse` and so still chokes on a trailing
// comma; OpenCode documents JSONC. The splices below take JSONC everywhere, so a file is edited
// in whatever dialect its vendor loads, and refused in one it would not.
export type JsonDialect = "json" | "json-with-comments" | "jsonc";

// The dialect a file is judged in, with the vendor named where a judgment can refuse: the refusal
// says who would skip the file, which is the fact a user needs to accept the fix.
export type JsonReader =
  | { dialect: "jsonc" }
  | { dialect: Exclude<JsonDialect, "jsonc">; vendor: string };

export const JSONC: JsonReader = { dialect: "jsonc" };

export function jsonReader(dialect: JsonDialect, vendor: string): JsonReader {
  return dialect === "jsonc" ? JSONC : { dialect, vendor };
}

const DIALECT_NAMES: Record<Exclude<JsonDialect, "jsonc">, string> = {
  json: "strict JSON",
  "json-with-comments": "JSON with comments and no trailing commas",
};

// A config as its vendor would read it: the root, or why the vendor would not load it. `syntax` is
// a file nothing parses; `dialect` is a file that parses as JSONC but holds a construct the
// vendor's parser rejects, named with its position and who rejects it.
export type JsonDocument =
  | { kind: "root"; root: Node }
  | { kind: "syntax"; reason: string }
  | { kind: "dialect"; reason: string };

// The one judgment of whether a vendor loads a JSON config, shared by the writer that edits the
// file and the tier probe that reads it, so the two never disagree about the same bytes.
export function parseJsonDocument(text: string, reader: JsonReader): JsonDocument {
  const errors: ParseError[] = [];
  const root = parseTree(text, errors, { allowTrailingComma: true });
  const [first] = errors;
  if (first !== undefined) {
    return {
      kind: "syntax",
      reason: `${printParseErrorCode(first.error)} at offset ${first.offset}`,
    };
  }
  if (root === undefined) return { kind: "syntax", reason: "no JSON value" };
  if (reader.dialect === "jsonc") return { kind: "root", root };
  const offence = dialectOffence(text, reader.dialect);
  if (offence === undefined) return { kind: "root", root };
  return {
    kind: "dialect",
    reason: `${offence}; ${reader.vendor} reads ${DIALECT_NAMES[reader.dialect]}`,
  };
}

// The first construct a strict parser would stop at, in a text that already parses as JSONC: a
// comment, or a comma whose next token closes its container, at the scanner's own line and
// column (one-based, so a CR-only file counts its lines too). Token kinds are read off the text
// because jsonc-parser's `SyntaxKind` is a const enum its typings do not let a module import.
function dialectOffence(text: string, dialect: Exclude<JsonDialect, "jsonc">): string | undefined {
  const scanner = createScanner(text, false);
  let comma: string | undefined;
  while (scanner.getPosition() < text.length) {
    scanner.scan();
    const char = text[scanner.getTokenOffset()];
    if (char === undefined || /\s/.test(char)) continue;
    const here = `line ${scanner.getTokenStartLine() + 1}, column ${scanner.getTokenStartCharacter() + 1}`;
    if (char === "/") {
      if (dialect === "json") return `a comment at ${here}`;
      continue;
    }
    if (comma !== undefined && (char === "}" || char === "]")) {
      return `a trailing comma at ${comma}`;
    }
    comma = char === "," ? here : undefined;
  }
  return undefined;
}

// The object root of a config, or exit 4: a typo in the user's file must never become a clobbered
// file, a construct the vendor's parser rejects must never carry a hook the vendor would then skip,
// and the same check after a splice keeps a cut through a comment out of the user's file. `path`
// only names the file in the error.
export function assertParses(text: string, path: string, reader: JsonReader = JSONC): Node {
  const document = parseJsonDocument(text, reader);
  if (document.kind === "syntax") throw refuse(path, "it is not valid JSON");
  if (document.kind === "dialect") throw refuse(path, document.reason);
  if (document.root.type !== "object") throw refuse(path, "its top level is not an object");
  return document.root;
}

function refuse(path: string, reason: string): MaximsError {
  return new MaximsError(ExitCode.DestinationWriteFailed, `cannot edit ${path}: ${reason}`, {
    hint: "fix the file by hand, then run maxims sync",
  });
}

// Appends a `key: value` property to an object, or (with `key` null) an element to an array. An
// empty container's member goes in before the closing bracket's own whitespace (the trailing space
// of a `//` comment is the comment's, not the bracket's), so a comment already inside stays and a
// later removal restores the file byte for byte. An empty container on one line opens onto lines
// with a break before the bracket; one already on several lines keeps the bracket's whitespace
// exactly, so `[\n/* keep */]` stays glued: a break added there would read as the user's on
// removal.
export function appendChild(
  text: string,
  container: Node,
  key: string | null,
  value: unknown,
): string {
  if ((key === null) !== (container.type === "array")) {
    throw new Error(`a ${container.type} takes ${key === null ? "keyed" : "bare"} members`);
  }
  const style = detectStyle(text, container);
  const prefix = key === null ? "" : `${JSON.stringify(key)}: `;
  const render = (indent: string) => `${prefix}${pretty(value, indent, style)}`;
  const oneLine = !text.slice(container.offset, closingOf(container)).includes("\n");
  const last = container.children?.[container.children.length - 1];
  if (last === undefined) {
    const indent = lineIndent(text, container.offset);
    const closing = closingOf(container);
    const start = whitespaceStart(text, closing);
    const at = lineCommentEnd(text, start) ?? start;
    const tail = oneLine ? (at === closing ? `${style.eol}${indent}` : style.eol) : "";
    const inner = `${indent}${style.unit}`;
    return splice(text, at, 0, `${style.eol}${inner}${render(inner)}${tail}`);
  }
  const indent = lineIndent(text, last.offset);
  const separator = oneLine ? ", " : `,${style.eol}${indent}`;
  return splice(text, last.offset + last.length, 0, `${separator}${render(indent)}`);
}

export function replaceValue(text: string, node: Node, value: unknown): string {
  return splice(
    text,
    node.offset,
    node.length,
    pretty(value, lineIndent(text, node.offset), detectStyle(text, node)),
  );
}

// Cuts one member and the one comma that joined it. When nothing but whitespace sits between that
// comma and the member the whole run goes too, which is the exact inverse of an append; a comment
// in the gap stays, and a line comment keeps the line break that ends it. A lone member also takes
// the break that ends its own line, except when a line break already sat between the opening
// bracket and the member (`[\n/* keep */\n  x\n]`): an append into such a container adds no
// break before the bracket, so that one is the user's. A member that follows a `//` comment takes
// its break either way, since the comment's own break is the one before it. `[/* keep */\n  x\n]`
// and `[/* keep */]` are the same file to us, and the one-line reading wins. A container left
// holding only whitespace collapses to `{}` or `[]`; one still holding a comment keeps it. The
// container itself always stays: nothing tells a `hooks: {}` the user wrote from one maxims added.
export function removeChild(text: string, container: Node, child: Node): string {
  const siblings = container.children ?? [];
  const index = siblings.indexOf(child);
  const previous = siblings[index - 1];
  const next = siblings[index + 1];
  const end = child.offset + child.length;
  let out: string;
  if (next !== undefined) {
    const comma = commaBetween(text, end, next.offset);
    if (comma === undefined) {
      out = splice(text, child.offset, end - child.offset, "");
    } else if (whitespaceOnly(text, end, comma)) {
      out = splice(text, child.offset, whitespaceEnd(text, comma + 1) - child.offset, "");
    } else {
      out = splice(splice(text, comma, 1, ""), child.offset, end - child.offset, "");
    }
  } else if (previous !== undefined) {
    const comma = commaBetween(text, previous.offset + previous.length, child.offset);
    if (comma !== undefined && whitespaceOnly(text, comma + 1, child.offset)) {
      out = splice(text, comma, end - comma, "");
    } else {
      const start = leadStart(text, child.offset);
      const stop =
        start === whitespaceStart(text, child.offset) ? end : throughFirstLineBreak(text, end);
      out = splice(text, start, stop - start, "");
      if (comma !== undefined) out = splice(out, comma, 1, "");
    }
  } else {
    const comma = commaBetween(text, end, closingOf(container));
    const tailFrom = comma !== undefined && whitespaceOnly(text, end, comma) ? comma + 1 : end;
    const start = leadStart(text, child.offset);
    const stop =
      start === whitespaceStart(text, child.offset) &&
      text.slice(container.offset + 1, start).includes("\n")
        ? tailFrom
        : throughFirstLineBreak(text, tailFrom);
    out = comma !== undefined && tailFrom === end ? splice(text, comma, 1, "") : text;
    out = splice(out, start, stop - start, "");
  }
  const closing = closingOf(container) - (text.length - out.length);
  if (whitespaceOnly(out, container.offset + 1, closing)) {
    return splice(out, container.offset + 1, closing - container.offset - 1, "");
  }
  return out;
}

type Style = { eol: string; unit: string };

// The indent unit is what a root member on a line of its own is indented by, never a regex over
// every line: the ` * ` gutter of a block-comment header, or a member opening right after `*/`,
// would otherwise pass for a one-space unit. A file with no such member gets two spaces, the
// style every harness's own examples use.
function detectStyle(text: string, node: Node): Style {
  let root = node;
  while (root.parent !== undefined) root = root.parent;
  const unit = (root.children ?? [])
    .map((child) => text.slice(text.lastIndexOf("\n", child.offset - 1) + 1, child.offset))
    .find((prefix) => prefix !== "" && prefix.trim() === "");
  return { eol: text.includes("\r\n") ? "\r\n" : "\n", unit: unit ?? "  " };
}

function pretty(value: unknown, indent: string, style: Style): string {
  return JSON.stringify(value, null, style.unit).split("\n").join(`${style.eol}${indent}`);
}

function splice(text: string, offset: number, length: number, content: string): string {
  return `${text.slice(0, offset)}${content}${text.slice(offset + length)}`;
}

// The separator between two siblings is one comma, possibly among comments; the scanner walks
// the gap so a comma inside a comment is never mistaken for it.
function commaBetween(text: string, from: number, to: number): number | undefined {
  const gap = text.slice(from, to);
  const scanner = createScanner(gap, false);
  while (scanner.getPosition() < gap.length) {
    scanner.scan();
    const at = scanner.getTokenOffset();
    if (gap[at] === "," && scanner.getTokenLength() === 1) return from + at;
  }
  return undefined;
}

function closingOf(container: Node): number {
  return container.offset + container.length - 1;
}

function whitespaceOnly(text: string, from: number, to: number): boolean {
  return text.slice(from, to).trim() === "";
}

function whitespaceStart(text: string, offset: number): number {
  let start = offset;
  while (start > 0 && isWhitespace(text[start - 1])) start -= 1;
  return start;
}

function whitespaceEnd(text: string, offset: number): number {
  let end = offset;
  while (end < text.length && isWhitespace(text[end])) end += 1;
  return end;
}

// The whitespace run leading into a node, except the line break that terminates a `//` comment
// right before it: taking that break would swallow the rest of the line.
function leadStart(text: string, offset: number): number {
  const start = whitespaceStart(text, offset);
  if (lineCommentEnd(text, start) === undefined) return start;
  const lineBreak = text.indexOf("\n", start);
  return lineBreak === -1 || lineBreak >= offset ? start : lineBreak + 1;
}

// Where the `//` comment holding the character before `offset` ends, or undefined when that
// character is not in one. The token runs to the line break, trailing spaces included, so a
// whitespace walk that stopped inside them is moved out to the token's end. The scanner runs from
// the top of the file so a `//` inside a string (`"https://example.com"`) is never taken for one.
function lineCommentEnd(text: string, offset: number): number | undefined {
  const scanner = createScanner(text, false);
  while (scanner.getPosition() < text.length) {
    scanner.scan();
    const at = scanner.getTokenOffset();
    const end = at + scanner.getTokenLength();
    if (end < offset) continue;
    return at < offset && text.startsWith("//", at) ? end : undefined;
  }
  return undefined;
}

function throughFirstLineBreak(text: string, offset: number): number {
  const end = whitespaceEnd(text, offset);
  const lineBreak = text.indexOf("\n", offset);
  return lineBreak === -1 || lineBreak >= end ? offset : lineBreak + 1;
}

function isWhitespace(char: string | undefined): boolean {
  return char === " " || char === "\t" || char === "\n" || char === "\r";
}

function lineIndent(text: string, offset: number): string {
  const lineStart = text.lastIndexOf("\n", offset - 1) + 1;
  return /^[ \t]*/.exec(text.slice(lineStart, offset))?.[0] ?? "";
}
