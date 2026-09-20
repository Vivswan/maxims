import { basename } from "node:path";
import { parse as parseYaml } from "yaml";

declare const memoryNameBrand: unique symbol;

export type MemoryName = string & { readonly [memoryNameBrand]: true };

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
  extra: Record<string, unknown>;
};

export type Memory = {
  name: MemoryName;
  description: string;
  body: string;
  metadata: MemoryMetadata;
  raw: string;
};

export type ParsedMemory =
  | { ok: true; memory: Memory; warning?: string }
  | { ok: false; reason: string };

export function parseMemory(filename: string, text: string): ParsedMemory {
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
    return { ok: false, reason: `frontmatter is not valid YAML: ${(error as Error).message}` };
  }
  if (!isRecord(frontmatter)) return { ok: false, reason: "frontmatter is not a mapping" };

  if (frontmatter.name !== name) {
    return {
      ok: false,
      reason: `name "${String(frontmatter.name)}" does not equal filename stem "${stem}"`,
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
  const { node_type: nodeType, type, scope, ...extra } = value;
  if (nodeType !== undefined && nodeType !== "memory") {
    return { ok: false, reason: `metadata.node_type is "${String(nodeType)}", expected "memory"` };
  }
  const metadata: MemoryMetadata = { extra };
  if (nodeType === "memory") metadata.nodeType = "memory";
  if (typeof scope === "string") metadata.scope = scope;
  else if (scope !== undefined) extra.scope = scope;
  let warning: string | undefined;
  if (type !== undefined) {
    if (isMemoryType(type)) metadata.type = type;
    else {
      extra.type = type;
      warning = `metadata.type "${String(type)}" is not one of ${MEMORY_TYPES.join(", ")}`;
    }
  }
  return warning === undefined ? { ok: true, metadata } : { ok: true, metadata, warning };
}

function isMemoryType(value: unknown): value is MemoryType {
  return typeof value === "string" && (MEMORY_TYPES as readonly string[]).includes(value);
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
