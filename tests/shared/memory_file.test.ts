// What would drift silently: a fixture whose description carries YAML syntax (a colon, ` #`, a
// leading `[`, a bare `true`) is refused by the memory contract or parsed as a shorter sentence,
// so a row passes over a different memory than the one it wrote.
import { expect, test } from "bun:test";
import { parseMemory } from "../../src/memory/contract.ts";
import { type MemorySpec, memoryFile } from "./memory_file.ts";

const DESCRIPTIONS = [
  "Never merge: red.",
  "a #b",
  "# not a comment",
  "[brackets] first",
  "'quoted' start",
  "ends with colon:",
  "*star",
  "true",
  "12",
  "- dash",
  "@at",
  "{x}",
  "A plain sentence, the shape every caller passes today.",
  `A sentence long enough to cross the column where a YAML writer folds a plain scalar, ${"word ".repeat(30)}end.`,
];

const SPECS: MemorySpec[] = [
  ...DESCRIPTIONS.map((description) => ({ description })),
  { description: "Kept: internal.", internal: true },
  { description: "Typed #feedback.", type: "feedback", body: "**Why:** a body of its own." },
];

test.each(SPECS)("a memory file round-trips through the real parser: %j", (spec) => {
  const parsed = parseMemory("some-rule.md", memoryFile("some-rule", spec));

  if (!parsed.ok) throw new Error(`refused: ${parsed.reason}`);
  expect(parsed.warning).toBeUndefined();
  expect({
    name: String(parsed.memory.name),
    description: parsed.memory.description,
    body: parsed.memory.body.trim(),
    metadata: parsed.memory.metadata,
  }).toEqual({
    name: "some-rule",
    description: spec.description,
    body: spec.body ?? "Body of some-rule.",
    metadata: {
      nodeType: "memory",
      ...(spec.type === undefined ? {} : { type: spec.type }),
      ...(spec.internal === true ? { internal: true } : {}),
      extra: {},
    },
  });
});

test("a plain description is written unquoted and unfolded, so files written before the shared writer keep their bytes", () => {
  const long = `Rule ${"word ".repeat(30)}end.`;

  expect(memoryFile("alpha", { description: long, internal: true })).toBe(
    `---\nname: alpha\ndescription: ${long}\nmetadata:\n  node_type: memory\n  internal: true\n---\n\nBody of alpha.\n`,
  );
});
