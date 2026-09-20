// Guards every row of the memory file contract: a hostile filename that reached a path builder, a
// multi-line description that reached a rule file, or a README treated as a memory would each
// pass silently without these rows.
import { describe, expect, test } from "bun:test";
import { type Memory, parseMemory, parseMemoryName } from "./contract.ts";

const FRONTMATTER = [
  "---",
  "name: gate-exit-conditions-the-merge",
  'description: "Never chain a merge in the same command as reading a gate log - condition it on the exit code"',
  "metadata:",
  "  node_type: memory",
  "  type: feedback",
  "  scope: common",
  "  originSessionId: abc123",
  "---",
].join("\n");
const BODY =
  "\nA landing merge is a SEPARATE command.\n\n**Why:** 2026-01-01. Sibling of [[no-pipe-masked-exit-codes]].\n";
const FILE = `${FRONTMATTER}\n${BODY}`;

describe("parseMemoryName", () => {
  const cases: [string, boolean][] = [
    ["rubber-duck-before-every-commit", true],
    ["a", true],
    ["v2-rules", true],
    ["", false],
    ["Rubber-Duck", false],
    ["has space", false],
    ["../../x", false],
    ["MEMORY", false],
    ["double--dash", false],
    ["-leading", false],
    ["trailing-", false],
    ["under_score", false],
    ["dot.name", false],
    ["x".repeat(201), false],
  ];
  test.each(cases)("%j is a memory name: %p", (candidate, ok) => {
    expect(parseMemoryName(candidate)).toBe(
      ok ? (candidate as ReturnType<typeof parseMemoryName>) : null,
    );
  });
});

describe("parseMemory", () => {
  test("a conforming file yields the whole memory with the body byte-identical", () => {
    const result = parseMemory("/store/x/gate-exit-conditions-the-merge.md", FILE);
    const expected: Memory = {
      name: "gate-exit-conditions-the-merge" as Memory["name"],
      description:
        "Never chain a merge in the same command as reading a gate log - condition it on the exit code",
      body: BODY,
      metadata: {
        nodeType: "memory",
        type: "feedback",
        scope: "common",
        extra: { originSessionId: "abc123" },
      },
      raw: FILE,
    };
    expect(result).toEqual({ ok: true, memory: expected });
  });

  test("an unknown metadata.type passes with a warning and the value kept in extra", () => {
    const text = FILE.replace("type: feedback", "type: insight");
    const result = parseMemory("gate-exit-conditions-the-merge.md", text);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.warning).toBe(
      'metadata.type "insight" is not one of user, feedback, project, reference',
    );
    expect(result.memory.metadata).toEqual({
      nodeType: "memory",
      scope: "common",
      extra: { originSessionId: "abc123", type: "insight" },
    });
  });

  test("older files without metadata, and an empty body, are accepted", () => {
    const text = "---\nname: short-rule\ndescription: keep it short\n---\n";
    expect(parseMemory("short-rule.md", text)).toEqual({
      ok: true,
      memory: {
        name: "short-rule" as Memory["name"],
        description: "keep it short",
        body: "",
        metadata: { extra: {} },
        raw: text,
      },
    });
  });

  test("a folded YAML description unquotes to one line and passes", () => {
    const text = "---\nname: folded\ndescription: >-\n  first part\n  second part\n---\nbody\n";
    const result = parseMemory("folded.md", text);
    expect(result.ok && result.memory.description).toBe("first part second part");
  });

  const rejected: { title: string; filename: string; text: string; reason: RegExp }[] = [
    { title: "MEMORY.md is reserved", filename: "MEMORY.md", text: FILE, reason: /reserved/ },
    { title: "non-markdown file", filename: "notes.txt", text: FILE, reason: /not a \.md file/ },
    {
      title: "a traversal path is reduced to its basename before the name check",
      filename: "../../x.md",
      text: FILE,
      reason: /does not equal filename stem "x"/,
    },
    {
      title: "a traversal stem on its own",
      filename: "..-..-..md",
      text: FILE,
      reason: /not kebab-case/,
    },
    { title: "uppercase stem", filename: "Gate-Exit.md", text: FILE, reason: /not kebab-case/ },
    { title: "space in stem", filename: "gate exit.md", text: FILE, reason: /not kebab-case/ },
    {
      title: "name differs from the filename stem",
      filename: "other-name.md",
      text: FILE,
      reason: /does not equal filename stem "other-name"/,
    },
    {
      title: "no frontmatter",
      filename: "readme-ish.md",
      text: "# Title\n\nprose\n",
      reason: /missing frontmatter/,
    },
    {
      title: "unterminated frontmatter",
      filename: "broken.md",
      text: "---\nname: broken\ndescription: x\n",
      reason: /missing frontmatter/,
    },
    {
      title: "invalid YAML",
      filename: "bad-yaml.md",
      text: "---\nname: bad-yaml\ndescription: [unclosed\n---\n",
      reason: /not valid YAML/,
    },
    {
      title: "frontmatter is a list",
      filename: "listy.md",
      text: "---\n- a\n- b\n---\n",
      reason: /not a mapping/,
    },
    {
      title: "missing description",
      filename: "no-desc.md",
      text: "---\nname: no-desc\n---\n",
      reason: /description is missing or empty/,
    },
    {
      title: "empty description",
      filename: "empty-desc.md",
      text: '---\nname: empty-desc\ndescription: "  "\n---\n',
      reason: /description is missing or empty/,
    },
    {
      title: "non-string description",
      filename: "num-desc.md",
      text: "---\nname: num-desc\ndescription: 42\n---\n",
      reason: /description is missing or empty/,
    },
    {
      title: "literal-block description spans lines",
      filename: "multi.md",
      text: "---\nname: multi\ndescription: |\n  line one\n  line two\n---\n",
      reason: /spans several lines/,
    },
    {
      title: "node_type other than memory",
      filename: "skill-ish.md",
      text: "---\nname: skill-ish\ndescription: x\nmetadata:\n  node_type: skill\n---\n",
      reason: /node_type is "skill"/,
    },
    {
      title: "metadata is a scalar",
      filename: "meta-scalar.md",
      text: "---\nname: meta-scalar\ndescription: x\nmetadata: yes\n---\n",
      reason: /metadata is not a mapping/,
    },
  ];
  test.each(rejected)("rejects: $title", ({ filename, text, reason }) => {
    const result = parseMemory(filename, text);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toMatch(reason);
  });
});
