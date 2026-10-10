// Guards every row of the memory file contract: a hostile filename that reached a path builder, a
// multi-line description that reached a rule file, or a README treated as a memory would each
// pass silently without these rows.
import { describe, expect, test } from "bun:test";
import {
  type ContentHash,
  type HiddenCharacter,
  hiddenCharacters,
  type Memory,
  type MemoryMetadata,
  parseContentHash,
  parseMemory,
  parseMemoryName,
} from "../../src/memory/contract.ts";

const FRONTMATTER = [
  "---",
  "name: commit-small-and-often",
  'description: "Keep every commit to one change - a reviewer reads a small diff in one pass"',
  "metadata:",
  "  node_type: memory",
  "  type: feedback",
  "  scope: common",
  "  originSessionId: abc123",
  "---",
].join("\n");
const BODY =
  "\nOne change per commit, however small the second looks.\n\n**Why:** 2026-01-01. Sibling of [[one-topic-per-pull-request]].\n";
const FILE = `${FRONTMATTER}\n${BODY}`;

describe("parseMemoryName", () => {
  const cases: [string, boolean][] = [
    ["prefer-timeouts-to-hangs", true],
    ["a", true],
    ["v2-rules", true],
    ["", false],
    ["Tests-First", false],
    ["has space", false],
    ["../../x", false],
    ["MEMORY", false],
    ["memory", true],
    ["readme", false],
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
  // The parser answers null for a malformed digest rather than throwing or passing it through.
  test.each(cases)("%j is a content hash: %p", (candidate, ok) => {
    expect(parseContentHash(candidate)).toBe(ok ? (candidate as ContentHash) : null);
  });
});

describe("parseMemory", () => {
  const SHORT = "---\nname: short-rule\ndescription: keep it short\n---\n";
  const FOLDED = "---\nname: folded\ndescription: >-\n  first part\n  second part\n---\nbody\n";

  // Each accepted file yields the whole memory: the body byte-identical to what follows the fence,
  // and the digest over the file bytes as authored, frontmatter included, since a hash over the
  // body alone would miss a description edit, which is the change a rule line has to notice.
  const accepted: { title: string; filename: string; text: string; memory: Memory }[] = [
    {
      title: "a conforming file with metadata",
      filename: "/store/x/commit-small-and-often.md",
      text: FILE,
      memory: {
        name: "commit-small-and-often" as Memory["name"],
        description: "Keep every commit to one change - a reviewer reads a small diff in one pass",
        body: BODY,
        metadata: {
          nodeType: "memory",
          type: "feedback",
          scope: "common",
          extra: { originSessionId: "abc123" },
        },
        raw: FILE,
        contentHash:
          "sha256:a12d5c9195838ca5628a894f7c6e275285c075ba4fe1fd3c25d88dc057372e63" as ContentHash,
      },
    },
    {
      title: "a file without metadata and with an empty body",
      filename: "short-rule.md",
      text: SHORT,
      memory: {
        name: "short-rule" as Memory["name"],
        description: "keep it short",
        body: "",
        metadata: { extra: {} },
        raw: SHORT,
        contentHash:
          "sha256:c53d42ccc1b710646b0ae0f5f2e6475a463600e01d6976d10a53cc9516ec9a49" as ContentHash,
      },
    },
    {
      title: "a folded YAML description unquoted to one line",
      filename: "folded.md",
      text: FOLDED,
      memory: {
        name: "folded" as Memory["name"],
        description: "first part second part",
        body: "body\n",
        metadata: { extra: {} },
        raw: FOLDED,
        contentHash:
          "sha256:af5a87609914eb4b96ab350f96c3d216a95ee64afeb1f5b8751238bfd5aaf52c" as ContentHash,
      },
    },
  ];
  test.each(accepted)("accepts: $title", ({ filename, text, memory }) => {
    expect(parseMemory(filename, text)).toEqual({ ok: true, memory });
  });

  // An unknown `type` or a non-boolean `internal` is kept in `extra` with a warning rather than
  // refused, so an upstream that adds a type keeps installing.
  const warned: {
    title: string;
    line: string;
    warning: string | undefined;
    metadata: MemoryMetadata;
  }[] = [
    {
      title: "an unknown metadata.type",
      line: "  type: insight",
      warning: 'metadata.type "insight" is not one of user, feedback, project, reference',
      metadata: {
        nodeType: "memory",
        scope: "common",
        extra: { originSessionId: "abc123", type: "insight" },
      },
    },
    {
      title: "a boolean metadata.internal",
      line: "  type: feedback\n  internal: true",
      warning: undefined,
      metadata: {
        nodeType: "memory",
        type: "feedback",
        scope: "common",
        internal: true,
        extra: { originSessionId: "abc123" },
      },
    },
    {
      title: "a non-boolean metadata.internal",
      line: "  type: feedback\n  internal: soon",
      warning: 'metadata.internal "soon" is not a boolean',
      metadata: {
        nodeType: "memory",
        type: "feedback",
        scope: "common",
        extra: { originSessionId: "abc123", internal: "soon" },
      },
    },
  ];
  test.each(warned)("$title passes with the whole metadata kept", ({ line, warning, metadata }) => {
    const text = FILE.replace("  type: feedback", line);
    const result = parseMemory("commit-small-and-often.md", text);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect({ warning: result.warning, metadata: result.memory.metadata }).toEqual({
      warning,
      metadata,
    });
  });

  const rejected: { title: string; filename: string; text: string; reason: RegExp }[] = [
    { title: "MEMORY.md is reserved", filename: "MEMORY.md", text: FILE, reason: /reserved/ },
    { title: "README.md is reserved", filename: "README.md", text: FILE, reason: /reserved/ },
    {
      title: "the README is reserved in any letter case",
      filename: "Readme.MD",
      text: FILE,
      reason: /reserved/,
    },
    { title: "non-markdown file", filename: "notes.txt", text: FILE, reason: /not a \.md file/ },
    {
      title: "a README with another extension is an ordinary non-markdown file",
      filename: "readme.txt",
      text: FILE,
      reason: /not a \.md file/,
    },
    {
      title: "a README without an extension is an ordinary non-markdown file",
      filename: "README",
      text: FILE,
      reason: /not a \.md file/,
    },
    {
      title: "a stem that only starts like the README is checked as a name",
      filename: "README-first.md",
      text: FILE,
      reason: /not kebab-case/,
    },
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
    { title: "uppercase stem", filename: "Small-Commits.md", text: FILE, reason: /not kebab-case/ },
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
