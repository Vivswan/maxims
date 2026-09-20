import { readFile } from "node:fs/promises";
import { createScanner, type Node, type ParseError, parseTree } from "jsonc-parser";
import { ExitCode, MaximsError } from "./exit-codes.ts";

// Edits to a JSON or JSONC config the user also owns are byte-range splices on the user's own
// text, located through the jsonc-parser tree: only the touched node and the one separator joining
// it to a neighbour change, so comments, irregular spacing and trailing commas outside it come
// back byte-identical. jsonc-parser's `modify` is not used because it reformats every line an edit
// touches, and a compact hand-written file does not survive that. Every splice invalidates the
// offsets of the tree it was computed from: callers re-parse before the next edit.

// Only a file that is ABSENT reads as null; a file that exists but cannot be read must not be
// replaced by a fresh one, which is what treating every read failure as absence would do.
export async function readConfigText(path: string): Promise<string | null> {
  try {
    return await readFile(path, "utf8");
  } catch (cause) {
    if (cause instanceof Error && "code" in cause && cause.code === "ENOENT") return null;
    const detail = cause instanceof Error ? cause.message : String(cause);
    throw new MaximsError(ExitCode.DestinationWriteFailed, `cannot read ${path}: ${detail}`, {
      cause,
    });
  }
}

// The object root of a config, or exit 4: a typo in the user's file must never become a clobbered
// file, and the same check after a splice keeps a cut through a comment out of the user's file.
// `path` only names the file in the error.
export function assertParses(text: string, path: string): Node {
  const errors: ParseError[] = [];
  const root = parseTree(text, errors, { allowTrailingComma: true });
  if (errors.length > 0 || root === undefined) throw refuse(path, "it is not valid JSON");
  if (root.type !== "object") throw refuse(path, "its top level is not an object");
  return root;
}

function refuse(path: string, reason: string): MaximsError {
  return new MaximsError(ExitCode.DestinationWriteFailed, `cannot edit ${path}: ${reason}`, {
    hint: "fix the file by hand, then run maxims sync",
  });
}

// Appends a `key: value` property to an object, or (with `key` null) an element to an array. An
// empty container's member goes in before the closing bracket's own whitespace (the trailing space
// of a `//` comment is the comment's, not the bracket's), so a comment already inside stays and a
// later removal restores the file byte for byte. A container on one line opens onto lines with a
// break before the bracket; one already on several lines keeps the bracket's whitespace exactly,
// so `[\n/* keep */]` stays glued: a break added there would read as the user's on removal.
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
  const last = container.children?.[container.children.length - 1];
  if (last === undefined) {
    const indent = lineIndent(text, container.offset);
    const closing = closingOf(container);
    const start = whitespaceStart(text, closing);
    const at = lineCommentEnd(text, start) ?? start;
    const tail = text.slice(container.offset + 1, closing).includes("\n")
      ? ""
      : at === closing
        ? `${style.eol}${indent}`
        : style.eol;
    const inner = `${indent}${style.unit}`;
    return splice(text, at, 0, `${style.eol}${inner}${render(inner)}${tail}`);
  }
  const indent = lineIndent(text, last.offset);
  return splice(text, last.offset + last.length, 0, `,${style.eol}${indent}${render(indent)}`);
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
