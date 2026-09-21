// What would drift silently: a user-owned config whose bytes make a splicer THROW a plain Error
// instead of the exit-4 refusal, an append the following removal cannot undo byte for byte, a
// spliced file that no longer parses, a codex config.toml or dsh patch file that crashes the tier
// probe or the bridge reconciler on a session start, or a harness spec document a schema check
// lets through or refuses without naming a field. Every file here is one the user also edits.
import { expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import fc from "fast-check";
import { findNodeAtLocation, getNodeValue, type Node } from "jsonc-parser";
import { spec as claudeCodeSpec } from "../../src/harnesses/claude-code/spec.ts";
import { codex } from "../../src/harnesses/codex/index.ts";
import type { HarnessContext, HookSpec } from "../../src/harnesses/contract.ts";
import { dsh } from "../../src/harnesses/dsh/index.ts";
import { spec as dshSpec } from "../../src/harnesses/dsh/spec.ts";
import { parseHarnessSpec, UserHarnessSpecSchema } from "../../src/harnesses/spec.ts";
import { loadUserDefinedHarnesses } from "../../src/harnesses/user-defined.ts";
import { ExitCode, MaximsError } from "../../src/util/exit-codes.ts";
import { appendChild, assertParses, removeChild, replaceValue } from "../../src/util/jsonc.ts";
import { PROPERTY_TIMEOUT_MS } from "../convergence/property.ts";
import { withTempDir } from "../shared/temp_dir.ts";
import {
  anyText,
  asyncOutcome,
  describeError,
  fragments,
  fuzz,
  mutatedJson,
  outcome,
} from "./shared.ts";

const PATH = "settings.json";

// JSONC's own tokens: comments, trailing commas, strings holding `//` and `*/`, and the brackets a
// splice must keep balanced.
const JSONC_PIECES = [
  "{",
  "}",
  "[",
  "]",
  ",",
  ":",
  '"',
  "'",
  '"hooks"',
  '"SessionStart"',
  '"a"',
  '"https://example.com"',
  '"*/"',
  '"//"',
  "1",
  "-0",
  "1e999",
  "true",
  "null",
  "//",
  "// c\n",
  "/*",
  "*/",
  "/* c */",
  "\n",
  "\r\n",
  " ",
  "\t",
  "  ",
  "\\",
  '\\"',
  "\\u00",
  "\ufeff",
  "a",
];

const jsonText = fc.oneof(
  anyText({ maxLength: 512 }),
  fragments(JSONC_PIECES, { maxLength: 60 }),
  fc.json({ maxDepth: 3 }),
);

function refusal(error: unknown): void {
  if (error instanceof MaximsError && error.code === ExitCode.DestinationWriteFailed) return;
  throw new Error(`threw ${describeError(error)}`);
}

test(
  "assertParses returns an object root or refuses with exit 4 for any text",
  async () => {
    await fuzz("assertParses", jsonText, (text) => {
      const result = outcome(() => assertParses(text, PATH));
      if (result.kind === "threw") return refusal(result.error);
      expect(result.value.type).toBe("object");
      expect(result.value.offset).toBeGreaterThanOrEqual(0);
      expect(result.value.offset + result.value.length).toBeLessThanOrEqual(text.length);
    });
  },
  PROPERTY_TIMEOUT_MS,
);

const key = fc.stringMatching(/^[A-Za-z_][A-Za-z0-9_-]{0,8}$/);
const document = fc.dictionary(key, fc.jsonValue({ maxDepth: 2 }), { minKeys: 0, maxKeys: 4 });
const indent = fc.constantFrom(2, 4, "\t");
const eol = fc.constantFrom("\n", "\r\n");

type Container = { path: (string | number)[]; node: Node };

// Every object or array node of a parsed document, root included.
function containers(root: Node, path: (string | number)[] = []): Container[] {
  const found: Container[] = [];
  if (root.type === "object" || root.type === "array") found.push({ path, node: root });
  for (const [index, child] of (root.children ?? []).entries()) {
    if (root.type === "object" && child.type === "property") {
      const [name, value] = child.children ?? [];
      if (name === undefined || value === undefined) continue;
      found.push(...containers(value, [...path, String(name.value)]));
    } else if (root.type === "array") {
      found.push(...containers(child, [...path, index]));
    }
  }
  return found;
}

// JSON has no negative zero: `-0` is written as `0`, so the value read back is compared to what
// the text can carry.
const jsonValue = fc.jsonValue({ maxDepth: 2 }).map((value) => JSON.parse(JSON.stringify(value)));

const splice = fc
  .tuple(document, indent, eol, fc.nat(), key, jsonValue)
  .map(([doc, unit, ending, pick, newKey, value]) => ({
    text: JSON.stringify(doc, null, unit).split("\n").join(ending),
    pick,
    newKey,
    value,
  }));

// The documented promise: on a file pretty-printed the way every harness's own examples are, an
// append followed by the removal of what it appended is the identity, and both edits leave a file
// that parses with exactly the member added or taken.
test(
  "appendChild then removeChild is the identity on any pretty-printed config",
  async () => {
    await fuzz("appendChild and removeChild", splice, ({ text, pick, newKey, value }) => {
      const root = assertParses(text, PATH);
      const options = containers(root);
      const target = options[pick % options.length];
      if (target === undefined) throw new Error("a parsed object has a root container");
      const isArray = target.node.type === "array";
      const existing: unknown = getNodeValue(target.node);
      if (typeof existing === "object" && existing !== null && Object.hasOwn(existing, newKey)) {
        return;
      }
      const appended = outcome(() =>
        appendChild(text, target.node, isArray ? null : newKey, value),
      );
      if (appended.kind === "threw") throw new Error(`threw ${describeError(appended.error)}`);
      const afterAppend = assertParses(appended.value, PATH);
      const memberPath = [...target.path, isArray ? (target.node.children?.length ?? 0) : newKey];
      const member = findNodeAtLocation(afterAppend, memberPath);
      if (member === undefined) throw new Error(`append left no member at ${memberPath.join(".")}`);
      expect(getNodeValue(member)).toEqual(value);
      const container = findNodeAtLocation(afterAppend, target.path);
      const child = container?.children?.at(-1);
      if (container === undefined || child === undefined)
        throw new Error("append lost its container");
      const removed = outcome(() => removeChild(appended.value, container, child));
      if (removed.kind === "threw") throw new Error(`threw ${describeError(removed.error)}`);
      expect(removed.value).toBe(text);
    });
  },
  PROPERTY_TIMEOUT_MS,
);

test(
  "replaceValue leaves a file that parses with the new value in the node's place",
  async () => {
    await fuzz("replaceValue", splice, ({ text, pick, value }) => {
      const root = assertParses(text, PATH);
      const nodes = containers(root).flatMap(({ path, node }) =>
        node.type === "object"
          ? (node.children ?? []).flatMap((property) => {
              const [name, member] = property.children ?? [];
              return name === undefined || member === undefined
                ? []
                : [{ path: [...path, String(name.value)], node: member }];
            })
          : (node.children ?? []).map((item, index) => ({ path: [...path, index], node: item })),
      );
      const target = nodes[pick % Math.max(nodes.length, 1)];
      if (target === undefined) return;
      const replaced = outcome(() => replaceValue(text, target.node, value));
      if (replaced.kind === "threw") throw new Error(`threw ${describeError(replaced.error)}`);
      const after = assertParses(replaced.value, PATH);
      const member = findNodeAtLocation(after, target.path);
      if (member === undefined) throw new Error(`replace lost ${target.path.join(".")}`);
      expect(getNodeValue(member)).toEqual(value);
    });
  },
  PROPERTY_TIMEOUT_MS,
);

// codex's config.toml as a user writes it, with the `[features] hooks` key in every wrong shape.
const TOML_PIECES = [
  "[features]",
  "[features.hooks]",
  "[[features]]",
  "hooks",
  "hooks = ",
  "true",
  "false",
  '"true"',
  "1",
  "[",
  "]",
  "=",
  '"',
  "'",
  "'''",
  "\n",
  "\r\n",
  "#",
  ".",
  "a",
  " ",
  "features.hooks = true",
  "1979-05-27T07:32:00Z",
  "{ hooks = false }",
];
const tomlText = fc.oneof(anyText({ maxLength: 300 }), fragments(TOML_PIECES, { maxLength: 30 }));

function contextAt(home: string): HarnessContext {
  return { home, projectRoot: null, env: {} };
}

// A config.toml a user mistyped, or one with `hooks = "true"`, is a user-owned config like the
// registries above: a library error escaping the probe would crash a sync with a stack.
test(
  "codex.achievedTier answers 1, 2 or an exit-4 refusal for any config.toml bytes",
  async () => {
    const probe = codex.achievedTier;
    if (probe === undefined) throw new Error("codex declares a tier probe");
    await withTempDir(async (home) => {
      mkdirSync(join(home, ".codex"));
      const configPath = join(home, ".codex", "config.toml");
      await fuzz("codex tier probe", tomlText, async (text) => {
        writeFileSync(configPath, text);
        const result = await asyncOutcome(() => probe(contextAt(home)));
        if (result.kind === "threw") return refusal(result.error);
        expect([1, 2]).toContain(result.value);
      });
    });
  },
  PROPERTY_TIMEOUT_MS,
);

// dsh's patch layer as a user writes it: block and flow sequences, our row id, its plugin name,
// anchors, tags, document markers and the indentation the splice keys on.
const YAML_PIECES = [
  "- ",
  "-",
  "insert:",
  "insert: ",
  "\n",
  "\r\n",
  "  ",
  "    ",
  "\t",
  "id: ",
  "maxims-hooks",
  "name: ",
  "@deepseek-ai/dsh-hooks-claude-code",
  "config:",
  "configPath: ",
  "/home/user/.dsh/maxims-hooks.json",
  "[",
  "]",
  "{",
  "}",
  ",",
  ":",
  "# c",
  "'",
  '"',
  "|",
  ">",
  "&a ",
  "*a",
  "!!str ",
  "---",
  "...",
  "a",
  " ",
  "- insert:\n    - id: maxims-hooks\n      name: @deepseek-ai/dsh-hooks-claude-code\n",
  "- insert:\n    - id: other\n",
];
const yamlText = fc.oneof(anyText({ maxLength: 300 }), fragments(YAML_PIECES, { maxLength: 30 }));
const HOOK: HookSpec = {
  command: "maxims",
  args: ["sync", "--quiet"],
  async: true,
  timeoutSeconds: 10,
};

test(
  "the dsh bridge reconciler plans only its two artifacts, or refuses with exit 4, for any patch file",
  async () => {
    if (dsh.hook.kind !== "custom") throw new Error("dsh declares a custom hook reconciler");
    const { reconcile } = dsh.hook;
    await withTempDir(async (home) => {
      mkdirSync(join(home, ".dsh"));
      const patchPath = join(home, ".dsh", "cordis.patch.yml");
      const artifacts = [patchPath, join(home, ".dsh", "maxims-hooks.json")];
      await fuzz("dsh reconciler", fc.tuple(yamlText, fc.boolean()), async ([text, wanted]) => {
        writeFileSync(patchPath, text);
        const result = await asyncOutcome(() => reconcile("global", contextAt(home), HOOK, wanted));
        if (result.kind === "threw") return refusal(result.error);
        for (const change of result.value) {
          expect(artifacts).toContain(change.path);
          expect(["write", "delete"]).toContain(change.kind);
        }
      });
    });
  },
  PROPERTY_TIMEOUT_MS,
);

const SPEC_FIELDS = [...new Set([...Object.keys(claudeCodeSpec), ...Object.keys(dshSpec)])];

function namesASpecField(issue: string): boolean {
  return SPEC_FIELDS.some(
    (field) => issue.startsWith(`${field}: `) || issue.startsWith(`${field}.`),
  );
}

const specDocument = fc.oneof(
  fc.jsonValue({ maxDepth: 3 }),
  mutatedJson(claudeCodeSpec),
  mutatedJson(dshSpec),
);

test(
  "parseHarnessSpec answers ok or named issues for any document, and accepts what it produced",
  async () => {
    await fuzz("parseHarnessSpec", specDocument, (json) => {
      const result = outcome(() => parseHarnessSpec(json));
      if (result.kind === "threw") throw new Error(`threw ${describeError(result.error)}`);
      if (!result.value.ok) {
        const { issues } = result.value;
        expect(issues.length).toBeGreaterThan(0);
        for (const issue of issues) expect(issue).not.toBe("");
        // A document that is at least an object fails on a named field, so a refusal that lost
        // its field prefixes ("Invalid input" alone) is caught here.
        if (typeof json === "object" && json !== null && !Array.isArray(json)) {
          expect(issues.some(namesASpecField)).toBe(true);
        }
        return;
      }
      const again = parseHarnessSpec(structuredClone(result.value.spec));
      expect(again).toEqual(result.value);
    });
  },
  PROPERTY_TIMEOUT_MS,
);

const userSpec = { ...claudeCodeSpec, id: "my-agent", fixtures: undefined };
const harnessesFile = fc.oneof(
  anyText({ maxLength: 300 }),
  fragments(JSONC_PIECES, { maxLength: 40 }),
  fc.jsonValue({ maxDepth: 3 }).map((value) => JSON.stringify(value)),
  mutatedJson({ harnesses: [JSON.parse(JSON.stringify(userSpec))] }).map((value) =>
    JSON.stringify(value),
  ),
);

test(
  "loadUserDefinedHarnesses returns definitions or refuses with exit 4 for any harnesses.json",
  async () => {
    expect(parseHarnessSpec(JSON.parse(JSON.stringify(userSpec)), UserHarnessSpecSchema).ok).toBe(
      true,
    );
    await withTempDir(async (home) => {
      const filePath = join(home, "harnesses.json");
      await fuzz("loadUserDefinedHarnesses", harnessesFile, async (text) => {
        writeFileSync(filePath, text);
        const result = await asyncOutcome(() => loadUserDefinedHarnesses(home));
        if (result.kind === "threw") return refusal(result.error);
        for (const definition of result.value) {
          expect(definition.userDefined).toBe(true);
          expect(definition.id).toMatch(/^[a-z][a-z0-9]*(-[a-z0-9]+)*$/);
        }
      });
    });
  },
  PROPERTY_TIMEOUT_MS,
);
