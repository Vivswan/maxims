// Guards every row of the memory file contract: a hostile filename that reached a path builder, a
// multi-line description that reached a rule file, or a README treated as a memory would each
// pass silently without these rows.
import { describe, expect, test } from "bun:test";
import {
  type ContentHash,
  type HiddenCharacter,
  hiddenCharacters,
  type Memory,
  parseContentHash,
  parseMemory,
  parseMemoryName,
} from "./contract.ts";

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

describe("parseContentHash", () => {
  const hex = "9f".repeat(32);
  const cases: [string, boolean][] = [
    [`sha256:${hex}`, true],
    [`sha256:${hex.toUpperCase()}`, false],
    [`sha256:${hex.slice(2)}`, false],
    [`sha256:${hex}00`, false],
    [hex, false],
    [`sha1:${"ab".repeat(20)}`, false],
    [` sha256:${hex}`, false],
    ["", false],
  ];
  test.each(cases)("%j is a content hash: %p", (candidate, ok) => {
    expect(parseContentHash(candidate)).toBe(ok ? (candidate as ContentHash) : null);
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
      // The digest of the file bytes as authored, frontmatter included: a hash over the body alone
      // would miss a description edit, which is the change a rule line has to notice.
      contentHash:
        "sha256:a59fc98b89dd2709b679b583e870430f043175b628e8b23f4d08ced89f998978" as ContentHash,
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

  test("metadata.internal is kept when boolean and warned about otherwise", () => {
    const yes = parseMemory(
      "gate-exit-conditions-the-merge.md",
      FILE.replace("  scope: common", "  scope: common\n  internal: true"),
    );
    expect(yes.ok && yes.memory.metadata.internal).toBe(true);
    expect(yes.ok && yes.warning).toBeUndefined();
    const bad = parseMemory(
      "gate-exit-conditions-the-merge.md",
      FILE.replace("  scope: common", "  scope: common\n  internal: soon"),
    );
    expect(bad.ok && bad.warning).toBe('metadata.internal "soon" is not a boolean');
    expect(bad.ok && bad.memory.metadata.internal).toBeUndefined();
    expect(bad.ok && bad.memory.metadata.extra.internal).toBe("soon");
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
        contentHash:
          "sha256:c53d42ccc1b710646b0ae0f5f2e6475a463600e01d6976d10a53cc9516ec9a49" as ContentHash,
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
      title: "a name that is a YAML mapping with a null toString",
      filename: "rule.md",
      text: "---\nname: {toString: null}\ndescription: x\n---\n",
      reason: /does not equal filename stem "rule"/,
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

describe("hiddenCharacters", () => {
  const cases: [string, string, HiddenCharacter[]][] = [
    ["clean", "Review before every commit, however trivial.", []],
    ["zero-width", "Review\u200bbefore", [{ kind: "zero-width", codePoint: 0x200b, index: 6 }]],
    ["bidi", "ok \u202eevil", [{ kind: "bidi", codePoint: 0x202e, index: 3 }]],
    ["bidi mark", "a\u200fb", [{ kind: "bidi", codePoint: 0x200f, index: 1 }]],
    ["control", "a\u0000b\tc", [{ kind: "control", codePoint: 0, index: 1 }]],
    ["line breaks are text, not hiding", "line one\nline two\r\nline three\n", []],
    ["ansi", "x\u001b[31mred", [{ kind: "ansi", codePoint: 0x1b, index: 1 }]],
    ["html-comment", "rule <!-- hidden -->", [{ kind: "html-comment", index: 5 }]],
    [
      "astral text keeps indexes in code units",
      "\u{1F600}\u200b",
      [{ kind: "zero-width", codePoint: 0x200b, index: 2 }],
    ],
  ];
  test.each(cases)("%s", (_, text, expected) => {
    expect(hiddenCharacters(text)).toEqual(expected);
  });
});
