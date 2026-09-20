import { readFile } from "node:fs/promises";
import {
  createScanner,
  type Node,
  type ParseError,
  type ParseOptions,
  parseTree,
} from "jsonc-parser";
import { ExitCode, MaximsError } from "../../util/exit-codes.ts";

// Surgical edits of a JSON or JSONC config the user also owns. jsonc-parser's `modify` reformats
// every node its edit range touches, which reflows a compact sibling or a one-line array on
// insert and on remove; these helpers splice text at the offsets its parser reports instead, so
// the bytes outside our own entry are the bytes that were there. Trailing commas are accepted
// because OpenCode's parser accepts them.
type Formatting = {
  indentUnit: string;
  eol: string;
};

const PARSE_OPTIONS: ParseOptions = { allowTrailingComma: true };

// A file with no indented line yet gets two spaces, the style every harness's own examples use.
function detectFormatting(text: string): Formatting {
  const eol = text.includes("\r\n") ? "\r\n" : "\n";
  const indent = /^([ \t]+)\S/m.exec(text)?.[1];
  return { indentUnit: indent ?? "  ", eol };
}

// Only a file that is ABSENT may be created; a file that exists but cannot be read must not be
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

// An unparseable config is never rewritten: a typo in the user's file must not become a
// clobbered file, and a splice that cut through a comment must not land in it. `path` only
// names the file in the error.
export function assertParses(text: string, path: string): Node {
  const errors: ParseError[] = [];
  const root = parseTree(text, errors, PARSE_OPTIONS);
  if (errors.length > 0 || root === undefined || root.type !== "object") {
    throw new MaximsError(ExitCode.DestinationWriteFailed, `cannot parse ${path}; left untouched`);
  }
  return root;
}

// Appends one child, a `key: value` property or a bare element, separated the way the container
// already separates its last two children (or its bracket from a lone child).
export function appendChild(
  text: string,
  container: Node,
  key: string | null,
  value: unknown,
): string {
  const fmt = detectFormatting(text);
  const prefix = key === null ? "" : `${JSON.stringify(key)}: `;
  const children = container.children ?? [];
  const last = children[children.length - 1];
  if (last === undefined) return fillEmpty(text, container, prefix, value, fmt);
  const previous = children[children.length - 2];
  const gapStart =
    previous === undefined
      ? container.offset + 1
      : commaAfter(text, previous.offset + previous.length, true) + 1;
  const separator = trailingWhitespace(text.slice(gapStart, last.offset));
  const rendered = renderValue(value, fmt, lineIndent(text, last.offset), separator.includes("\n"));
  const insertAt = last.offset + last.length;
  return `${text.slice(0, insertAt)},${separator}${prefix}${rendered}${text.slice(insertAt)}`;
}

export function replaceValue(text: string, node: Node, value: unknown): string {
  const fmt = detectFormatting(text);
  const old = text.slice(node.offset, node.offset + node.length);
  const rendered = renderValue(value, fmt, lineIndent(text, node.offset), old.includes("\n"));
  return `${text.slice(0, node.offset)}${rendered}${text.slice(node.offset + node.length)}`;
}

// Cuts one child (a property or an element) and the comma that joined it to a sibling, keeping
// every comment: the comma is found by the tokenizer, never by searching for the character. A
// child alone on its line takes the line with it. A container left holding only whitespace
// collapses to `{}` or `[]`; one still holding a comment keeps it. Either way the container stays,
// because maxims never deletes a key it did not create.
export function removeChild(text: string, container: Node, child: Node): string {
  const siblings = container.children ?? [];
  const index = siblings.indexOf(child);
  const previous = siblings[index - 1];
  const next = siblings[index + 1];
  const start = child.offset;
  const end = start + child.length;
  let cuts: [number, number][];
  if (next !== undefined) {
    const comma = commaAfter(text, end, true);
    cuts =
      text.slice(end, comma).trim() === ""
        ? [widenToLine(text, start, comma + 1)]
        : [
            [comma, comma + 1],
            [start, end],
          ];
  } else if (previous !== undefined) {
    const comma = commaAfter(text, previous.offset + previous.length, true);
    cuts =
      text.slice(comma + 1, start).trim() === ""
        ? [[comma, end]]
        : [
            [comma, comma + 1],
            [start, end],
          ];
  } else {
    const trailing = commaAfter(text, end, false);
    cuts =
      trailing === null
        ? [widenToLine(text, start, end)]
        : text.slice(end, trailing).trim() === ""
          ? [widenToLine(text, start, trailing + 1)]
          : [[trailing, trailing + 1], widenToLine(text, start, end)];
  }
  let out = text;
  for (const [from, to] of cuts.sort((a, b) => b[0] - a[0])) {
    out = `${out.slice(0, from)}${out.slice(to)}`;
  }
  const close = container.offset + container.length - 1 - (text.length - out.length);
  const interior = out.slice(container.offset + 1, close);
  if (siblings.length === 1 && interior.trim() === "") {
    return `${out.slice(0, container.offset + 1)}${out.slice(close)}`;
  }
  return out;
}

// A span alone on its line takes the whole line, so no blank line is left behind; one sharing
// its line with following content takes the horizontal whitespace that separated them.
function widenToLine(text: string, start: number, end: number): [number, number] {
  const lineStart = text.lastIndexOf("\n", start - 1) + 1;
  const lineEnd = text.indexOf("\n", end);
  const before = text.slice(lineStart, start);
  const after = lineEnd < 0 ? text.slice(end) : text.slice(end, lineEnd);
  if (before.trim() === "" && after.trim() === "") {
    return [lineStart, lineEnd < 0 ? text.length : lineEnd + 1];
  }
  const spaces = after.trim() === "" ? 0 : (/^[ \t]*/.exec(after)?.[0].length ?? 0);
  return [start, end + spaces];
}

// The tokenizer skips whitespace and comments, so the first token after `position` is the comma
// or there is none; searching for the character would find one inside a comment. A missing comma
// is refused where a sibling follows and reported as null where a trailing one is optional.
function commaAfter(text: string, position: number, required: true): number;
function commaAfter(text: string, position: number, required: false): number | null;
function commaAfter(text: string, position: number, required: boolean): number | null {
  const scanner = createScanner(text, true);
  scanner.setPosition(position);
  scanner.scan();
  const offset = scanner.getTokenOffset();
  if (scanner.getTokenLength() === 1 && text[offset] === ",") return offset;
  if (!required) return null;
  throw new MaximsError(
    ExitCode.DestinationWriteFailed,
    `expected a comma after offset ${position}; left untouched`,
  );
}

// An empty container gets its first child before the closing bracket, so a comment already
// inside stays. In a multi-line file the container opens up; in a one-line file it stays flat.
function fillEmpty(
  text: string,
  container: Node,
  prefix: string,
  value: unknown,
  fmt: Formatting,
): string {
  const close = container.offset + container.length - 1;
  const interior = text.slice(container.offset + 1, close);
  if (!text.trim().includes("\n")) {
    return `${text.slice(0, close)}${prefix}${renderValue(value, fmt, "", false)}${text.slice(close)}`;
  }
  const outer = lineIndent(text, container.offset);
  const inner = `${outer}${fmt.indentUnit}`;
  const kept = interior.trim() === "" ? "" : interior.trimEnd();
  const body = `${kept}${fmt.eol}${inner}${prefix}${renderValue(value, fmt, inner, true)}${fmt.eol}${outer}`;
  return `${text.slice(0, container.offset + 1)}${body}${text.slice(close)}`;
}

function renderValue(value: unknown, fmt: Formatting, indent: string, multiline: boolean): string {
  if (!multiline) return JSON.stringify(value);
  return JSON.stringify(value, null, fmt.indentUnit).split("\n").join(`${fmt.eol}${indent}`);
}

function lineIndent(text: string, offset: number): string {
  const lineStart = text.lastIndexOf("\n", offset - 1) + 1;
  return /^[ \t]*/.exec(text.slice(lineStart, offset))?.[0] ?? "";
}

function trailingWhitespace(gap: string): string {
  return /\s*$/.exec(gap)?.[0] ?? "";
}
