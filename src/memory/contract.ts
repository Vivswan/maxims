import { basename } from "node:path";
import { type Document, isMap, isNode, LineCounter, parseDocument } from "yaml";
import { findPair } from "yaml/util";
import { util } from "zod";
import { sha256 } from "../util/fs.ts";

declare const memoryNameBrand: unique symbol;
declare const contentHashBrand: unique symbol;

export type MemoryName = string & { readonly [memoryNameBrand]: true };

// The `sha256:<hex>` digest of a memory file, a description, or a copied tree, in the one spelling
// `sha256` in util/fs.ts produces. State records and compares these across fetches, and a rule
// line shows a prefix of one, so a hash read back from disk is parsed here before it is trusted.
export type ContentHash = string & { readonly [contentHashBrand]: true };

const CONTENT_HASH_PATTERN = /^sha256:[0-9a-f]{64}$/;

export function parseContentHash(candidate: string): ContentHash | null {
  return CONTENT_HASH_PATTERN.test(candidate) ? (candidate as ContentHash) : null;
}

export function contentHashOf(text: string | Uint8Array): ContentHash {
  return sha256(text) as ContentHash;
}

// A digest spelled as a literal is minted here so a malformed one fails at module load, naming
// itself, instead of reaching a comparison as an ordinary string.
export function contentHashLiteral(literal: string): ContentHash {
  const parsed = parseContentHash(literal);
  if (parsed === null) throw new Error(`not a sha256:<64 hex digits> digest: ${literal}`);
  return parsed;
}

// A name reaches disk as `<name>.md` inside a directory, so the grammar admits nothing a path builder could misread: no separators, no dots, no case to fold.
export const MEMORY_NAME_PATTERN = /^[a-z0-9]+(-[a-z0-9]+)*$/;

// Keeps the filename under every common filesystem's 255-byte limit with room for the extension.
export const MEMORY_NAME_MAX_LENGTH = 200;

// The local name a rename map gives a memory, or its own name. A plain object lookup would hand
// back Object.prototype members for a memory named `constructor` or a `to-string`-like key that
// exists on the prototype chain.
export function renamed(
  rename: Readonly<Record<string, MemoryName>>,
  name: MemoryName,
): MemoryName {
  return Object.hasOwn(rename, name) ? rename[name] : name;
}

export function parseMemoryName(candidate: string): MemoryName | null {
  if (candidate.length > MEMORY_NAME_MAX_LENGTH || !MEMORY_NAME_PATTERN.test(candidate))
    return null;
  // A name whose file every walker skips could be scaffolded but never installed.
  if (isReservedFile(`${candidate}.md`)) return null;
  return candidate as MemoryName;
}

export const MEMORY_TYPES = ["user", "feedback", "project", "reference"] as const;
export type MemoryType = (typeof MEMORY_TYPES)[number];

// Two files sit beside memories in their folder without being memories: `MEMORY.md`, the index
// the auto-memory format writes, and the folder's own README, which hosts render under any
// letter case. Both are skipped by name and in silence; every other file that fails the contract
// earns its warning line.
function isReservedFile(name: string): boolean {
  return name === "MEMORY.md" || name.toLowerCase() === "readme.md";
}

// engine/sync-retained.ts walks installed bodies with this too, so a sweep and the parser share
// one suffix rule.
export function memoryStem(fileName: string): string | null {
  return fileName.endsWith(".md") ? fileName.slice(0, -".md".length) : null;
}

// What a walk over a memories folder hands to the parser; everything else is passed over silently.
export function isMemoryFile(name: string): boolean {
  return memoryStem(name) !== null && !isReservedFile(name);
}

export type MemoryMetadata = {
  nodeType?: "memory";
  type?: MemoryType;
  scope?: string;
  internal?: boolean;
  extra: Record<string, unknown>;
};

export type Memory = {
  name: MemoryName;
  description: string;
  body: string;
  metadata: MemoryMetadata;
  raw: string;
  contentHash: ContentHash;
};

export type ParsedMemory =
  | { ok: true; memory: Memory; warning?: string }
  | { ok: false; reason: string };

// A parsed memory with the file lines `lint` prints. Every line is 1-based in the file as
// authored, so `path:line` opens an editor on the problem. A problem with no place of its own
// (the filename, a missing fence, an absent key) is line 1.
export type PlacedMemory =
  | ({ ok: true; memory: Memory; descriptionLine: number } & MemoryWarning)
  | { ok: false; reason: string; line: number };

// A warning always comes with the line of the first key it names.
type MemoryWarning =
  | { warning: string; warningLine: number }
  | { warning?: undefined; warningLine?: undefined };

// The keys from the top of the frontmatter down to the one a finding is about.
type KeyPath = readonly string[];

type Finding = { reason: string; at: KeyPath };

type Frontmatter = { document: Document; lineCounter: LineCounter };

// The opening fence is one line, so the YAML block starts on the file's second.
const OPENING_FENCE_LINES = 1;

// A source file can carry anything YAML can express, and a file that fails the contract is
// skipped with a reason, never fatal; the outer catch makes that promise hold for inputs the
// row-by-row checks did not anticipate.
export function parseMemoryWithLines(filename: string, text: string): PlacedMemory {
  try {
    return parseMemoryChecked(filename, text);
  } catch (error) {
    return { ok: false, reason: `unreadable memory file: ${describe(error)}`, line: 1 };
  }
}

// What every reader but `lint` needs: the memory or the reason, without the lines.
export function parseMemory(filename: string, text: string): ParsedMemory {
  const placed = parseMemoryWithLines(filename, text);
  if (!placed.ok) return { ok: false, reason: placed.reason };
  if (placed.warning === undefined) return { ok: true, memory: placed.memory };

  return { ok: true, memory: placed.memory, warning: placed.warning };
}

function parseMemoryChecked(filename: string, text: string): PlacedMemory {
  const file = basename(filename);
  if (isReservedFile(file)) return { ok: false, reason: `${file} is reserved`, line: 1 };
  const stem = memoryStem(file);
  if (stem === null) return { ok: false, reason: `${file} is not a .md file`, line: 1 };
  const name = parseMemoryName(stem);
  if (name === null) {
    return { ok: false, reason: `filename stem "${stem}" is not kebab-case`, line: 1 };
  }

  const split = splitFrontmatter(text);
  if (split === null) return { ok: false, reason: "missing frontmatter", line: 1 };
  const lineCounter = new LineCounter();
  // Unprettified, an error's message comes without the code frame.
  const document = parseDocument(split.yaml, { lineCounter, prettyErrors: false });
  const source: Frontmatter = { document, lineCounter };
  const syntax = document.errors[0];
  if (syntax !== undefined) {
    const reason = `frontmatter is not valid YAML: ${onOneLine(syntax.message)}`;
    return { ok: false, reason, line: fileLine(source, syntax.pos[0]) };
  }
  let frontmatter: unknown;
  try {
    frontmatter = document.toJS();
  } catch (error) {
    const reason = `frontmatter is not valid YAML: ${onOneLine(describe(error))}`;
    return { ok: false, reason, line: 1 };
  }
  if (!util.isObject(frontmatter)) {
    const line = nodeLine(source, document.contents);
    return { ok: false, reason: "frontmatter is not a mapping", line };
  }

  if (frontmatter.name !== name) {
    const reason = `name ${show(frontmatter.name)} does not equal filename stem "${stem}"`;
    return { ok: false, reason, line: keyLine(source, ["name"]) };
  }
  const descriptionLine = keyLine(source, ["description"]);
  const description = frontmatter.description;
  if (typeof description !== "string" || description.trim() === "") {
    return { ok: false, reason: "description is missing or empty", line: descriptionLine };
  }
  if (/[\r\n]/.test(description.trim())) {
    return { ok: false, reason: "description spans several lines", line: descriptionLine };
  }

  const metadata = readMetadata(frontmatter.metadata);
  if (!metadata.ok) {
    return {
      ok: false,
      reason: metadata.refusal.reason,
      line: keyLine(source, metadata.refusal.at),
    };
  }

  const memory: Memory = {
    name,
    description: description.trim(),
    body: split.body,
    metadata: metadata.metadata,
    raw: text,
    contentHash: contentHashOf(text),
  };
  const first = metadata.warnings[0];
  if (first === undefined) return { ok: true, memory, descriptionLine };

  const warning = metadata.warnings.map((finding) => finding.reason).join("; ");
  return { ok: true, memory, descriptionLine, warning, warningLine: keyLine(source, first.at) };
}

function fileLine(source: Frontmatter, offset: number): number {
  return source.lineCounter.linePos(offset).line + OPENING_FENCE_LINES;
}

function nodeLine(source: Frontmatter, node: unknown): number {
  const start = isNode(node) ? node.range?.[0] : undefined;
  return start === undefined ? 1 : fileLine(source, start);
}

// The line of the deepest key the path reaches: a finding about an absent nested key lands on its
// parent, and one about an absent top-level key on line 1.
function keyLine(source: Frontmatter, path: KeyPath): number {
  let node: unknown = source.document.contents;
  let line = 1;
  for (const key of path) {
    if (!isMap(node)) break;
    const pair = findPair(node.items, key);
    if (pair === undefined) break;
    line = nodeLine(source, pair.key);
    node = pair.value;
  }
  return line;
}

type ReadMetadata =
  | { ok: true; metadata: MemoryMetadata; warnings: Finding[] }
  | { ok: false; refusal: Finding };

// A `type` outside the contract's list stays under `extra` with a warning, never a refusal.
function readType(metadata: MemoryMetadata, type: unknown): Finding[] {
  if (type === undefined) return [];
  if (isMemoryType(type)) {
    metadata.type = type;
    return [];
  }
  metadata.extra.type = type;
  const reason = `metadata.type ${show(type)} is not one of ${MEMORY_TYPES.join(", ")}`;
  return [{ reason, at: ["metadata", "type"] }];
}

function readInternal(metadata: MemoryMetadata, internal: unknown): Finding[] {
  if (internal === undefined) return [];
  if (typeof internal === "boolean") {
    metadata.internal = internal;
    return [];
  }
  metadata.extra.internal = internal;
  const reason = `metadata.internal ${show(internal)} is not a boolean`;
  return [{ reason, at: ["metadata", "internal"] }];
}

function readMetadata(value: unknown): ReadMetadata {
  if (value === undefined || value === null) {
    return { ok: true, metadata: { extra: {} }, warnings: [] };
  }
  if (!util.isObject(value)) {
    return { ok: false, refusal: { reason: "metadata is not a mapping", at: ["metadata"] } };
  }
  const { node_type: nodeType, type, scope, internal, ...extra } = value;
  if (nodeType !== undefined && nodeType !== "memory") {
    const reason = `metadata.node_type is ${show(nodeType)}, expected "memory"`;
    return { ok: false, refusal: { reason, at: ["metadata", "node_type"] } };
  }
  const metadata: MemoryMetadata = { extra };
  if (nodeType === "memory") metadata.nodeType = "memory";
  if (typeof scope === "string") metadata.scope = scope;
  else if (scope !== undefined) extra.scope = scope;
  const warnings = [...readType(metadata, type), ...readInternal(metadata, internal)];
  return { ok: true, metadata, warnings };
}

function isMemoryType(value: unknown): value is MemoryType {
  return typeof value === "string" && (MEMORY_TYPES as readonly string[]).includes(value);
}

// JSON rendering never consults the value's own toString, which YAML can set to anything.
function show(value: unknown): string {
  try {
    return JSON.stringify(value) ?? typeof value;
  } catch {
    return typeof value;
  }
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : show(error);
}

// A YAML message can quote the source it choked on, line breaks included.
function onOneLine(message: string): string {
  return message.replace(/\s+/g, " ").trim();
}

// The frontmatter block and the body after it, or null when the file does not open with a fenced
// block. Both fences take trailing spaces and tabs. The body is everything after the closing
// fence, byte for byte: the file is installed as it was authored, so nothing here may normalize it.
export function splitFrontmatter(text: string): { yaml: string; body: string } | null {
  const source = text.startsWith("\uFEFF") ? text.slice(1) : text;
  const open = /^---[ \t]*\r?\n/.exec(source);
  if (open === null) return null;
  const rest = source.slice(open[0].length);
  const close = /^---[ \t]*(\r?\n|$)/m.exec(rest);
  if (close === null) return null;
  return {
    yaml: rest.slice(0, close.index),
    body: rest.slice(close.index + close[0].length),
  };
}

export type HiddenCodePointKind = "zero-width" | "bidi" | "control" | "ansi";

export type HiddenCharacter =
  | { kind: HiddenCodePointKind; codePoint: number; index: number }
  | { kind: "html-comment"; index: number };

const ZERO_WIDTH = new Set([0x200b, 0x200c, 0x200d, 0x2060, 0xfeff]);
const HIDDEN_LABELS = new Map<number, string>([
  [0x200b, "zero-width space"],
  [0x200c, "zero-width non-joiner"],
  [0x200d, "zero-width joiner"],
  [0x2060, "word joiner"],
  [0xfeff, "byte order mark"],
]);

// The label a hidden character is reported under, by `add` and `lint` alike.
export function hiddenCharacterLabel(hidden: HiddenCharacter): string {
  if (hidden.kind === "html-comment") return "an HTML comment";
  const hex = `U+${hidden.codePoint.toString(16).toUpperCase().padStart(4, "0")}`;
  return `${hex} ${HIDDEN_LABELS.get(hidden.codePoint) ?? `${hidden.kind} character`}`;
}

// The Bidi_Control marks outside the two embedding ranges: ALM, LRM and RLM.
const BIDI_MARKS = new Set([0x061c, 0x200e, 0x200f]);

// A description reaches the always-loaded layer of every session, so text that renders as nothing
// (or reorders what renders) is where an injected instruction would hide. This only REPORTS; the
// caller decides whether to refuse, since the contract is a parser, not a policy. It runs over
// whole files too, so the three whitespace controls a file is made of (tab, LF, CR) are text.
export function hiddenCharacters(text: string): HiddenCharacter[] {
  const found: HiddenCharacter[] = [];
  let index = 0;
  for (const char of text) {
    const codePoint = char.codePointAt(0) ?? 0;
    const kind = classify(codePoint);
    if (kind !== null) found.push({ kind, codePoint, index });
    if (char === "<" && text.startsWith("<!--", index)) found.push({ kind: "html-comment", index });
    index += char.length;
  }
  return found;
}

function classify(codePoint: number): HiddenCodePointKind | null {
  if (ZERO_WIDTH.has(codePoint)) return "zero-width";
  if (BIDI_MARKS.has(codePoint)) return "bidi";
  if (
    (codePoint >= 0x202a && codePoint <= 0x202e) ||
    (codePoint >= 0x2066 && codePoint <= 0x2069)
  ) {
    return "bidi";
  }
  if (codePoint === 0x1b) return "ansi";
  if (codePoint === 0x09 || codePoint === 0x0a || codePoint === 0x0d) return null;
  if (codePoint < 0x20 || (codePoint >= 0x7f && codePoint <= 0x9f)) return "control";
  return null;
}
