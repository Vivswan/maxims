import { basename } from "node:path";
import { parse as parseYaml } from "yaml";
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

// A name reaches disk as `<name>.md` inside a directory, so the grammar admits nothing a path
// builder could misread: no separators, no dots, no case to fold. The length cap keeps the
// filename under every common filesystem's 255-byte limit with room for the extension.
export const MEMORY_NAME_PATTERN = /^[a-z0-9]+(-[a-z0-9]+)*$/;
export const MEMORY_NAME_MAX_LENGTH = 200;

export function parseMemoryName(candidate: string): MemoryName | null {
  if (candidate.length > MEMORY_NAME_MAX_LENGTH || !MEMORY_NAME_PATTERN.test(candidate))
    return null;
  return candidate as MemoryName;
}

export const MEMORY_TYPES = ["user", "feedback", "project", "reference"] as const;
export type MemoryType = (typeof MEMORY_TYPES)[number];

export const RESERVED_FILES: ReadonlySet<string> = new Set(["MEMORY.md"]);

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

// A source file can carry anything YAML can express, and a file that fails the contract is
// skipped with a reason, never fatal; the outer catch makes that promise hold for inputs the
// row-by-row checks did not anticipate.
export function parseMemory(filename: string, text: string): ParsedMemory {
  try {
    return parseMemoryChecked(filename, text);
  } catch (error) {
    return { ok: false, reason: `unreadable memory file: ${describe(error)}` };
  }
}

function parseMemoryChecked(filename: string, text: string): ParsedMemory {
  const file = basename(filename);
  if (RESERVED_FILES.has(file)) return { ok: false, reason: `${file} is reserved` };
  if (!file.endsWith(".md")) return { ok: false, reason: `${file} is not a .md file` };
  const stem = file.slice(0, -".md".length);
  const name = parseMemoryName(stem);
  if (name === null) return { ok: false, reason: `filename stem "${stem}" is not kebab-case` };

  const split = splitFrontmatter(text);
  if (split === null) return { ok: false, reason: "missing frontmatter" };
  let frontmatter: unknown;
  try {
    frontmatter = parseYaml(split.yaml);
  } catch (error) {
    return { ok: false, reason: `frontmatter is not valid YAML: ${describe(error)}` };
  }
  if (!isRecord(frontmatter)) return { ok: false, reason: "frontmatter is not a mapping" };

  if (frontmatter.name !== name) {
    return {
      ok: false,
      reason: `name ${show(frontmatter.name)} does not equal filename stem "${stem}"`,
    };
  }
  const description = frontmatter.description;
  if (typeof description !== "string" || description.trim() === "") {
    return { ok: false, reason: "description is missing or empty" };
  }
  if (/[\r\n]/.test(description.trim()))
    return { ok: false, reason: "description spans several lines" };

  const metadata = readMetadata(frontmatter.metadata);
  if (!metadata.ok) return metadata;

  const memory: Memory = {
    name,
    description: description.trim(),
    body: split.body,
    metadata: metadata.metadata,
    raw: text,
    contentHash: contentHashOf(text),
  };
  return metadata.warning === undefined
    ? { ok: true, memory }
    : { ok: true, memory, warning: metadata.warning };
}

type ReadMetadata =
  | { ok: true; metadata: MemoryMetadata; warning?: string }
  | { ok: false; reason: string };

function readMetadata(value: unknown): ReadMetadata {
  if (value === undefined || value === null) return { ok: true, metadata: { extra: {} } };
  if (!isRecord(value)) return { ok: false, reason: "metadata is not a mapping" };
  const { node_type: nodeType, type, scope, internal, ...extra } = value;
  if (nodeType !== undefined && nodeType !== "memory") {
    return { ok: false, reason: `metadata.node_type is ${show(nodeType)}, expected "memory"` };
  }
  const metadata: MemoryMetadata = { extra };
  if (nodeType === "memory") metadata.nodeType = "memory";
  if (typeof scope === "string") metadata.scope = scope;
  else if (scope !== undefined) extra.scope = scope;
  const warnings: string[] = [];
  if (type !== undefined) {
    if (isMemoryType(type)) metadata.type = type;
    else {
      extra.type = type;
      warnings.push(`metadata.type ${show(type)} is not one of ${MEMORY_TYPES.join(", ")}`);
    }
  }
  if (internal !== undefined) {
    if (typeof internal === "boolean") metadata.internal = internal;
    else {
      extra.internal = internal;
      warnings.push(`metadata.internal ${show(internal)} is not a boolean`);
    }
  }
  return warnings.length === 0
    ? { ok: true, metadata }
    : { ok: true, metadata, warning: warnings.join("; ") };
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

// The body is everything after the closing fence, byte for byte: the file is installed as it was
// authored, so nothing here may normalize it.
function splitFrontmatter(text: string): { yaml: string; body: string } | null {
  const source = text.startsWith("\uFEFF") ? text.slice(1) : text;
  const open = /^---\r?\n/.exec(source);
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
// The Bidi_Control marks outside the two embedding ranges: ALM, LRM and RLM.
const BIDI_MARKS = new Set([0x061c, 0x200e, 0x200f]);

// A description reaches the always-loaded layer of every session, so text that renders as nothing
// (or reorders what renders) is where an injected instruction would hide. This only REPORTS; the
// caller decides whether to refuse, since the contract is a parser, not a policy.
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
  if (codePoint === 0x09) return null;
  if (codePoint < 0x20 || (codePoint >= 0x7f && codePoint <= 0x9f)) return "control";
  return null;
}
