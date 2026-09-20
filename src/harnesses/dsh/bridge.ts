import { join } from "node:path";
import { type Document, isMap, isNode, isSeq, parseDocument, stringify } from "yaml";
import type { Change } from "../../util/change.ts";
import { ExitCode, MaximsError } from "../../util/exit-codes.ts";
import { assertInsideRoot, type RootedPath } from "../../util/fs.ts";
import { readConfigText } from "../../util/jsonc.ts";
import type { HarnessContext, HookSpec, Scope } from "../contract.ts";

// dsh composes its plugin tree from layered patch files, and the only layer a user owns for every
// profile is `$DSH_HOME/cordis.patch.yml`; it has no per-project config discovery. The bridge
// row mounted there points at a maxims-owned hooks file by ABSOLUTE path because the bridge
// resolves a relative `configPath` from whatever directory launched dsh, and it reads that path
// once at process start, so a running dsh sees a new or changed row only after a restart.
export const BRIDGE_PLUGIN = "@deepseek-ai/dsh-hooks-claude-code";
export const BRIDGE_ROW_ID = "maxims-hooks";

export function dshHome(ctx: HarnessContext): string {
  const override = ctx.env.DSH_HOME;
  return override === undefined || override === "" ? join(ctx.home, ".dsh") : override;
}

export type BridgeFiles = {
  patch: RootedPath;
  hooks: RootedPath;
};

export function bridgeFiles(home: string): BridgeFiles {
  return {
    patch: assertInsideRoot(home, join(home, "cordis.patch.yml")),
    hooks: assertInsideRoot(home, join(home, "maxims-hooks.json")),
  };
}

export function renderHooksFile(spec: HookSpec): string {
  const handler = {
    type: "command",
    command: [spec.command, ...spec.args].join(" "),
    timeout: spec.timeoutSeconds,
  };
  return `${JSON.stringify({ hooks: { SessionStart: [{ hooks: [handler] }] } }, null, 2)}\n`;
}

function bridgeRow(hooksPath: string): Record<string, unknown> {
  return { id: BRIDGE_ROW_ID, name: BRIDGE_PLUGIN, config: { configPath: hooksPath } };
}

// The scope is part of the hook contract but never changes where the bridge lands: dsh reads one
// machine-wide patch layer, so a project install mounts the same row a global one does.
export async function reconcileBridge(
  _scope: Scope,
  ctx: HarnessContext,
  spec: HookSpec,
  wanted: boolean,
): Promise<Change[]> {
  const files = bridgeFiles(dshHome(ctx));
  const text = (await readConfigText(files.patch)) ?? "";
  const next = editPatch(text, files.patch, wanted ? bridgeRow(files.hooks) : null);
  const changes: Change[] = wanted
    ? [{ kind: "write", path: files.hooks, content: renderHooksFile(spec) }]
    : [{ kind: "delete", path: files.hooks }];
  if (next !== text) changes.push({ kind: "write", path: files.patch, content: next });
  return changes;
}

type Span = { start: number; end: number; indent: string };

// The document API is used to FIND our row; the edit itself is a text splice of exactly the bytes
// our own renderer produces, because re-serializing the document would reflow the user's flow
// sequences, comment spacing, and quoting everywhere else in the file. A row that shares its
// `insert` operation with other rows, or whose operation carries other keys (an `id` aiming the
// insert at a group), is replaced or removed alone; a row that is the whole operation takes the
// operation with it. dsh refuses an empty or comments-only patch file and documents `[]` as the
// disabled layer, so that is what an emptied file becomes, and what an append replaces.
function editPatch(text: string, path: string, row: Record<string, unknown> | null): string {
  const doc = parseBlockList(text, path);
  const found = doc === null ? null : findOurRow(text, doc, path);
  let next: string;
  if (found === null) {
    if (row === null) return text;
    const rendered = stringify([{ insert: [row] }]);
    const emptyList = doc === null ? null : emptyListSpan(text, doc);
    if (emptyList === null) {
      const separator = text === "" || text.endsWith("\n") ? "" : "\n";
      next = `${text}${separator}${rendered}`;
    } else {
      next = `${text.slice(0, emptyList.start)}${rendered}${text.slice(emptyList.end)}`;
    }
  } else {
    const { span, wholeOperation } = found;
    const rendered =
      row === null
        ? ""
        : indentBlock(stringify(wholeOperation ? [{ insert: [row] }] : [row]), span.indent);
    next = `${text.slice(0, span.start)}${rendered}${text.slice(span.end)}`;
    if (row === null && parseDocument(next).contents === null) {
      const separator = next === "" || next.endsWith("\n") ? "" : "\n";
      next = `${next}${separator}[]\n`;
    }
  }
  const check = parseBlockList(next, path);
  const present = check !== null && findOurRow(next, check, path) !== null;
  if (present !== (row !== null)) {
    throw new MaximsError(
      ExitCode.DestinationWriteFailed,
      `refusing to write ${path}: the edited patch file would not carry the expected row`,
    );
  }
  return next;
}

// A patch file is empty, the empty list `[]`, or a block sequence at column zero; the splice
// appends a block item, so a non-empty flow sequence, an indented one, or a map root is refused
// rather than corrupted.
function parseBlockList(text: string, path: string): Document | null {
  const doc = parseDocument(text);
  if (doc.errors.length > 0) {
    throw new MaximsError(ExitCode.DestinationWriteFailed, `cannot parse ${path}; left untouched`);
  }
  const contents = doc.contents;
  if (contents === null) return null;
  if (isSeq(contents) && contents.items.length === 0) return doc;
  const first = isSeq(contents) && contents.flow !== true ? contents.items[0] : undefined;
  if (spanOf(text, first)?.indent !== "") {
    throw new MaximsError(
      ExitCode.DestinationWriteFailed,
      `${path} is not a block list of patch operations; left untouched`,
    );
  }
  return doc;
}

function emptyListSpan(text: string, doc: Document): Span | null {
  const contents = doc.contents;
  if (!isSeq(contents) || contents.items.length > 0 || !contents.range) return null;
  const [start, , nodeEnd] = contents.range;
  return { start, end: lineEnd(text, nodeEnd), indent: "" };
}

function findOurRow(
  text: string,
  doc: Document,
  path: string,
): { span: Span; wholeOperation: boolean } | null {
  if (!isSeq(doc.contents)) return null;
  for (const item of doc.contents.items) {
    if (!isMap(item)) continue;
    const inserted = item.get("insert");
    if (!isSeq(inserted)) continue;
    const ours = inserted.items.find((entry) => isMap(entry) && entry.get("id") === BRIDGE_ROW_ID);
    if (ours === undefined) continue;
    const wholeOperation = inserted.items.length === 1 && item.items.length === 1;
    const span = spanOf(text, wholeOperation ? item : ours);
    if (span === null) {
      throw new MaximsError(
        ExitCode.DestinationWriteFailed,
        `cannot locate the maxims row in ${path}; left untouched`,
      );
    }
    return { span, wholeOperation };
  }
  return null;
}

// The span of a block sequence item from its `- ` indicator through its trailing newline; null
// when the node is not laid out as a block item (a flow item, or one sharing a line).
function spanOf(text: string, node: unknown): Span | null {
  if (!isNode(node) || node.range === null || node.range === undefined) return null;
  const [valueStart, , nodeEnd] = node.range;
  const lineStart = text.lastIndexOf("\n", valueStart - 1) + 1;
  const prefix = /^([ \t]*)-[ \t]+$/.exec(text.slice(lineStart, valueStart));
  if (prefix === null) return null;
  return { start: lineStart, end: lineEnd(text, nodeEnd), indent: prefix[1] ?? "" };
}

// A node's reported end sometimes stops before the newline that closes its line, and after a
// trailing comment it runs on into the indentation of the next item; the splice always ends at a
// line start, so no blank line is left behind and no sibling loses its indentation.
function lineEnd(text: string, nodeEnd: number): number {
  if (text[nodeEnd - 1] === "\n") return nodeEnd;
  if (text[nodeEnd] === "\n") return nodeEnd + 1;
  const lineStart = text.lastIndexOf("\n", nodeEnd - 1) + 1;
  return text.slice(lineStart, nodeEnd).trim() === "" ? lineStart : nodeEnd;
}

function indentBlock(block: string, indent: string): string {
  return block
    .split("\n")
    .map((line) => (line === "" ? line : `${indent}${line}`))
    .join("\n");
}
