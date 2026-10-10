import { readFile, stat } from "node:fs/promises";
import { basename } from "node:path";
import { isDeepStrictEqual } from "node:util";
import {
  createScanner,
  findNodeAtLocation,
  getNodePath,
  getNodeValue,
  type Node,
} from "jsonc-parser";
import { parse as parseToml, TomlError } from "smol-toml";
import { util, z } from "zod";
import type { Change } from "../util/change.ts";
import { ExitCode, MaximsError } from "../util/exit-codes.ts";
import { assertInsideRoot, type RootedPath } from "../util/fs.ts";
import { jsonDocument } from "../util/json.ts";
import {
  appendChild,
  assertParses,
  type JsonReader,
  jsonReader,
  parseJsonDocument,
  readConfigText,
  readPresentFile,
  removeChild,
  replaceValue,
} from "../util/jsonc.ts";
import { flattenIssues } from "../util/zod-issues.ts";
import {
  type AchievedTier,
  type ConfigFormat,
  type ConfigLayer,
  type HarnessContext,
  type HarnessDefinition,
  HOOK_COMMAND_PREFIX,
  type HookShape,
  hookSpecFor,
  type ProjectTrust,
  type RegistryHook,
  type Scope,
  scopeRoot,
  type TierLayer,
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
  const handler = input.def.hook.handler(hookSpecFor(input.def));
  if (input.currentText === null) {
    if (!input.wanted) return { changes: [] };
    const content = freshRegistry(input.def.hook, handler);
    return {
      changes: [{ kind: "write", path, content }],
      notice: `registered the maxims hook in ${path}`,
    };
  }
  const registry = new JsonRegistry(input.def.hook, path, input.currentText, input.def.displayName);
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

// The registry file a hook lands in when none exists. A quirk that keeps a registry-shaped file
// of its own (dsh's bridge target) renders it here too, so the shape is written once.
export type RegistryShape = Pick<RegistryHook, "eventPath" | "grouped" | "wrapper">;

export function freshRegistry(hook: RegistryShape, handler: Record<string, unknown>): string {
  const root: Record<string, unknown> = { ...hook.wrapper };
  let container = root;
  for (const key of hook.eventPath.slice(0, -1)) {
    const next: Record<string, unknown> = {};
    container[key] = next;
    container = next;
  }
  const event = hook.eventPath[hook.eventPath.length - 1];
  if (event !== undefined) container[event] = [hook.grouped ? { hooks: [handler] } : handler];
  return jsonDocument(root);
}

// The registry policy over the splices in src/util/jsonc.ts: which entries are ours, where a new
// one goes, and how far a removal climbs. Every splice invalidates the tree, so each step
// re-parses the text it holds, in the dialect the vendor reads: a file the vendor would skip is
// refused at the first parse, before any splice.
class JsonRegistry {
  private text: string;
  private readonly reader: JsonReader;

  constructor(
    private readonly hook: RegistryHook,
    private readonly path: RootedPath,
    currentText: string,
    vendor: string,
  ) {
    this.text = currentText;
    this.reader = jsonReader(hook.format, vendor);
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
  // list emptied, then the event list, then the object holding the events) and cuts it there, so
  // a file that had no `hooks` key before the hook was registered has none after. Nothing tells a
  // `hooks: {}` the user wrote from one we added, so an emptied one leaves either way. Anything a
  // user wrote in a container, a comment above all, pins that container: the climb stops below it
  // and only our lineage leaves. The root is never climbed into: it is the file.
  remove(node: Node): void {
    let target = node;
    for (;;) {
      const parent = parentOf(target);
      const clean = this.commentFree(parent);
      if (parent.type === "property") {
        if (clean) {
          target = parent;
          continue;
        }
        this.text = removeChild(this.text, target, onlyChild(target));
        return;
      }
      const alone = this.isGroup(parent) || parent.children?.length === 1;
      if (clean && alone && parent.parent !== undefined) {
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

  // A file left holding nothing but its wrapper becomes an empty object with its own line ending,
  // never a deletion: nothing records whether the file existed before the hook was registered,
  // and an empty object is harmless to every harness.
  finish(): Change {
    const root = this.root();
    if (this.commentFree(root) && sameJson(getNodeValue(root), this.hook.wrapper ?? {})) {
      const eol = this.text.endsWith("\r\n") ? "\r\n" : this.text.endsWith("\n") ? "\n" : "";
      return { kind: "write", path: this.path, content: `{}${eol}` };
    }
    return this.write();
  }

  write(): Change {
    this.root();
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
    return assertParses(this.text, this.path, this.reader);
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

// A file hook is a script, not a config: a blank file at its path is still a file to delete on
// removal, so this read does not share `readConfigText`'s blank-is-absent policy.
async function readFileState(path: string): Promise<FileState | null> {
  try {
    const [text, stats] = await Promise.all([readFile(path, "utf8"), stat(path)]);
    return { text, mode: stats.mode & 0o7777 };
  } catch (cause) {
    if (cause instanceof Error && "code" in cause && cause.code === "ENOENT") return null;
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

// The tier a harness reaches on this machine. Every declared layer is read whichever scope the hook
// sits in; the first that sets the key decides, and a key no layer sets leaves the declared tier.
// An unreadable layer is the reading when the harness refuses to start on it, or when it is the
// file this scope's hook is registered in; otherwise the harness skips that file, and so does the
// walk. A project layer under `projectTrust` is read only where the user layers mark its directory
// trusted, and skipped whole otherwise, as the harness skips it.
export async function achievedTier(
  def: HarnessDefinition,
  scope: Scope,
  ctx: HarnessContext,
): Promise<AchievedTier> {
  const declared: AchievedTier = { tier: def.tier, unreadable: null };
  if (!hasHook(def, "registry") || def.hook.tierCheck === undefined) return declared;
  const check = def.hook.tierCheck;
  const layers = await new ConfigWalk(check, ctx, def.displayName).readAll();
  const silences = (path: string): boolean =>
    check.unreadable === "refuses-to-start" || path === def.hook.path(scope, ctx);
  for (const { layer, reading } of layers) {
    if (reading.kind === "unreadable" && silences(layer.path)) {
      return { tier: 2, unreadable: unreadableNotice(layer.path, reading.reason) };
    }
  }
  const deciding = layers.find(({ reading }) => reading.kind === "value")?.reading;
  const demoted = deciding?.kind === "value" && sameJson(deciding.value, check.demotesWhen);
  return demoted ? { tier: 2, unreadable: null } : declared;
}

type TierCheck = NonNullable<RegistryHook["tierCheck"]>;

export function demotionNote(check: Pick<TierCheck, "key" | "demotesWhen">): string {
  return `${check.key} = ${JSON.stringify(check.demotesWhen)}`;
}

// The layers of one probe and their files, each read once however many layers or trust lookups
// ask for it. The same path may sit in both scopes (a project rooted at the home directory), and
// only the project reading passes the trust gate, so readings are kept per layer.
class ConfigWalk {
  private readonly files = new Map<string, Promise<FileReading>>();
  private readonly readings = new Map<string, Promise<ConfigLayer>>();
  private readonly layers: TierLayer[];
  private readonly reader: { format: ConfigFormat; vendor: string };

  constructor(
    private readonly check: TierCheck,
    private readonly ctx: HarnessContext,
    vendor: string,
  ) {
    this.layers = check.layers(ctx);
    this.reader = { format: check.format, vendor };
  }

  readAll(): Promise<{ layer: TierLayer; reading: ConfigLayer }[]> {
    return Promise.all(
      this.layers.map(async (layer) => ({ layer, reading: await this.read(layer) })),
    );
  }

  private read(layer: TierLayer): Promise<ConfigLayer> {
    const id = `${layer.scope}:${layer.path}`;
    let reading = this.readings.get(id);
    if (reading === undefined) {
      reading = this.judge(layer);
      this.readings.set(id, reading);
    }
    return reading;
  }

  // One layer as the harness reads it. The key path is parsed with the type `demotesWhen` has, so
  // a table where a flag belongs, a flag where a table belongs, or a value of another type is the
  // same `unreadable` as a file that does not parse, with zod's wording for the reason; a segment
  // the file lacks is `unset`. A user layer's trust table is parsed the same way against the marks
  // the vendor accepts, since the vendor reads the whole table before any project is looked up.
  // The value itself is taken from the parsed file, not from zod's output, which drops a
  // `__proto__` property an object-valued flag may hold.
  private async judge(layer: TierLayer): Promise<ConfigLayer> {
    if (layer.scope === "project" && !(await this.trusted(layer.dir))) return { kind: "absent" };
    const file = await this.file(layer.path);
    if (file.kind !== "value") return file;
    const segments = this.check.key.split(".");
    const schemas = [nestedSchema(segments, jsonTypeOf(this.check.demotesWhen))];
    const gate = this.check.projectTrust;
    if (layer.scope === "global" && gate !== undefined) schemas.push(trustSchema(gate));
    for (const schema of schemas) {
      const parsed = schema.safeParse(file.value);
      if (!parsed.success) {
        return { kind: "unreadable", reason: flattenIssues(parsed.error.issues).join("; ") };
      }
    }
    const value = util.getElementAtPath(file.value, segments);
    return value === undefined ? { kind: "unset" } : { kind: "value", value };
  }

  // Codex's lookup order: the directory itself, then the project root, each in the first user
  // layer that marks it; a mark other than the trusted one, or no mark at all, is untrusted. A
  // user layer that is unreadable marks nothing, and reports itself through the walk.
  private async trusted(dir: string): Promise<boolean> {
    const gate = this.check.projectTrust;
    if (gate === undefined) return true;
    const users = this.layers.filter((layer) => layer.scope === "global");
    for (const candidate of new Set([dir, this.ctx.projectRoot ?? dir])) {
      for (const layer of users) {
        const [reading, file] = await Promise.all([this.read(layer), this.file(layer.path)]);
        if (reading.kind === "unreadable" || file.kind !== "value") continue;
        const value = util.getElementAtPath(file.value, trustPath(gate, candidate));
        if (value !== undefined) return value === gate.trusted;
      }
    }
    return false;
  }

  private file(path: string): Promise<FileReading> {
    let reading = this.files.get(path);
    if (reading === undefined) {
      reading = readConfigValue(path, this.reader);
      this.files.set(path, reading);
    }
    return reading;
  }
}

// The directory is one segment whatever it holds: a dotted or slashed path names one key of the
// table, as Codex keys its `projects` table.
function trustPath(gate: ProjectTrust, dir: string): string[] {
  return [...gate.table.split("."), dir, ...gate.key.split(".")];
}

// zod's object schemas take any non-array object, a Date included, and smol-toml hands a TOML date
// back as a Date subclass, so a plain-object gate in front of each table keeps a date where a table
// belongs from reading as an empty table.
const plainTable = z.custom<Record<string, unknown>>(util.isPlainObject, {
  error: (issue) => `Invalid input: expected object, received ${util.getParsedType(issue.input)}`,
});

// `leaf` at the end of the key path, every table on the way optional and otherwise unconstrained.
function nestedSchema(segments: string[], leaf: z.ZodType): z.ZodType {
  return segments.reduceRight<z.ZodType>(
    (inner, segment) => plainTable.pipe(z.looseObject({ [segment]: inner.optional() })),
    leaf,
  );
}

// The trust table as the vendor deserializes it: every entry a table whose mark, when set, is one
// the vendor accepts.
function trustSchema(gate: ProjectTrust): z.ZodType {
  const [first, ...rest] = gate.accepted;
  const mark = z.enum([first ?? gate.trusted, ...rest]);
  const entry = nestedSchema(gate.key.split("."), mark);
  return nestedSchema(gate.table.split("."), plainTable.pipe(z.record(z.string(), entry)));
}

// The spec schema admits only a JSON value as `demotesWhen`, so a value outside these is a
// definition that bypassed parsing.
function jsonTypeOf(sample: unknown): z.ZodType {
  if (sample === null) return z.null();
  if (Array.isArray(sample)) return z.array(z.json());
  switch (typeof sample) {
    case "boolean":
      return z.boolean();
    case "number":
      return z.number();
    case "string":
      return z.string();
    case "object":
      return z.record(z.string(), z.json());
    default:
      throw new Error(`demotesWhen is a JSON value, got ${typeof sample}`);
  }
}

// The notice an `AchievedTier` carries for a config the probe could not read; the file's own name
// leads so the line reads the same whichever harness owns it.
function unreadableNotice(path: string, reason: string): string {
  return `${basename(path)} could not be read (${path}: ${reason}); assuming hooks off`;
}

type FileReading = Exclude<ConfigLayer, { kind: "unset" }>;

// A config maxims only reads, as a tier probe sees it. A regular file where the config directory
// would be (ENOTDIR) sets nothing, like a missing file; anything else that stops the read is the
// reason the probe reports, never a throw that would abort a sync over a file maxims never writes.
async function readConfigValue(
  path: string,
  reader: { format: ConfigFormat; vendor: string },
): Promise<FileReading> {
  let text: string | null;
  try {
    ({ text } = await readPresentFile(path));
  } catch (cause) {
    if (cause instanceof Error && "code" in cause && cause.code === "ENOTDIR") {
      return { kind: "absent" };
    }
    return { kind: "unreadable", reason: cause instanceof Error ? cause.message : String(cause) };
  }
  if (text === null) return { kind: "absent" };
  if (reader.format === "toml") return parseTomlConfig(text);
  const document = parseJsonDocument(text, jsonReader(reader.format, reader.vendor));
  if (document.kind !== "root") return { kind: "unreadable", reason: document.reason };
  return { kind: "value", value: getNodeValue(document.root) };
}

// smol-toml's message carries a source excerpt with a caret on the lines after the first; the
// reason keeps the first line and names the position instead.
function parseTomlConfig(text: string): FileReading {
  try {
    return { kind: "value", value: parseToml(text) };
  } catch (cause) {
    if (!(cause instanceof TomlError)) throw cause;
    const [reason = cause.message] = cause.message.split("\n");
    return { kind: "unreadable", reason: `${reason} (line ${cause.line}, column ${cause.column})` };
  }
}

export function hookPath(
  def: HarnessWithHook<"registry"> | HarnessWithHook<"file">,
  scope: Scope,
  ctx: HarnessContext,
): RootedPath {
  return assertInsideRoot(scopeRoot(def, scope, ctx), def.hook.path(scope, ctx));
}

// The prefix is matched as whole words: `npx -y @vivswan/maxims syncthing` is somebody else's
// command, `npx -y @vivswan/maxims sync --quiet --agent x` is ours with a flag set this release
// does not write, which the next sync replaces.
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
