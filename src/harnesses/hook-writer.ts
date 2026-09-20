import { readFile } from "node:fs/promises";
import { isDeepStrictEqual } from "node:util";
import {
  createScanner,
  findNodeAtLocation,
  getNodePath,
  getNodeValue,
  type Node,
  type ParseError,
  parseTree,
} from "jsonc-parser";
import { parse as parseToml } from "smol-toml";
import type { Change } from "../util/change.ts";
import { ExitCode, MaximsError } from "../util/exit-codes.ts";
import { assertInsideRoot, type RootedPath } from "../util/fs.ts";
import {
  type ConfigFormat,
  type HarnessContext,
  type HarnessDefinition,
  HOOK_COMMAND_PREFIX,
  type HookShape,
  hookSpecFor,
  type RegistryHook,
  type Scope,
  scopeRoot,
} from "./contract.ts";

export type HookPlan = {
  changes: Change[];
  notice?: string;
};

export type FileHook = Extract<HookShape, { kind: "file" }>;

export type HarnessWithHook<K extends HookShape["kind"]> = HarnessDefinition & {
  hook: Extract<HookShape, { kind: K }>;
};

export function hasHook<K extends HookShape["kind"]>(
  def: HarnessDefinition,
  kind: K,
): def is HarnessWithHook<K> {
  return def.hook.kind === kind;
}

type HookIntent = {
  scope: Scope;
  ctx: HarnessContext;
  wanted: boolean;
};

// Reads the registry or artifact the shape names and hands the text to the pure planner, so the
// same planner serves a dry run over fixture text and a real sync over the user's file. A
// definition's config edit rides along with the same `wanted`, so the rules directory it lists
// and the hook that refreshes it appear and leave together.
export async function planHookWrite(
  input: HookIntent & { def: HarnessDefinition },
): Promise<HookPlan> {
  const { def, ...intent } = input;
  const hook = await planHookOnly(def, intent);
  const config = (await def.configEdit?.(intent.scope, intent.ctx, intent.wanted)) ?? [];
  return { changes: [...hook.changes, ...config], notice: hook.notice };
}

async function planHookOnly(def: HarnessDefinition, intent: HookIntent): Promise<HookPlan> {
  if (hasHook(def, "registry")) {
    const path = hookPath(def, def.hook, intent);
    return planHookRegistryWrite({ def, ...intent, currentText: await readCurrent(path) });
  }
  if (hasHook(def, "file")) {
    const path = hookPath(def, def.hook, intent);
    return planFileHookWrite({ def, ...intent, currentText: await readCurrent(path) });
  }
  if (hasHook(def, "custom")) {
    const spec = hookSpecFor(def);
    return { changes: await def.hook.reconcile(intent.scope, intent.ctx, spec, intent.wanted) };
  }
  return { changes: [] };
}

export type RegistryWriteInput = HookIntent & {
  def: HarnessWithHook<"registry">;
  currentText: string | null;
};

export function planHookRegistryWrite(input: RegistryWriteInput): HookPlan {
  const path = hookPath(input.def, input.def.hook, input);
  if (input.def.hook.format === "toml") {
    throw new MaximsError(
      ExitCode.DestinationWriteFailed,
      `cannot register the ${input.def.displayName} hook: TOML registries are read, never written`,
      { hint: `register a JSON hooks file instead of ${path}` },
    );
  }
  const handler = input.def.hook.handler(hookSpecFor(input.def));
  if (input.currentText === null) {
    if (!input.wanted) return { changes: [] };
    const content = freshRegistry(input.def.hook, handler, "\n");
    return {
      changes: [{ kind: "write", path, content }],
      notice: `registered the maxims hook in ${path}`,
    };
  }
  const registry = new JsonRegistry(input.def.hook, path, input.currentText);
  if (input.wanted) {
    if (registry.locateOurs().length === 0) {
      registry.append(handler);
      return { changes: [registry.write()], notice: `registered the maxims hook in ${path}` };
    }
    const duplicates = registry.dropDuplicates();
    const [ours] = registry.locateOurs();
    if (ours === undefined) throw new Error("the surviving maxims handler must still be present");
    if (sameJson(getNodeValue(ours), handler)) {
      if (!duplicates) return { changes: [] };
      return { changes: [registry.write()], notice: `removed duplicate maxims hooks from ${path}` };
    }
    registry.replace(ours, handler);
    return { changes: [registry.write()], notice: `updated the maxims hook in ${path}` };
  }
  if (registry.locateOurs().length === 0) return { changes: [] };
  registry.removeAll();
  return { changes: [registry.finish()], notice: `removed the maxims hook from ${path}` };
}

function freshRegistry(hook: RegistryHook, handler: Record<string, unknown>, eol: string): string {
  const root: Record<string, unknown> = { ...hook.wrapper };
  let container = root;
  for (const key of hook.eventPath.slice(0, -1)) {
    const next: Record<string, unknown> = {};
    container[key] = next;
    container = next;
  }
  const event = hook.eventPath[hook.eventPath.length - 1];
  if (event !== undefined) container[event] = [hook.grouped ? { hooks: [handler] } : handler];
  return `${pretty(root, "", eol)}${eol}`;
}

// Edits are byte-range splices on the user's own text, located through the jsonc-parser tree:
// only our node and the separator joining it to a neighbour ever change, so the rest of the file,
// comments and irregular spacing included, comes back byte-identical after add then remove.
// jsonc-parser's `modify` is not used because it reformats every line an edit touches, and a
// compact user file does not survive that.
class JsonRegistry {
  private text: string;
  private readonly eol: string;

  constructor(
    private readonly hook: RegistryHook,
    private readonly path: RootedPath,
    currentText: string,
  ) {
    this.text = currentText;
    this.eol = currentText.includes("\r\n") ? "\r\n" : "\n";
    this.eventArray();
  }

  locateOurs(): Node[] {
    const event = this.eventArray();
    if (event === undefined) return [];
    const handlers = this.hook.grouped
      ? (event.children ?? []).flatMap((group) => {
          const list = findNodeAtLocation(group, ["hooks"]);
          return list?.type === "array" ? (list.children ?? []) : [];
        })
      : (event.children ?? []);
    return handlers.filter((handler) => {
      const command = findNodeAtLocation(handler, [this.hook.commandKey]);
      const value: unknown = command?.type === "string" ? command.value : undefined;
      return typeof value === "string" && value.startsWith(HOOK_COMMAND_PREFIX);
    });
  }

  // Every removal shifts the offsets after it, so each pass re-parses and takes one node.
  removeAll(): void {
    for (let [ours] = this.locateOurs(); ours !== undefined; [ours] = this.locateOurs()) {
      this.remove(ours);
    }
  }

  dropDuplicates(): boolean {
    let dropped = false;
    for (let [, extra] = this.locateOurs(); extra !== undefined; [, extra] = this.locateOurs()) {
      this.remove(extra);
      dropped = true;
    }
    return dropped;
  }

  replace(node: Node, handler: Record<string, unknown>): void {
    const indent = lineIndent(this.text, node.offset);
    this.splice(node.offset, node.length, pretty(handler, indent, this.eol));
  }

  append(handler: Record<string, unknown>): void {
    const entry = this.hook.grouped ? { hooks: [handler] } : handler;
    const event = this.eventArray();
    if (event !== undefined) {
      this.appendElement(event, entry);
      return;
    }
    let depth = this.hook.eventPath.length - 1;
    let container: Node | undefined;
    for (; depth > 0; depth -= 1) {
      container = findNodeAtLocation(this.root(), this.hook.eventPath.slice(0, depth));
      if (container !== undefined) break;
    }
    const [key, ...nested] = this.hook.eventPath.slice(depth);
    if (key === undefined) throw this.refuse("the hook declares no event path");
    const value = nested.reduceRight<unknown>((inner, name) => ({ [name]: inner }), [entry]);
    this.appendProperty(container ?? this.root(), key, value);
  }

  // Removal climbs to the highest ancestor our handler alone kept alive (a matcher group whose
  // list emptied, then the event list) and cuts it there; the object holding the events stays,
  // emptied if need be, because nothing tells a `hooks: {}` the user wrote from one we added.
  // Anything a user wrote in a container, a comment above all, pins that container: the climb
  // stops below it and only our node leaves.
  remove(node: Node): void {
    let target = node;
    for (;;) {
      const parent = target.parent;
      if (parent === undefined) {
        this.emptyContainer(target);
        return;
      }
      if (
        parent.type === "object" &&
        isDeepStrictEqual(getNodePath(parent), this.hook.eventPath.slice(0, -1))
      ) {
        this.cut(parent, target);
        return;
      }
      const clean = this.commentFree(parent);
      if (parent.type === "property") {
        if (clean) {
          target = parent;
          continue;
        }
        this.emptyContainer(target);
        return;
      }
      if (clean && (this.isGroup(parent) || parent.children?.length === 1)) {
        target = parent;
        continue;
      }
      const value = target.children?.[1];
      if (this.isGroup(parent) && target.type === "property" && value !== undefined) {
        this.emptyContainer(value);
        return;
      }
      this.cut(parent, target);
      return;
    }
  }

  // A file left holding nothing but its wrapper and empty containers is deleted.
  finish(): Change {
    const root = this.root();
    const remaining = withoutEmptyContainers(getNodeValue(root), this.hook.eventPath.slice(0, -1));
    if (this.commentFree(root) && sameJson(remaining, this.hook.wrapper ?? {})) {
      return { kind: "delete", path: this.path };
    }
    return this.write();
  }

  write(): Change {
    return { kind: "write", path: this.path, content: this.text };
  }

  private isGroup(node: Node): boolean {
    if (!this.hook.grouped || node.type !== "object" || node.parent === undefined) return false;
    return isDeepStrictEqual(getNodePath(node.parent), this.hook.eventPath);
  }

  // No comment anywhere in the node's text, children included; the root is judged over the whole
  // file so a header comment above the opening brace counts too.
  private commentFree(node: Node): boolean {
    const [start, end] =
      node.parent === undefined ? [0, this.text.length] : [node.offset, node.offset + node.length];
    const region = this.text.slice(start, end);
    const scanner = createScanner(region, false);
    while (scanner.getPosition() < region.length) {
      scanner.scan();
      if (region[scanner.getTokenOffset()] === "/") return false;
    }
    return true;
  }

  private emptyContainer(node: Node): void {
    this.splice(node.offset + 1, node.length - 2, "");
  }

  private eventArray(): Node | undefined {
    const root = this.root();
    const last = this.hook.eventPath.length;
    for (let depth = 1; depth <= last; depth += 1) {
      const prefix = this.hook.eventPath.slice(0, depth);
      const node = findNodeAtLocation(root, prefix);
      if (node === undefined) return undefined;
      const expected = depth === last ? "array" : "object";
      if (node.type !== expected) throw this.refuse(`${prefix.join(".")} is not a ${expected}`);
      if (depth === last) return node;
    }
    return undefined;
  }

  private appendElement(list: Node, value: unknown): void {
    const last = list.children?.[list.children.length - 1];
    if (last === undefined) {
      this.fill(list, (indent) => pretty(value, indent, this.eol));
      return;
    }
    const indent = lineIndent(this.text, last.offset);
    const body = pretty(value, indent, this.eol);
    this.splice(last.offset + last.length, 0, `,${this.eol}${indent}${body}`);
  }

  private appendProperty(object: Node, key: string, value: unknown): void {
    const last = object.children?.[object.children.length - 1];
    const member = (indent: string) => `${JSON.stringify(key)}: ${pretty(value, indent, this.eol)}`;
    if (last === undefined) {
      this.fill(object, member);
      return;
    }
    const indent = lineIndent(this.text, last.offset);
    this.splice(last.offset + last.length, 0, `,${this.eol}${indent}${member(indent)}`);
  }

  // An empty container keeps whatever sits between its brackets, a comment included: the entry
  // goes in before the closing bracket's own whitespace rather than over the whole node.
  private fill(container: Node, render: (indent: string) => string): void {
    const indent = lineIndent(this.text, container.offset);
    const closing = this.closingOf(container);
    const at = this.whitespaceStart(closing);
    const tail = at === closing ? `${this.eol}${indent}` : this.eol;
    this.splice(at, 0, `${this.eol}${indent}  ${render(`${indent}  `)}${tail}`);
  }

  // Only the node and the one comma that joined it go. When nothing but whitespace sits between
  // that comma and the node the whole run goes too, which is the exact inverse of an append; a
  // comment in the gap stays, and a line comment keeps the line break that ends it.
  private cut(container: Node, target: Node): void {
    const siblings = container.children ?? [];
    const index = siblings.indexOf(target);
    const previous = siblings[index - 1];
    const next = siblings[index + 1];
    const end = target.offset + target.length;
    if (next !== undefined) {
      const comma = this.commaBetween(end, next.offset);
      if (comma === undefined) {
        this.splice(target.offset, end - target.offset, "");
      } else if (this.whitespaceOnly(end, comma)) {
        this.splice(target.offset, this.whitespaceEnd(comma + 1) - target.offset, "");
      } else {
        this.splice(comma, 1, "");
        this.splice(target.offset, end - target.offset, "");
      }
      return;
    }
    if (previous !== undefined) {
      const comma = this.commaBetween(previous.offset + previous.length, target.offset);
      if (comma !== undefined && this.whitespaceOnly(comma + 1, target.offset)) {
        this.splice(comma, end - comma, "");
        return;
      }
      const start = this.leadStart(target.offset);
      const stop =
        start === this.whitespaceStart(target.offset) ? end : this.throughFirstLineBreak(end);
      this.splice(start, stop - start, "");
      if (comma !== undefined) this.splice(comma, 1, "");
      return;
    }
    if (this.commentFree(container)) {
      this.emptyContainer(container);
      return;
    }
    const comma = this.commaBetween(end, this.closingOf(container));
    const tailFrom = comma !== undefined && this.whitespaceOnly(end, comma) ? comma + 1 : end;
    const stop = this.throughFirstLineBreak(tailFrom);
    const start = this.leadStart(target.offset);
    if (comma !== undefined && tailFrom === end) this.splice(comma, 1, "");
    this.splice(start, stop - start, "");
  }

  // The separator between two siblings is one comma, possibly among comments; the scanner walks
  // the gap so a comma inside a comment is never mistaken for it.
  private commaBetween(from: number, to: number): number | undefined {
    const gap = this.text.slice(from, to);
    const scanner = createScanner(gap, false);
    while (scanner.getPosition() < gap.length) {
      scanner.scan();
      const at = scanner.getTokenOffset();
      if (gap[at] === "," && scanner.getTokenLength() === 1) return from + at;
    }
    return undefined;
  }

  private closingOf(container: Node): number {
    return container.offset + container.length - 1;
  }

  private whitespaceOnly(from: number, to: number): boolean {
    return this.text.slice(from, to).trim() === "";
  }

  private whitespaceStart(offset: number): number {
    let start = offset;
    while (start > 0 && isWhitespace(this.text[start - 1])) start -= 1;
    return start;
  }

  private whitespaceEnd(offset: number): number {
    let end = offset;
    while (end < this.text.length && isWhitespace(this.text[end])) end += 1;
    return end;
  }

  // The whitespace run leading into a node, except the line break that terminates a `//`
  // comment on the line before it: taking that break would swallow the rest of the line.
  private leadStart(offset: number): number {
    const start = this.whitespaceStart(offset);
    const lineStart = this.text.lastIndexOf("\n", start - 1) + 1;
    if (!this.text.slice(lineStart, start).includes("//")) return start;
    const lineBreak = this.text.indexOf("\n", start);
    return lineBreak === -1 || lineBreak >= offset ? start : lineBreak + 1;
  }

  private throughFirstLineBreak(offset: number): number {
    const end = this.whitespaceEnd(offset);
    const lineBreak = this.text.indexOf("\n", offset);
    return lineBreak === -1 || lineBreak >= end ? offset : lineBreak + 1;
  }

  private splice(offset: number, length: number, content: string): void {
    this.text = `${this.text.slice(0, offset)}${content}${this.text.slice(offset + length)}`;
  }

  private root(): Node {
    const errors: ParseError[] = [];
    const root = parseTree(this.text, errors, { allowTrailingComma: true });
    if (errors.length > 0 || root === undefined) throw this.refuse("it is not valid JSON");
    if (root.type !== "object") throw this.refuse("its top level is not an object");
    return root;
  }

  private refuse(reason: string): MaximsError {
    return new MaximsError(ExitCode.DestinationWriteFailed, `cannot edit ${this.path}: ${reason}`, {
      hint: "fix the file by hand, then run maxims sync",
    });
  }
}

function isWhitespace(char: string | undefined): boolean {
  return char === " " || char === "\t" || char === "\n" || char === "\r";
}

function pretty(value: unknown, indent: string, eol: string): string {
  return JSON.stringify(value, null, 2).split("\n").join(`${eol}${indent}`);
}

function lineIndent(text: string, offset: number): string {
  let start = offset;
  while (start > 0 && text[start - 1] !== "\n") start -= 1;
  return /^[ \t]*/.exec(text.slice(start, offset))?.[0] ?? "";
}

export type FileHookWriteInput = HookIntent & {
  def: HarnessWithHook<"file">;
  currentText: string | null;
};

export function planFileHookWrite(input: FileHookWriteInput): HookPlan {
  const path = hookPath(input.def, input.def.hook, input);
  if (!input.wanted) {
    return { changes: input.currentText === null ? [] : [{ kind: "delete", path }] };
  }
  const content = input.def.hook.render(hookSpecFor(input.def));
  if (content === input.currentText) return { changes: [] };
  const change: Change = input.def.hook.executable
    ? { kind: "write", path, content, mode: 0o755 }
    : { kind: "write", path, content };
  return { changes: [change], notice: `wrote the maxims hook to ${path}` };
}

// The tier a harness reaches on this machine: a definition's own probe wins, then a declared
// config flag holding its demoting value demotes to 2, else the declared tier. A missing or
// unreadable config means the harness runs on its defaults, which the declaration already
// accounts for.
export async function achievedTier(
  def: HarnessDefinition,
  scope: Scope,
  ctx: HarnessContext,
): Promise<1 | 2> {
  if (def.achievedTier !== undefined) return def.achievedTier(ctx);
  if (!hasHook(def, "registry") || def.hook.tierCheck === undefined) return def.tier;
  const check = def.hook.tierCheck;
  const text = await readFile(check.path(scope, ctx), "utf8").catch(() => null);
  if (text === null) return def.tier;
  const config = parseConfig(text, check.format);
  if (config === undefined) return def.tier;
  const value = valueAt(config, check.key.split("."));
  if (value !== undefined && sameJson(value, check.demotesWhen)) return 2;
  return def.tier;
}

function parseConfig(text: string, format: ConfigFormat): unknown {
  try {
    if (format === "toml") return parseToml(text);
    const errors: ParseError[] = [];
    const root = parseTree(text, errors, { allowTrailingComma: true });
    return errors.length > 0 || root === undefined ? undefined : getNodeValue(root);
  } catch {
    return undefined;
  }
}

function valueAt(value: unknown, path: string[]): unknown {
  let current = value;
  for (const key of path) {
    if (!isRecord(current)) return undefined;
    current = current[key];
  }
  return current;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hookPath(
  def: Pick<HarnessDefinition, "globalRoot">,
  hook: RegistryHook | FileHook,
  intent: Pick<HookIntent, "scope" | "ctx">,
): RootedPath {
  return assertInsideRoot(
    scopeRoot(def, intent.scope, intent.ctx),
    hook.path(intent.scope, intent.ctx),
  );
}

async function readCurrent(path: string): Promise<string | null> {
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

// jsonc-parser builds objects with a null prototype and smol-toml returns its own date type; a
// JSON round trip puts both sides on plain objects before the structural comparison.
function sameJson(left: unknown, right: unknown): boolean {
  return isDeepStrictEqual(JSON.parse(JSON.stringify(left)), JSON.parse(JSON.stringify(right)));
}

// The containers above the event (`hooks` on Claude Code) stay behind emptied, so a file is judged
// against its wrapper with those empty objects dropped along the event path.
function withoutEmptyContainers(value: unknown, path: string[]): unknown {
  if (!isRecord(value)) return value;
  const copy: Record<string, unknown> = { ...value };
  const [head, ...rest] = path;
  if (head === undefined) return copy;
  const inner = withoutEmptyContainers(copy[head], rest);
  if (isRecord(inner) && Object.keys(inner).length === 0) delete copy[head];
  else if (inner !== undefined) copy[head] = inner;
  return copy;
}
