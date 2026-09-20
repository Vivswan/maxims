// Guards the managed-block grammar against the harnesses that read it: a marker that fails to
// round-trip leaves a block sync can never find again (so it appends forever), an unescaped `@`
// token is a file-read primitive on Claude Code, and any byte changed outside the pair is a user's
// hand-written rule silently rewritten. None of that is enforced by anything but these rows.
import { describe, expect, test } from "bun:test";
import type { MemoryName } from "../memory/contract.ts";
import { parseBlocks, renderBlock, replaceBlock, stripBlock } from "./block.ts";
import type { BlockInput, ExpansionSyntax, RuleLine, Staleness } from "./types.ts";

const SOURCE = "@Vivswan/skills";
const STORE = "/home/user/.agents/maxims/store/Vivswan/skills";

function line(name: string, description: string, shortHash = "a1b2c3d"): RuleLine {
  return { name: name as MemoryName, description, detailPath: `${STORE}/${name}.md`, shortHash };
}

const RUBBER_DUCK = line(
  "rubber-duck-before-every-commit",
  "Codex rubber-duck review before EVERY commit, however trivial",
);
const GATE = line(
  "gate-exit-conditions-the-merge",
  "Landings are exit-conditioned: read the gate's own verdict, stop, merge in a separate command",
  "0f0f0f0",
);

function input(overrides: Partial<BlockInput> = {}): BlockInput {
  return {
    source: SOURCE,
    sha: "3f2a9c1e",
    lines: [RUBBER_DUCK, GATE],
    markers: "stripped",
    expands: ["at-import"],
    selfRefresh: false,
    ...overrides,
  };
}

const RUBBER_DUCK_LINE = `- Codex rubber-duck review before EVERY commit, however trivial (detail: ${STORE}/rubber-duck-before-every-commit.md, a1b2c3d)`;
const GATE_LINE = `- Landings are exit-conditioned: read the gate's own verdict, stop, merge in a separate command (detail: ${STORE}/gate-exit-conditions-the-merge.md, 0f0f0f0)`;
const BEGIN = "<!-- maxims:begin @Vivswan/skills sha=3f2a9c1e -->";
const END = "<!-- maxims:end @Vivswan/skills -->";
const PROVENANCE = [
  "<!-- managed by maxims: @Vivswan/skills - edits will be overwritten -->",
  "<!-- update: npx maxims add @Vivswan/skills | remove: npx maxims remove @Vivswan/skills -->",
];

describe("renderBlock", () => {
  test("stripped markers carry the verbose provenance pair; counted markers shrink to one line each", () => {
    expect(renderBlock(input({ markers: "stripped" }))).toBe(
      `${[BEGIN, ...PROVENANCE, RUBBER_DUCK_LINE, GATE_LINE, END].join("\n")}\n`,
    );
    expect(renderBlock(input({ markers: "counted" }))).toBe(
      `${[BEGIN, RUBBER_DUCK_LINE, GATE_LINE, END].join("\n")}\n`,
    );
  });

  test("frontmatter precedes the block and gains the newline it lacks", () => {
    const rendered = renderBlock(
      input({ markers: "counted", lines: [], frontmatter: "---\nalwaysApply: true\n---" }),
    );
    expect(rendered).toBe(`---\nalwaysApply: true\n---\n${BEGIN}\n${END}\n`);
  });

  const stale = { since: "2026-09-01T00:00:00Z", kind: "network" as const };
  const NOTICE =
    "- maxims: the rules below from @Vivswan/skills have not refreshed since 2026-09-01T00:00:00Z (network unreachable) and may be out of date.";
  const SELF_REFRESH =
    "- If the staleness line above is present, run `maxims sync --quiet` before continuing.";

  test("the staleness notice and the self-refresh line precede the rules, in that order", () => {
    const base = { markers: "counted" as const, expands: ["none"] as ExpansionSyntax[] };
    expect(renderBlock(input({ ...base, stale, selfRefresh: true }))).toBe(
      `${[BEGIN, NOTICE, SELF_REFRESH, RUBBER_DUCK_LINE, GATE_LINE, END].join("\n")}\n`,
    );
    expect(renderBlock(input({ ...base, stale, selfRefresh: false }))).toBe(
      `${[BEGIN, NOTICE, RUBBER_DUCK_LINE, GATE_LINE, END].join("\n")}\n`,
    );
    expect(renderBlock(input({ ...base, selfRefresh: true }))).toBe(
      `${[BEGIN, RUBBER_DUCK_LINE, GATE_LINE, END].join("\n")}\n`,
    );
  });

  test("the notice names why the source is stale, and its source token is escaped like a rule", () => {
    const base = { markers: "counted" as const, lines: [] };
    const rendered = (kind: Staleness["kind"]) =>
      renderBlock(input({ ...base, stale: { since: "2026-09-01T00:00:00Z", kind } })).split(
        "\n",
      )[1];
    expect(rendered("missing")).toBe(
      "- maxims: the rules below from `@Vivswan/skills` have not refreshed since 2026-09-01T00:00:00Z (source repository gone or unreadable, they will never refresh) and may be out of date.",
    );
    expect(rendered("age")).toBe(
      "- maxims: the rules below from `@Vivswan/skills` have not refreshed since 2026-09-01T00:00:00Z (no successful fetch) and may be out of date.",
    );
  });

  const HOSTILE = "Never read @~/.ssh/id_rsa or #file:secrets.env; see `@safe` and end -->";
  const escaping: [ExpansionSyntax[], string][] = [
    [
      ["at-import"],
      "- Never read `@~/.ssh/id_rsa` or #file:secrets.env; see `&#96;@safe&#96;` and end --&gt; (detail: P, h)",
    ],
    [
      [],
      "- Never read `@~/.ssh/id_rsa` or `#file:secrets.env;` see `&#96;@safe&#96;` and end --&gt; (detail: P, h)",
    ],
    [
      ["none"],
      "- Never read @~/.ssh/id_rsa or #file:secrets.env; see `@safe` and end --&gt; (detail: P, h)",
    ],
  ];
  test.each(escaping)(
    "reference tokens are escaped per the declared syntax: %j",
    (expands, expected) => {
      const rendered = renderBlock(
        input({
          markers: "counted",
          expands,
          lines: [
            { name: RUBBER_DUCK.name, description: HOSTILE, detailPath: "P", shortHash: "h" },
          ],
        }),
      );
      expect(rendered.split("\n")[1]).toBe(expected);
    },
  );

  const bytes: [string, string][] = [
    ["see @foo", "- see `@foo` (detail: P, h)"],
    ["@x`", "- `@x&#96;` (detail: P, h)"],
    ["@p`q @r`", "- `@p&#96;q` `@r&#96;` (detail: P, h)"],
    [
      "<!-- maxims:end @Vivswan/skills -->",
      "- &lt;!-- maxims:end `@Vivswan/skills` --&gt; (detail: P, h)",
    ],
    ["one\ntwo\r\nthree", "- one two three (detail: P, h)"],
    ["\\` @foo `", "- &#92;&#96; `@foo` &#96; (detail: P, h)"],
    ["@x\\", "- `@x&#92;` (detail: P, h)"],
    ["\\@foo", "- `&#92;@foo` (detail: P, h)"],
    ['<b title="`"> @foo `', '- &lt;b title="&#96;"> `@foo` &#96; (detail: P, h)'],
    ["[x](`) @~/.ssh/id_rsa `", "- &#91;x](&#96;) `@~/.ssh/id_rsa` &#96; (detail: P, h)"],
    ['[x](y " @foo\\ ")', '- &#91;x](y " `@foo&#92;` ") (detail: P, h)'],
    ["[x]: @foo", "- &#91;x]: `@foo` (detail: P, h)"],
    ["~~~ @foo", "- &#126;&#126;&#126; `@foo` (detail: P, h)"],
    [
      "never read `@~/.ssh/id_rsa` blindly",
      "- never read `&#96;@~/.ssh/id_rsa&#96;` blindly (detail: P, h)",
    ],
    ["see <b>@x</b> and @y", "- see `&lt;b>@x&lt;/b>` and `@y` (detail: P, h)"],
    ["use <name> and `code`", "- use <name> and `code` (detail: P, h)"],
    ["see *@./secret.md*", "- see `*@./secret.md*` (detail: P, h)"],
    ["see _@./secret.md_ and ~~@x~~", "- see `_@./secret.md_` and `~~@x~~` (detail: P, h)"],
    ["see <b>@./secret.md</b>", "- see `&lt;b>@./secret.md&lt;/b>` (detail: P, h)"],
    ["see `x`@./secret.md", "- see `&#96;x&#96;@./secret.md` (detail: P, h)"],
    ["see `@./ok` and *@./bad*", "- see `&#96;@./ok&#96;` and `*@./bad*` (detail: P, h)"],
    ["see [x](y)@./secret.md", "- see `&#91;x](y)@./secret.md` (detail: P, h)"],
    ["see [@./secret.md](y)", "- see `&#91;@./secret.md](y)` (detail: P, h)"],
    ["see \\!@./secret.md", "- see `&#92;!@./secret.md` (detail: P, h)"],
    ["mail a@example.com@./secret.md", "- mail `a@example.com@./secret.md` (detail: P, h)"],
    ["see (@./secret.md)", "- see `(@./secret.md)` (detail: P, h)"],
    ["see x@./secret.md", "- see `x@./secret.md` (detail: P, h)"],
    ["see [x](@./secret.md)", "- see `&#91;x](@./secret.md)` (detail: P, h)"],
  ];
  test.each(bytes)("description %j renders as %j", (description, expected) => {
    const rendered = renderBlock(
      input({
        markers: "counted",
        lines: [{ name: RUBBER_DUCK.name, description, detailPath: "P", shortHash: "h" }],
      }),
    );
    expect(rendered.split("\n")[1]).toBe(expected);
    expect(exposedReferences(expected).filter((token) => token.startsWith("@"))).toEqual([]);
  });

  test("a description is truncated at 300 characters with an ASCII ellipsis, never mid code point", () => {
    const render = (description: string) =>
      renderBlock(
        input({
          markers: "counted",
          lines: [{ name: RUBBER_DUCK.name, description, detailPath: "P", shortHash: "h" }],
        }),
      ).split("\n")[1];
    expect(render("a".repeat(300))).toBe(`- ${"a".repeat(300)} (detail: P, h)`);
    expect(render("a".repeat(301))).toBe(`- ${"a".repeat(297)}... (detail: P, h)`);
    expect(render("\u{1F600}".repeat(301))).toBe(`- ${"\u{1F600}".repeat(297)}... (detail: P, h)`);
  });

  test("a source or sha that cannot sit inside a marker is refused before anything renders", () => {
    for (const source of ["", " padded", "line\nbreak", "ends-->early"]) {
      expect(() => renderBlock(input({ source }))).toThrow();
    }
    expect(() => renderBlock(input({ sha: "has space" }))).toThrow();
  });
});

const BLOCK = renderBlock(input({ markers: "counted" }));
const OTHER = renderBlock(input({ markers: "counted", source: "@example-user/rules", sha: "b" }));

describe("parseBlocks", () => {
  test("finds a rendered block, its source and sha, and the exact span it occupies", () => {
    const text = `# Mine\n\n${BLOCK}\ntrailing\n`;
    const parsed = parseBlocks(text);
    expect(parsed.warnings).toEqual([]);
    expect(parsed.blocks).toHaveLength(1);
    const [block] = parsed.blocks;
    expect(block).toMatchObject({ source: SOURCE, sha: "3f2a9c1e" });
    expect(text.slice(block.start, block.end)).toBe(BLOCK);
  });

  const notMarkers: [string, string][] = [
    ["indented", `  ${BEGIN}\n- x\n  ${END}\n`],
    ["inside a backtick fence", `\`\`\`md\n${BEGIN}\n- x\n${END}\n\`\`\`\n`],
    ["inside a tilde fence", `~~~\n${BEGIN}\n- x\n${END}\n~~~\n`],
    ["inside an unclosed fence", `\`\`\`\n${BEGIN}\n- x\n${END}\n`],
    ["mismatched pair", `${BEGIN}\n- x\n<!-- maxims:end @example-user/rules -->\n`],
    ["begin without end", `${BEGIN}\n- x\n`],
    ["end without begin", `- x\n${END}\n`],
    ["swallowed by an open comment", `<!--\n${BEGIN}\n- x\n${END}\n-->\n`],
    ["inside a pre block", `<pre>\n${BEGIN}\n- x\n${END}\n</pre>\n`],
    ["inside a pre block opened behind two spaces", `  <pre>\n${BEGIN}\n- x\n${END}\n</pre>\n`],
    [
      "inside a fence opened behind three spaces",
      ["   ```\n", BEGIN, "\n- x\n", END, "\n```\n"].join(""),
    ],
    ["inside a CDATA section", `<![CDATA[\n${BEGIN}\n- x\n${END}\n]]>\n`],
    [
      "inside a fence behind a byte order mark",
      ["\uFEFF```md\n", BEGIN, "\n- x\n", END, "\n```\n"].join(""),
    ],
    ["inside a processing instruction", `<?xml\n${BEGIN}\n- x\n${END}\n?>\n`],
    ["inside a declaration", `<!DOCTYPE\n${BEGIN}\n- x\n${END}\n>\n`],
    ["inside a div with no blank line before it", `<div>\n${BEGIN}\n- x\n${END}\n</div>\n`],
    ["inside a custom tag block", `<custom>\n${BEGIN}\n- x\n${END}\n</custom>\n`],
    ["inside a block opened by a lone inline tag", `<b>\n${BEGIN}\n- x\n${END}\n</b>\n`],
    [
      "inside a block opened by a tag with attributes",
      `<custom attr="x" data-y='z' flag>\n${BEGIN}\n- x\n${END}\n</custom>\n`,
    ],
    ["inside a block opened by a tag holding a form feed", `<custom\f>\n${BEGIN}\n- x\n${END}\n`],
    [
      "inside a block opened by a tag followed by a form feed",
      `<custom>\f\n${BEGIN}\n- x\n${END}\n`,
    ],
    ["inside a block opened by a closing tag", `</custom>\n${BEGIN}\n- x\n${END}\n`],
    [
      "inside a div after a line holding only a non-breaking space",
      `<div>\n\u00a0\n${BEGIN}\n- x\n${END}\n</div>\n`,
    ],
    [
      "inside a fence whose closer carries a trailing non-breaking space",
      ["```\nx\n```\u00a0\n", BEGIN, "\n- x\n", END, "\n"].join(""),
    ],
  ];
  test.each(notMarkers)("%s is not a block", (_label, text) => {
    expect(parseBlocks(text)).toEqual({ blocks: [], warnings: [] });
  });

  test("a block that ended before the markers hides nothing after it", () => {
    for (const comment of ["<!-- note -->", "<!-->", "<pre>x</pre>", "<div>\n", "<?x?>", "<!X>"]) {
      const text = `${comment}\n${BLOCK}`;
      expect(parseBlocks(text).blocks.map((block) => text.slice(block.start, block.end))).toEqual([
        BLOCK,
      ]);
    }
  });

  test("a fence closes at a fence at least as long, so a shorter one keeps the markers quoted", () => {
    const text = ["````\n", BEGIN, "\n```\n", END, "\n`````\n", BLOCK].join("");
    const parsed = parseBlocks(text);
    expect(parsed.blocks.map((block) => text.slice(block.start, block.end))).toEqual([BLOCK]);
  });

  // Each prefix is followed by the block at column 0. Whether CommonMark leaves the marker lines
  // outside every fence and raw HTML block the prefix opened decides whether they form a block.
  const contexts: [string, string, boolean][] = [
    ["a fence inside a list item, ended by the next item", "- a\n  ```\n  x\n- b\n", true],
    ["a fence inside a list item, ended by the markers themselves", "- a\n  ```\n  x\n", true],
    ["a fence inside a nested item, ended by the outer item", "- a\n  - b\n    ```\n  - c\n", true],
    ["a fence inside an item indented with a tab", "- a\n\t```\n\tx\n- b\n", true],
    ["a fence inside an item after a blank line in it", "- a\n  ```\n\n  x\n- b\n", true],
    [
      "a fence inside an item reached across a lazy paragraph line",
      "- a\nlazy\n  ```\n- b\n",
      true,
    ],
    [
      "an ordered marker numbered two, which continues a paragraph inside its own item",
      "1. a\n   2. b\n   ```\n- c\n",
      true,
    ],
    ["a lone tag lazily continuing an item's paragraph", "- a\n<custom>\n", true],
    [
      "a lazy line continuing a blockquote's paragraph inside an item",
      "- > a\nlazy\n  ```\n- b\n",
      true,
    ],
    [
      "a setext underline and a lone tag lazily continuing a blockquote",
      "> a\n===\n<custom>\n",
      true,
    ],
    [
      "a top-level fence behind two spaces after an ordered item numbered two",
      "- a\n2. b\n  ```\n- c\n",
      false,
    ],
    [
      "a top-level fence behind two spaces after an empty item ended by a blank line",
      "-\n\n  ```\n",
      false,
    ],
    [
      "a top-level fence after an item's fence indented by a tab reaching column four",
      "- a\n  \t```\nx\n  ```\n",
      false,
    ],
    [
      "a lone tag after a blockquote ending in a fence, which it cannot continue",
      "> ```\n> x\n<custom>\n",
      false,
    ],
    ["an empty item that ends its sibling's paragraph and holds a fence", "- a\n-\n  ```\n", true],
    [
      "an empty item ending a lazily continued quoted paragraph, with a fence closed by a shallower closer",
      "> - a\n  > q\n-\n  \t```\n   ```\n",
      true,
    ],
    [
      "a blockquoted fence inside an item, which a lone tag cannot continue",
      "- > ```\n<custom>\n",
      false,
    ],
    ["a quoted paragraph behind a tab, which a lone tag continues", ">\tx\n<custom>\n", true],
    ["twenty thousand nested blockquotes", `${">".repeat(20_000)}x\n`, true],
    [
      "a paragraph of link reference definitions, which `===` cannot underline",
      "[x]: /url\n===\n<custom>\n",
      true,
    ],
    [
      "a paragraph underlined by `===`, after which a lone tag opens a block",
      "text\n===\n<custom>\n",
      false,
    ],
    [
      "a line shaped like a definition with text after it, which `===` underlines",
      "[x]: /url junk\n===\n<custom>\n",
      false,
    ],
    [
      "a paragraph of link reference definitions ended by a thematic break",
      "[x]: /url\n---\n<custom>\n",
      false,
    ],
    [
      "an unclosed label whose bracket is escaped, which `===` underlines",
      "[\\]: /url\n===\n<custom>\n",
      false,
    ],
    [
      "an unclosed destination whose bracket is escaped, which `===` underlines",
      "[x]: <a\\>\n===\n<custom>\n",
      false,
    ],
    [
      "an unclosed title whose quote is escaped, which `===` underlines",
      '[x]: /url "a\\"\n===\n<custom>\n',
      false,
    ],
    ["nested quotes whose tabs reach an indented code block", ">\t>\t  x\n<custom>\n", false],
    ["nested quotes whose tab reaches a paragraph", "> >\t  x\n<custom>\n", true],
    [
      "a label of only a non-breaking space, which is no definition",
      "[\u00a0]: /url\n===\n<custom>\n",
      false,
    ],
    [
      "a definition with balanced parentheses, then `===` and `-` as text and underline",
      "[x]: /a(b)\n===\n-\n  ```\n",
      false,
    ],
    ["a definition whose destination sits on the next line", "[x]:\n/url\n===\n<custom>\n", true],
    ["a definition whose title sits on the next line", '[x]: /url\n"title"\n===\n<custom>\n', true],
    ["a label alone, which `===` underlines", "[x]:\n===\n<custom>\n", false],
    [
      "a definition followed by a title line with text after it",
      '[x]: /url\n"title" junk\n===\n<custom>\n',
      false,
    ],
    ["a destination with an escaped space, which is prose", "[x]: /a\\ b\n===\n<custom>\n", false],
    ["a destination ending in a lone backslash", "[x]: /a\\\n===\n<custom>\n", true],
    ["a title spanning two lines", '[x]: /url "hello\nworld"\n===\n<custom>\n', true],
    ["a label spanning two lines", "[hello\nworld]: /url\n===\n<custom>\n", true],
    ["a title left open, which `===` underlines", '[x]: /url "hello\n===\n<custom>\n', false],
    ["a label left open, which `===` underlines", "[hello\n===\n<custom>\n", false],
    [
      "a label of a thousand characters written as escape pairs",
      `[${"\\!".repeat(500)}]: /url\n===\n<custom>\n`,
      false,
    ],
    ["a label whose first line ends in a backslash", "[a\\\nb]: /url\n===\n<custom>\n", true],
    ["a title whose first line ends in a backslash", '[x]: /url "a\\\nb"\n===\n<custom>\n', true],
    ["a destination holding a C1 control character", "[x]: /a\u0085b\n===\n<custom>\n", true],
    ["a destination holding a NUL", "[x]: /a\0b\n===\n<custom>\n", true],
    [
      "a top-level fence behind two spaces after a heading item ends",
      "- # h\nfoo\n  ```\n- b\n",
      false,
    ],
    [
      "a top-level fence behind two spaces after an ordered item starting at one",
      "- a\n1. b\n  ```\n- c\n",
      false,
    ],
    [
      "a top-level fence opened by a column-0 closer of an item's fence",
      "- a\n  ```\n  x\n```\n",
      false,
    ],
    ["a div inside a list item, ended by the markers themselves", "- <div>\n  x\n", true],
    ["a pre block inside a list item, ended by the markers themselves", "- <pre>\n  x\n", true],
    ["a comment inside a list item, ended by the markers themselves", "- <!--\n  x\n", true],
    ["a fence inside a blockquote, ended by the markers themselves", "> ```\n> x\n", true],
    ["a custom tag block with no blank line after it", "<custom>\nx\n", false],
    ["a custom tag block ended by a blank line", "<custom>\nx\n\n", true],
    [
      "a lone custom tag continuing a paragraph, which it cannot interrupt",
      "text\n<custom>\n",
      true,
    ],
    ["a custom tag followed by text, which is a paragraph", "<custom>text\n", true],
  ];
  test.each(contexts)(
    "after %s, column-0 markers form a block: %p",
    (_label, prefix, formsBlock) => {
      const text = `${prefix}${BLOCK}`;
      const spans = parseBlocks(text).blocks.map((block) => text.slice(block.start, block.end));
      expect(spans).toEqual(formsBlock ? [BLOCK] : []);
    },
  );

  // Each prefix took seconds under a scanner that re-read the line or the item stack per level,
  // or let a rule backtrack across the line.
  const deep: [string, string][] = [
    ["a line of nested list markers", `${"- ".repeat(100_000)}x\n`],
    [
      "nested blockquotes holding nested list markers",
      `${">".repeat(4_000)}${"- ".repeat(100_000)}\n`,
    ],
    ["lazy lines under deep nesting", `${"- ".repeat(50_000)}x\n${"x\n".repeat(50_000)}`],
    ["nested blockquotes each leaving a space of indentation", `${">  ".repeat(100_000)}x\n`],
    ["nested blockquotes each followed by a tab", `${">\t".repeat(100_000)}x\n`],
    ["an unterminated link label", `[${"a".repeat(200_000)}\n`],
  ];
  test.each(deep)("%s scans without rescanning the line or the item stack", (_label, prefix) => {
    expect(parseBlocks(`${prefix}${BLOCK}`).blocks).toHaveLength(1);
  });

  test("an orphaned or mismatched BEGIN is text: it absorbs neither user lines nor a later block", () => {
    const orphan = `${BEGIN.replace("3f2a9c1e", "old")}\nKEEP ME\n`;
    const mismatched = `${BEGIN}\n<!-- maxims:end @example-user/rules -->\nKEEP ME\n`;
    for (const prefix of [orphan, mismatched]) {
      const text = replaceBlock(prefix, SOURCE, BLOCK);
      expect(text).toBe(`${prefix}\n${BLOCK}`);
      expect(parseBlocks(text).blocks.map((block) => text.slice(block.start, block.end))).toEqual([
        BLOCK,
      ]);
      expect(stripBlock(text, SOURCE)).toEqual({ text: prefix, emptied: false });
    }
  });

  test("a second block for one source is kept out of the result with a warning", () => {
    const parsed = parseBlocks(`${BLOCK}\n${OTHER}\n${BLOCK}`);
    expect(parsed.blocks.map((block) => block.source)).toEqual([SOURCE, "@example-user/rules"]);
    expect(parsed.warnings).toEqual([`two managed blocks for ${SOURCE}; keeping the first`]);
  });

  test("a local-source path carrying a Unicode line separator still round-trips", () => {
    const source = "/home/user/notes\u2028more";
    const text = renderBlock(input({ markers: "counted", source }));
    expect(parseBlocks(text).blocks.map((block) => block.source)).toEqual([source]);
  });

  test("a byte order mark stays outside the pair and survives a replacement", () => {
    const text = `\uFEFF${BLOCK}`;
    const parsed = parseBlocks(text);
    expect(parsed.blocks.map((block) => text.slice(block.start, block.end))).toEqual([BLOCK]);
    expect(replaceBlock(text, SOURCE, OTHER)).toBe(`\uFEFF${OTHER}`);
  });

  test("CRLF line endings still delimit the pair", () => {
    const text = BLOCK.replaceAll("\n", "\r\n");
    const parsed = parseBlocks(text);
    expect(parsed.blocks).toHaveLength(1);
    expect(text.slice(parsed.blocks[0].start, parsed.blocks[0].end)).toBe(text);
  });
});

describe("replaceBlock and stripBlock", () => {
  const USER =
    "# My rules\n\n- keep this\n\n```md\n<!-- maxims:begin @Vivswan/skills sha=q -->\n```\n";

  test("replacing preserves every byte outside the pair, including a quoted marker in a fence", () => {
    const before = `${USER}\n${BLOCK}\n- and this\n`;
    const next = renderBlock(input({ markers: "counted", sha: "deadbee", lines: [GATE] }));
    expect(replaceBlock(before, SOURCE, next)).toBe(`${USER}\n${next}\n- and this\n`);
  });

  test("only the first of two blocks for a source is replaced", () => {
    const next = renderBlock(input({ markers: "counted", lines: [] }));
    expect(replaceBlock(`${BLOCK}\n${BLOCK}`, SOURCE, next)).toBe(`${next}\n${BLOCK}`);
  });

  const appends: [string, string, string][] = [
    ["an empty file", "", BLOCK],
    ["a newline-terminated file", "# Mine\n", `# Mine\n\n${BLOCK}`],
    ["a file missing its final newline", "# Mine", `# Mine\n\n${BLOCK}`],
    ["a CRLF-terminated file, blank line in its own style", "# Mine\r\n", `# Mine\r\n\r\n${BLOCK}`],
    ["a lone-CR-terminated file, blank line in its own style", "# Mine\r", `# Mine\r\r${BLOCK}`],
    ["a file holding another source's block", OTHER, `${OTHER}\n${BLOCK}`],
    [
      "a file ending inside an open fence",
      "# Mine\n````js\ncode\n",
      ["# Mine\n````js\ncode\n````\n\n", BLOCK].join(""),
    ],
    [
      "a file ending inside an open comment",
      "# Mine\n<!--\nnote\n",
      `# Mine\n<!--\nnote\n-->\n\n${BLOCK}`,
    ],
    [
      "a fence quoted inside a closed comment",
      "<!--\n```\n-->\n",
      ["<!--\n```\n-->\n\n", BLOCK].join(""),
    ],
    [
      "a closed pre block holding a fence line",
      "<pre>\n```\n</pre>\n",
      ["<pre>\n```\n</pre>\n\n", BLOCK].join(""),
    ],
    [
      "a fence opened inside a list item, which the block's own markers end",
      "- a\n  ```\n  x\n- b\n",
      ["- a\n  ```\n  x\n- b\n\n", BLOCK].join(""),
    ],
    [
      "a file ending inside a list item's fence, which the block's own markers end",
      "- a\n  ```\n  x\n",
      ["- a\n  ```\n  x\n\n", BLOCK].join(""),
    ],
    [
      "a file ending inside a custom tag block, which the blank line closes",
      "<custom>\nx\n",
      `<custom>\nx\n\n${BLOCK}`,
    ],
    [
      "a fence closed on a line ended by a lone carriage return",
      "```\n```\rtext\n",
      ["```\n```\rtext\n\n", BLOCK].join(""),
    ],
    [
      "a file ending inside an open pre block",
      "<pre>\ncode\n",
      ["<pre>\ncode\n</pre>\n\n", BLOCK].join(""),
    ],
    ["a file ending inside an open processing instruction", "<?php\n", `<?php\n?>\n\n${BLOCK}`],
    [
      "a pre block closed by another literal tag's end",
      "<pre>\nx\n</style>\n",
      `<pre>\nx\n</style>\n\n${BLOCK}`,
    ],
    [
      "a pre tag broken by a non-breaking space, which is text",
      "<pre\u00a0>\nx\n",
      `<pre\u00a0>\nx\n\n${BLOCK}`,
    ],
    ["a lowercase doctype, which is text", "<!doctype\nx\n", `<!doctype\nx\n\n${BLOCK}`],
    [
      "a file ending inside a block tag, which the blank line closes",
      "<div>\nx\n",
      `<div>\nx\n\n${BLOCK}`,
    ],
    [
      "a closed fence whose info string holds a line separator",
      "```js\u2028\nx\n```\n",
      ["```js\u2028\nx\n```\n\n", BLOCK].join(""),
    ],
    [
      "a fence left open by a closer with a trailing non-breaking space",
      "```\nx\n```\u00a0\n",
      ["```\nx\n```\u00a0\n```\n\n", BLOCK].join(""),
    ],
  ];
  test.each(appends)("an absent block is appended after %s", (_label, before, expected) => {
    expect(replaceBlock(before, SOURCE, BLOCK)).toBe(expected);
    expect(parseBlocks(expected).blocks.map((block) => block.source)).toContain(SOURCE);
  });

  const strips: [string, string, { text: string; emptied: boolean }][] = [
    ["a block alone", BLOCK, { text: "", emptied: true }],
    ["a block after user text", `# Mine\n\n${BLOCK}`, { text: "# Mine\n", emptied: false }],
    ["a block after CRLF text", `# Mine\r\n\r\n${BLOCK}`, { text: "# Mine\r\n", emptied: false }],
    ["a block after lone-CR text", `# Mine\r\r${BLOCK}`, { text: "# Mine\r", emptied: false }],
    [
      "a block after one CRLF, which is one ending",
      `# Mine\r\n${BLOCK}`,
      { text: "# Mine\r\n", emptied: false },
    ],
    ["a block between user texts", `a\n\n${BLOCK}\nb\n`, { text: "a\n\nb\n", emptied: false }],
    ["a block glued to user text", `a\n\n${BLOCK}b\n`, { text: "a\n\nb\n", emptied: false }],
    ["a block beside another source's", `${OTHER}\n${BLOCK}`, { text: OTHER, emptied: false }],
    ["whitespace only around a block", `\n\n${BLOCK}\n`, { text: "\n\n", emptied: true }],
    ["no block at all", "# Mine\n", { text: "# Mine\n", emptied: false }],
    ["no block in a blank file", "\n", { text: "\n", emptied: false }],
  ];
  test.each(strips)("stripping %s", (_label, text, expected) => {
    expect(stripBlock(text, SOURCE)).toEqual(expected);
  });
});

// mulberry32: a tiny seeded generator so a failing case is reproducible from its seed alone.
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const PIECES = [
  "-->",
  "<!--",
  "<!-->",
  "@",
  "@~/.ssh/id_rsa",
  "@../../secrets.env",
  "#file:x",
  "`",
  "``",
  "```",
  "\\",
  "\\`",
  "<",
  '<b title="`">',
  "[x](",
  "](`",
  "]",
  "*",
  "_",
  "~~",
  "<b>",
  "</b>",
  "[x]: ",
  "<![CDATA[",
  "<?",
  "<div>",
  "\u2028",
  '"',
  "<pre>",
  "~~~",
  "\n",
  "\r\n",
  " ",
  "\t",
  "\u00a0",
  "\u65e5\u672c\u8a9e",
  "\u00e9",
  "\u{1F600}",
  "a",
  "word",
  "-",
  "(",
  ")",
  END,
  BEGIN,
  "<!-- maxims:end @Vivswan/skills",
];

function pick<T>(random: () => number, items: readonly T[]): T {
  return items[Math.floor(random() * items.length)];
}

function text(random: () => number, pieces: readonly string[], target: number): string {
  let out = "";
  while (out.length < target) out += pick(random, pieces);
  return out;
}

function length(random: () => number): number {
  return random() < 0.05 ? 10_000 : Math.floor(random() * 64);
}

// The oracle is Bun's own Markdown parser rather than a copy of the renderer's rules. Claude Code's
// import walker runs its pattern over each lexed text token, so every chunk Bun reports (a code
// span, emphasis, strikethrough, a link or image, an inline tag, an escape, or the text between
// them) is rendered as its own token, whatever Bun reads as code is replaced, and a reference is any
// `@` that opens a token or follows whitespace. Bun decodes entities and splits text around them;
// the walker reads their raw spelling, so `&` is masked before parsing and no entity decodes. A
// link reference definition renders to nothing at all, so a blank reading falls back to the raw line.
const BOUNDARY = "\u0000";
const IMPORT = /(?:^|\s)(@(?:[^\s\\]|\\ )+)/g;

function exposedReferences(rendered: string): string[] {
  const bounded = (children: string) => `${BOUNDARY}${children}${BOUNDARY}`;
  const visible = Bun.markdown.render(rendered.replaceAll("&", "\u0001"), {
    text: bounded,
    codespan: () => bounded("code"),
    code: () => bounded("code"),
    html: bounded,
    emphasis: bounded,
    strong: bounded,
    strikethrough: bounded,
    link: bounded,
    image: bounded,
  });
  const basis = visible.replaceAll(BOUNDARY, "").trim() === "" ? rendered : visible;
  return basis
    .split(BOUNDARY)
    .flatMap((token) => [
      ...Array.from(token.matchAll(IMPORT), (match) => match[1]),
      ...token.split(/\s+/).filter((word) => /^#[a-z]+:/i.test(word)),
    ]);
}

describe("properties over arbitrary description bytes", () => {
  const controls: [string, string[]][] = [
    ["- see @foo and `@bar` and `` @baz` ``", ["@foo"]],
    ["- \\` @foo ` and #file:x", ["@foo", "#file:x"]],
    ['- [x](y " @foo ") and `@ok`', []],
    ["- [x]: @foo", ["@foo"]],
    ["- [x]( @foo ) and ![y]( #file:x )", []],
    ["- [x](@foo) and `@bar&#96;` and *@baz*", ["@baz"]],
    ["- *@foo* and `` `@x` ``", ["@foo"]],
    ["- _@foo_ and ~~@bar~~ and **@baz**", ["@foo", "@bar", "@baz"]],
    ['- see <b>@foo</b> and <b title=">">@bar', ["@foo", "@bar"]],
    ["- see `x`@foo and \\!@bar and [@baz](y)", ["@foo", "@bar", "@baz"]],
    ["- see [x](y)@foo and ![i](y)@bar", ["@foo", "@bar"]],
    ["- see (@foo) x@foo ;@foo [x](@foo) &#92;@foo &#64;foo x&#32;@foo", []],
    ["- \t\t@bar sits in an indented code block", []],
  ];
  test.each(controls)(
    "negative control: the oracle reads %j the way the import walker does",
    (line, expected) => {
      expect(exposedReferences(line)).toEqual(expected);
    },
  );

  const random = rng(20260920);
  const cases = Array.from({ length: 250 }, (_, i) => i);

  test.each(cases)(
    "case %i: the pair round-trips, renders identically, escapes and stays at column 0",
    (i) => {
      const expands = pick(random, [["at-import"], [], ["none"]] as ExpansionSyntax[][]);
      const markers = pick(random, ["stripped", "counted"] as const);
      const description = text(random, PIECES, length(random));
      const detailPath = text(random, PIECES, Math.floor(random() * 24));
      const blockInput = input({
        markers,
        expands,
        lines: [{ name: RUBBER_DUCK.name, description, detailPath, shortHash: "h" }, GATE],
        stale: random() < 0.5 ? { since: "2026-09-01T00:00:00Z", kind: "age" } : undefined,
        selfRefresh: random() < 0.5,
        frontmatter: random() < 0.3 ? '---\napplyTo: "**"\n---\n' : undefined,
      });
      const rendered = renderBlock(blockInput);
      const parsed = parseBlocks(rendered);
      expect(parsed.warnings, `seed case ${i}`).toEqual([]);
      expect(parsed.blocks.map((block) => rendered.slice(block.start, block.end))).toEqual([
        rendered.slice(rendered.indexOf(BEGIN)),
      ]);
      expect(parsed.blocks[0]).toMatchObject({ source: SOURCE, sha: "3f2a9c1e" });
      expect(renderBlock(blockInput)).toBe(rendered);

      const lines = rendered.split("\n");
      const markerLines = lines.filter((l) => l.includes("<!-- maxims:"));
      expect(markerLines.every((l) => l.startsWith("<!-- maxims:"))).toBe(true);
      expect(markerLines).toHaveLength(2);
      if (expands.length === 0 || expands.includes("at-import")) {
        for (const l of lines.filter((l) => l.startsWith("- "))) {
          expect(
            exposedReferences(l).filter((t) => t.startsWith("@")),
            `seed case ${i}`,
          ).toEqual([]);
        }
      }
      if (expands.length === 0) {
        for (const l of lines.filter((l) => l.startsWith("- "))) {
          expect(exposedReferences(l), `seed case ${i}`).toEqual([]);
        }
      }
    },
  );

  const surroundings = PIECES.filter((piece) => piece !== BEGIN && piece !== END);
  const opensBlock = ["```", "~~~", "<!--", "<pre>", "<![CDATA[", "<?", "<div>"];
  const flat = surroundings.filter((piece) => !opensBlock.includes(piece));

  test.each(cases)(
    "case %i: appending into arbitrary user text preserves it and strips back out",
    (i) => {
      const before = text(random, flat, length(random));
      const after = replaceBlock(before, SOURCE, BLOCK);
      expect(after.startsWith(before), `seed case ${i}`).toBe(true);
      const parsed = parseBlocks(after);
      expect(parsed.blocks.filter((block) => block.source === SOURCE)).toHaveLength(1);
      if (before === "" || /[\r\n]$/.test(before)) {
        expect(stripBlock(after, SOURCE).text, `seed case ${i}`).toBe(before);
      }
      const fenced = text(random, surroundings, length(random));
      const withFences = replaceBlock(fenced, SOURCE, BLOCK);
      expect(withFences.startsWith(fenced), `seed case ${i}`).toBe(true);
      expect(
        parseBlocks(withFences).blocks.filter((block) => block.source === SOURCE),
      ).toHaveLength(1);
    },
  );
});
