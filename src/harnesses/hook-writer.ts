import { readFile, stat } from "node:fs/promises";
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
  appendChild,
  assertParses,
  readConfigText,
  removeChild,
  replaceValue,
} from "../util/jsonc.ts";
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

// The definition's config edit rides along with the same `wanted`, so the rules directory it lists
// and the hook that refreshes it appear and leave together.
export async function planHookWrite(
  input: HookIntent & { def: HarnessDefinition },
): Promise<HookPlan> {
  const hook = await planHookOnly(input);
  const config = (await input.def.configEdit?.(input.scope, input.ctx, input.wanted)) ?? [];
  return { changes: [...hook.changes, ...config], notice: hook.notice };
}

// Reads the registry or artifact the shape names and hands the text to the pure planner, so the
// same planner serves a dry run over fixture text and a real sync over the user's file. Only the
// hook artifact is planned here: an empty plan means the hook itself is current.
export async function planHookOnly(
  input: HookIntent & { def: HarnessDefinition },
): Promise<HookPlan> {
  const { def, ...intent } = input;
  if (hasHook(def, "registry")) {
    const path = hookPath(def, intent.scope, intent.ctx);
    return planHookRegistryWrite({ def, ...intent, currentText: await readConfigText(path) });
  }
  if (hasHook(def, "file")) {
    const path = hookPath(def, intent.scope, intent.ctx);
    return planFileHookWrite({ def, ...intent, current: await readFileState(path) });
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
  const path = hookPath(input.def, input.scope, input.ctx);
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
    const content = freshRegistry(input.def.hook, handler);
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

function freshRegistry(hook: RegistryHook, handler: Record<string, unknown>): string {
  const root: Record<string, unknown> = { ...hook.wrapper };
  let container = root;
  for (const key of hook.eventPath.slice(0, -1)) {
    const next: Record<string, unknown> = {};
    container[key] = next;
    container = next;
  }
  const event = hook.eventPath[hook.eventPath.length - 1];
  if (event !== undefined) container[event] = [hook.grouped ? { hooks: [handler] } : handler];
  return `${JSON.stringify(root, null, 2)}\n`;
}

// The registry policy over the splices in src/util/jsonc.ts: which entries are ours, where a new
// one goes, and how far a removal climbs. Every splice invalidates the tree, so each step
// re-parses the text it holds.
class JsonRegistry {
  private text: string;

  constructor(
    private readonly hook: RegistryHook,
    private readonly path: RootedPath,
    currentText: string,
  ) {
    this.text = currentText;
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
      return typeof value === "string" && isOurCommand(value);
    });
  }

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
    this.text = replaceValue(this.text, node, handler);
  }

  // The deepest existing level of the event path receives the rest nested inside it, so the
  // removal climb later finds one lineage to cut. Wrapper keys the file lacks go in first, so a
  // registry emptied by a removal comes back as the fresh one; a key the user already set keeps
  // its value.
  append(handler: Record<string, unknown>): void {
    for (const [key, value] of Object.entries(this.hook.wrapper ?? {})) {
      if (findNodeAtLocation(this.root(), [key]) !== undefined) continue;
      this.text = appendChild(this.text, this.root(), key, value);
    }
    const entry = this.hook.grouped ? { hooks: [handler] } : handler;
    const event = this.eventArray();
    if (event !== undefined) {
      this.text = appendChild(this.text, event, null, entry);
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
    this.text = appendChild(this.text, container ?? this.root(), key, value);
  }

  // Removal climbs to the highest ancestor our handler alone kept alive (a matcher group whose
  // list emptied, then the event list) and cuts it there; the object holding the events stays,
  // emptied if need be, because nothing tells a `hooks: {}` the user wrote from one we added.
  // Anything a user wrote in a container, a comment above all, pins that container: the climb
  // stops below it and only our lineage leaves.
  remove(node: Node): void {
    let target = node;
    for (;;) {
      const parent = parentOf(target);
      if (parent.type === "object" && this.holdsEvents(parent)) {
        this.text = removeChild(this.text, parent, target);
        return;
      }
      const clean = this.commentFree(parent);
      if (parent.type === "property") {
        if (clean) {
          target = parent;
          continue;
        }
        this.text = removeChild(this.text, target, onlyChild(target));
        return;
      }
      if (clean && (this.isGroup(parent) || parent.children?.length === 1)) {
        target = parent;
        continue;
      }
      const value = target.children?.[1];
      if (this.isGroup(parent) && target.type === "property" && value !== undefined) {
        this.text = removeChild(this.text, value, onlyChild(value));
        return;
      }
      this.text = removeChild(this.text, parent, target);
      return;
    }
  }

  // A file left holding nothing but its wrapper and empty containers becomes an empty object with
  // its own line ending, never a deletion: nothing records whether the file existed before the
  // hook was registered, and an empty object is harmless to every harness.
  finish(): Change {
    const root = this.root();
    const remaining = withoutEmptyContainers(getNodeValue(root), this.hook.eventPath.slice(0, -1));
    if (this.commentFree(root) && sameJson(remaining, this.hook.wrapper ?? {})) {
      const eol = this.text.endsWith("\r\n") ? "\r\n" : this.text.endsWith("\n") ? "\n" : "";
      return { kind: "write", path: this.path, content: `{}${eol}` };
    }
    return this.write();
  }

  write(): Change {
    this.root();
    return { kind: "write", path: this.path, content: this.text };
  }

  private holdsEvents(node: Node): boolean {
    return isDeepStrictEqual(getNodePath(node), this.hook.eventPath.slice(0, -1));
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

  private root(): Node {
    return assertParses(this.text, this.path);
  }

  private refuse(reason: string): MaximsError {
    return new MaximsError(ExitCode.DestinationWriteFailed, `cannot edit ${this.path}: ${reason}`, {
      hint: "fix the file by hand, then run maxims sync",
    });
  }
}

// Our handlers are found inside the event list, so every node the climb visits below the object
// holding the events has a parent; the containers it empties were climbed into through their
// single child.
function parentOf(node: Node): Node {
  if (node.parent === undefined) throw new Error("the climb reached the root of the registry");
  return node.parent;
}

function onlyChild(node: Node): Node {
  const [child, ...rest] = node.children ?? [];
  if (child === undefined || rest.length > 0) {
    throw new Error("the container being emptied holds exactly one member");
  }
  return child;
}

// The bytes and the permission bits of the artifact at the hook path; the mode travels with the
// text because a hook the harness cannot execute is as absent as one with the wrong content.
export type FileState = { text: string; mode: number };

export type FileHookWriteInput = HookIntent & {
  def: HarnessWithHook<"file">;
  current: FileState | null;
};

async function readFileState(path: string): Promise<FileState | null> {
  const text = await readConfigText(path);
  if (text === null) return null;
  try {
    return { text, mode: (await stat(path)).mode & 0o7777 };
  } catch (cause) {
    const detail = cause instanceof Error ? cause.message : String(cause);
    throw new MaximsError(ExitCode.DestinationWriteFailed, `cannot inspect ${path}: ${detail}`, {
      cause,
    });
  }
}

export function planFileHookWrite(input: FileHookWriteInput): HookPlan {
  const path = hookPath(input.def, input.scope, input.ctx);
  const current = input.current;
  if (!input.wanted) return { changes: current === null ? [] : [{ kind: "delete", path }] };
  const content = input.def.hook.render(hookSpecFor(input.def));
  const mode = input.def.hook.executable ? 0o755 : undefined;
  const sameText = current !== null && current.text === content;
  if (sameText && (mode === undefined || current.mode === mode)) return { changes: [] };
  const change: Change =
    mode === undefined ? { kind: "write", path, content } : { kind: "write", path, content, mode };
  return {
    changes: [change],
    notice: sameText
      ? `made the maxims hook at ${path} executable again`
      : `wrote the maxims hook to ${path}`,
  };
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

export function hookPath(
  def: HarnessWithHook<"registry"> | HarnessWithHook<"file">,
  scope: Scope,
  ctx: HarnessContext,
): RootedPath {
  return assertInsideRoot(scopeRoot(def, scope, ctx), def.hook.path(scope, ctx));
}

// The prefix is matched as whole words: `npx -y @vivswan/maxims syncthing` is somebody else's
// command, `npx -y @vivswan/maxims sync --quiet --agent x` is an older flag set of ours.
function isOurCommand(command: string): boolean {
  if (!command.startsWith(HOOK_COMMAND_PREFIX)) return false;
  const next = command.charAt(HOOK_COMMAND_PREFIX.length);
  return next === "" || /\s/.test(next);
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
