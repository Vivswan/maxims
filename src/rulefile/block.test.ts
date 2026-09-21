// Guards the managed-block grammar against the harnesses that read it: a marker that fails to
// round-trip leaves a block sync can never find again (so it appends forever), an unescaped `@`
// token is a file-read primitive on Claude Code, and any byte changed outside the pair is a user's
// hand-written rule silently rewritten. None of that is enforced by anything but these rows.
import { describe, expect, test } from "bun:test";
import type { MemoryName } from "../memory/contract.ts";
import { ExitCode, MaximsError } from "../util/exit-codes.ts";
import { ownLineMatcher, parseBlocks, renderBlock, replaceBlock, stripBlock } from "./block.ts";
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
  "<!-- update: npx -y @vivswan/maxims add @Vivswan/skills | remove: npx -y @vivswan/maxims remove @Vivswan/skills -->",
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
    "- If the staleness line above is present, run `npx -y @vivswan/maxims sync --quiet` before continuing.";

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

// A line that only opens like one of the renderer's own is a hand edit that the regeneration
// silently discards unless these rows hold; the notice's timestamp is the one part matched by shape.
describe("ownLineMatcher", () => {
  const NOTICE_MISSING =
    "- maxims: the rules below from `@Vivswan/skills` have not refreshed since 2026-09-01T00:00:00.000Z (source repository gone or unreadable, they will never refresh) and may be out of date.";
  const NOTICE_AGE =
    "- maxims: the rules below from `@Vivswan/skills` have not refreshed since 2026-09-01T00:00:00Z (no successful fetch) and may be out of date.";
  const SELF_REFRESH =
    "- If the staleness line above is present, run `npx -y @vivswan/maxims sync --quiet` before continuing.";
  const NOTICE_UNWRAPPED =
    "- maxims: the rules below from @Vivswan/skills have not refreshed since 2026-09-01T00:00:00Z (rate limited) and may be out of date.";
  const rows: [string, boolean][] = [
    [BEGIN, true],
    [END, true],
    [PROVENANCE[0], true],
    [PROVENANCE[1], true],
    [SELF_REFRESH, true],
    [NOTICE_MISSING, true],
    [NOTICE_AGE, true],
    [NOTICE_UNWRAPPED, true],
    [PROVENANCE[0].replace("overwritten", "preserved"), false],
    [PROVENANCE[1].replace(" | remove: npx -y @vivswan/maxims remove @Vivswan/skills", ""), false],
    [`${SELF_REFRESH} Really.`, false],
    [NOTICE_AGE.replace("and may be out of date.", "and must be ignored."), false],
    [NOTICE_AGE.replace("no successful fetch", "server on fire"), false],
    [NOTICE_AGE.replace("2026-09-01T00:00:00Z", "yesterday"), false],
    [NOTICE_AGE.replace("2026-09-01T00:00:00Z", "2026-99-01T00:00:00Z"), false],
    [NOTICE_AGE.replace("`@Vivswan/skills`", "`@example-user/rules`"), false],
    ["- maxims: the rules below from upstream are mine.", false],
    [RUBBER_DUCK_LINE, false],
  ];
  const isOwn = ownLineMatcher(SOURCE);
  test.each(rows)("%s -> %p", (text, own) => {
    expect(isOwn(text)).toBe(own);
  });
});

const BLOCK = renderBlock(input({ markers: "counted" }));
const OTHER = renderBlock(input({ markers: "counted", source: "@example-user/rules", sha: "b" }));
const ZETA = renderBlock(input({ markers: "counted", source: "@zeta/rules", sha: "z" }));

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

  // `@Vivswan/skills` sorts before `@example-user/rules`: an upper-case letter's code unit is
  // lower. The file must not remember which source arrived first.
  const OTHER_SOURCE = "@example-user/rules";
  const ORDERED = `${BLOCK}\n${OTHER}`;
  const arrivals: [string, string][] = [
    ["ours first", replaceBlock(replaceBlock("", SOURCE, BLOCK), OTHER_SOURCE, OTHER)],
    ["theirs first", replaceBlock(replaceBlock("", OTHER_SOURCE, OTHER), SOURCE, BLOCK)],
  ];
  test.each(arrivals)(
    "two sources arriving %s leave the blocks in source order",
    (_label, text) => {
      expect(text).toBe(ORDERED);
    },
  );

  test("a new block joins the run right after the last block, ahead of the user's text below it", () => {
    const before = `intro\n\n${OTHER}\nnotes\n`;
    expect(replaceBlock(before, SOURCE, BLOCK)).toBe(`intro\n\n${ORDERED}\nnotes\n`);
  });

  test("the run keeps its slots: user text between two blocks stays between the two slots", () => {
    const before = `intro\n\n${OTHER}\nbetween\n\n${BLOCK}\n`;
    const next = renderBlock(input({ markers: "counted", lines: [GATE] }));
    expect(replaceBlock(before, SOURCE, next)).toBe(`intro\n\n${next}\nbetween\n\n${OTHER}\n`);
  });

  test("a block that ends the file without a newline gains one when the run is re-dealt", () => {
    const trimmed = OTHER.slice(0, -1);
    expect(replaceBlock(trimmed, SOURCE, BLOCK)).toBe(ORDERED);
    expect(replaceBlock(trimmed, "@zeta/rules", ZETA)).toBe(`${OTHER}\n${ZETA}`);
  });

  test("a file already in source order is spliced in place, byte for byte", () => {
    const next = renderBlock(input({ markers: "counted", lines: [GATE] }));
    expect(replaceBlock(`${ORDERED}\ntrailing`, SOURCE, next)).toBe(`${next}\n${OTHER}\ntrailing`);
    expect(replaceBlock(ORDERED, SOURCE, BLOCK)).toBe(ORDERED);
  });

  // Dealing the blocks by source must not hand a hand-duplicated pair the first pair's place: that
  // pair is the one the parser keeps, so the second pass would overwrite the duplicate the user made.
  test("a duplicated pair keeps its slot and its text through a re-sort, and a second pass changes nothing", () => {
    const stale = renderBlock(input({ markers: "counted", source: OTHER_SOURCE, sha: "old" }));
    const duplicate = renderBlock(input({ markers: "counted", source: OTHER_SOURCE, sha: "dup" }));
    const once = replaceBlock(`${stale}\n${duplicate}\n${BLOCK}`, OTHER_SOURCE, OTHER);
    expect(once).toBe(`${BLOCK}\n${OTHER}\n${duplicate}`);
    expect(replaceBlock(once, OTHER_SOURCE, OTHER)).toBe(once);
  });

  // A lone CR closing a moved block, followed by the LF that opens the gap after its new slot,
  // would read as one CRLF ending on the next pass and take the user's blank line with it.
  test("a moved block is closed with LF, so a lone CR never merges with the gap's LF, and later passes change nothing", () => {
    const carriage = BLOCK.replaceAll("\n", "\r");
    const before = `${OTHER}\nuser notes\n${carriage}`;
    const afterOther = replaceBlock(before, OTHER_SOURCE, OTHER);
    expect(afterOther).toBe(`${carriage.slice(0, -1)}\n\nuser notes\n${OTHER}`);
    const afterBoth = replaceBlock(afterOther, SOURCE, BLOCK);
    expect(afterBoth).toBe(`${BLOCK}\nuser notes\n${OTHER}`);
    expect(replaceBlock(afterBoth, OTHER_SOURCE, OTHER)).toBe(afterBoth);
    expect(replaceBlock(afterBoth, SOURCE, BLOCK)).toBe(afterBoth);
  });

  test("stripping the block that heads a run shifts the rest into its slots and closes the last slot", () => {
    expect(stripBlock(`intro\n${ORDERED}`, SOURCE)).toEqual({
      text: `intro\n${OTHER}`,
      emptied: false,
    });
  });

  // A BEGIN and END the user left around a block are plain text only while a marker stands between
  // them. Closing the slot the removal would otherwise close can put them back to back, and the
  // next sync would read the user's lines between them as a block to remove.
  const STRAY = "@stray/notes";
  const STRAY_BEGIN = `<!-- maxims:begin ${STRAY} sha=old -->\n`;
  const STRAY_END = `<!-- maxims:end ${STRAY} -->\n`;
  const strayPairs: [string, string, string, string][] = [
    [
      "a stray pair around the second of two blocks, removing the first",
      `${BLOCK}\n${STRAY_BEGIN}KEEP ME\n${OTHER}\n${STRAY_END}`,
      SOURCE,
      `\n${STRAY_BEGIN}KEEP ME\n${OTHER}\n${STRAY_END}`,
    ],
    [
      "a stray pair around the first of two blocks, removing the first",
      `${STRAY_BEGIN}KEEP ME\n${BLOCK}\n${STRAY_END}${OTHER}`,
      SOURCE,
      `${STRAY_BEGIN}KEEP ME\n${OTHER}\n${STRAY_END}`,
    ],
    [
      "a stray pair around the first of two blocks, removing the second",
      `${STRAY_BEGIN}KEEP ME\n${BLOCK}\n${STRAY_END}${OTHER}`,
      OTHER_SOURCE,
      `${STRAY_BEGIN}KEEP ME\n${BLOCK}\n${STRAY_END}`,
    ],
    [
      "a stray END right after the removed block, its BEGIN before",
      `${STRAY_BEGIN}KEEP ME\n${BLOCK}${STRAY_END}\n${OTHER}`,
      SOURCE,
      `${STRAY_BEGIN}KEEP ME\n${OTHER}${STRAY_END}`,
    ],
    [
      "a stray pair around the last of three blocks, removing the middle one",
      `${BLOCK}\n${OTHER}\n${STRAY_BEGIN}KEEP ME\n${ZETA}\n${STRAY_END}`,
      OTHER_SOURCE,
      `${BLOCK}\n${STRAY_BEGIN}KEEP ME\n${ZETA}\n${STRAY_END}`,
    ],
    [
      "a stray pair around the last of three blocks, removing the first",
      `${BLOCK}\n${OTHER}\n${STRAY_BEGIN}KEEP ME\n${ZETA}\n${STRAY_END}`,
      SOURCE,
      `${OTHER}\n${STRAY_BEGIN}KEEP ME\n${ZETA}\n${STRAY_END}`,
    ],
    [
      "a stray pair in CRLF endings around the second of two blocks",
      `${BLOCK}\r\n${STRAY_BEGIN.replace("\n", "\r\n")}KEEP ME\r\n${OTHER}\r\n${STRAY_END.replace("\n", "\r\n")}`,
      SOURCE,
      `\r\n${STRAY_BEGIN.replace("\n", "\r\n")}KEEP ME\r\n${OTHER}\r\n${STRAY_END.replace("\n", "\r\n")}`,
    ],
  ];
  const keys = (text: string): string[] => parseBlocks(text).blocks.map((block) => block.source);
  test.each(strayPairs)(
    "removing %s leaves the pair as text, and a second removal changes nothing",
    (_label, before, source, expected) => {
      const stripped = stripBlock(before, source);
      expect(stripped).toEqual({ text: expected, emptied: false });
      expect(keys(expected)).toEqual(keys(before).filter((key) => key !== source));
      expect(stripBlock(expected, source).text).toBe(expected);
    },
  );

  // No slot can close without pairing the user's markers, or without a fence the join opens
  // swallowing a kept block: the removal is refused rather than written, since the next sync
  // would take the user's lines with the pair it made or the block it lost.
  const USER_OTHER = `<!-- maxims:begin ${OTHER_SOURCE} sha=user -->\nKEEP USER TEXT\n<!-- maxims:end ${OTHER_SOURCE} -->\n`;
  const refusals: [string, string, string][] = [
    ["a stray pair around the only block", `${STRAY_BEGIN}KEEP ME\n${BLOCK}\n${STRAY_END}`, STRAY],
    [
      "stray pairs nested around the only block",
      `${STRAY_BEGIN}<!-- maxims:begin @inner/notes sha=old -->\nKEEP ME\n${BLOCK}<!-- maxims:end @inner/notes -->\n${STRAY_END}`,
      "@inner/notes",
    ],
    [
      "two stray pairs interleaved around two blocks",
      `${STRAY_BEGIN}KEEP ME\n${BLOCK}${STRAY_END}<!-- maxims:begin @inner/notes sha=old -->\nAND ME\n${OTHER}<!-- maxims:end @inner/notes -->\n`,
      "@inner/notes",
    ],
    [
      "a stray END hidden in a lone-tag HTML block that the join turns into paragraph text",
      `${STRAY_BEGIN}notes\n${BLOCK}<span>\nKEEP ME\n${STRAY_END}`,
      STRAY,
    ],
    [
      "a fence hidden in a lone-tag HTML block that the join opens over the kept block",
      `notes\n${BLOCK}<span>\n~~~\n\n${STRAY_BEGIN}KEEP ME\n${OTHER}\n${STRAY_END}`,
      STRAY,
    ],
    [
      "a fence the join opens over the kept block, with a user pair under its key past the fence",
      `notes\n${BLOCK}<span>\n~~~\n\n${STRAY_BEGIN}KEEP ME\n${OTHER}\n${STRAY_END}~~~\n${USER_OTHER}`,
      STRAY,
    ],
  ];
  test.each(refusals)(
    "removing the block inside %s is refused, naming the pair",
    (_label, text, key) => {
      let caught: unknown;
      try {
        stripBlock(text, SOURCE);
      } catch (error) {
        caught = error;
      }
      expect(caught).toBeInstanceOf(MaximsError);
      if (!(caught instanceof MaximsError)) return;
      expect(caught.code).toBe(ExitCode.DestinationWriteFailed);
      expect(caught.message).toBe(
        `removing the ${SOURCE} block would pair the stray maxims markers for ${key} around it into a managed block`,
      );
      expect(caught.hint).toBe(
        'edit or delete the stray "maxims:begin" and "maxims:end" lines around the block, then retry',
      );
    },
  );

  // Adding a source and removing it again gives back the user's bytes whatever slot the new block
  // took: the slot the run opened at its end is the one the removal closes.
  const roundTrips: [string, string, string, string][] = [
    [
      "a new first block with user text between the others",
      `${OTHER}\nuser notes\n${ZETA}`,
      SOURCE,
      BLOCK,
    ],
    [
      "a new middle block behind a CRLF separator",
      `${BLOCK}\r\n${ZETA}notes\n`,
      OTHER_SOURCE,
      OTHER,
    ],
    ["a new first block after lone-CR text", `intro\r\r${OTHER}`, SOURCE, BLOCK],
    [
      "a new last block with text glued below the first",
      `${BLOCK}user notes\n`,
      OTHER_SOURCE,
      OTHER,
    ],
  ];
  test.each(roundTrips)(
    "adding then removing %s restores the file",
    (_label, before, source, block) => {
      const added = replaceBlock(before, source, block);
      expect(added).not.toBe(before);
      expect(stripBlock(added, source).text).toBe(before);
    },
  );

  // A closer kept from disk made the bytes depend on which source the engine refreshed first: a
  // lone CR before the LF separator read as one CRLF, which the refresh of that block then ate.
  const diskEndings: [string, string][] = [
    ["CRLF", "\r\n"],
    ["lone CR", "\r"],
  ];
  test.each(diskEndings)(
    "a block on disk in %s endings is closed with LF, so refresh order cannot show",
    (_label, ending) => {
      const onDisk = BLOCK.replaceAll("\n", ending);
      const before = `${onDisk}notes\n`;
      const otherFirst = replaceBlock(replaceBlock(before, OTHER_SOURCE, OTHER), SOURCE, BLOCK);
      const ownFirst = replaceBlock(replaceBlock(before, SOURCE, BLOCK), OTHER_SOURCE, OTHER);
      expect(otherFirst).toBe(`${BLOCK}\n${OTHER}notes\n`);
      expect(ownFirst).toBe(otherFirst);
    },
  );

  test("a duplicated pair on disk in CRLF endings is closed with LF in either refresh order", () => {
    const duplicate = renderBlock(
      input({ markers: "counted", source: OTHER_SOURCE, sha: "dup" }),
    ).replaceAll("\n", "\r\n");
    const before = `${OTHER}\n${ZETA}\n${duplicate}`;
    const refreshed = (order: [string, string][]): string =>
      stripBlock(
        order.reduce((text, [source, block]) => replaceBlock(text, source, block), before),
        "@zeta/rules",
      ).text;
    const ownFirst = refreshed([
      [SOURCE, BLOCK],
      [OTHER_SOURCE, OTHER],
    ]);
    expect(ownFirst).toBe(`${BLOCK}\n${OTHER}\n${duplicate.slice(0, -2)}\n`);
    expect(
      refreshed([
        [OTHER_SOURCE, OTHER],
        [SOURCE, BLOCK],
      ]),
    ).toBe(ownFirst);
  });

  const appends: [string, string, string][] = [
    ["an empty file", "", BLOCK],
    ["a newline-terminated file", "# Mine\n", `# Mine\n\n${BLOCK}`],
    ["a file missing its final newline", "# Mine", `# Mine\n\n${BLOCK}`],
    ["a CRLF-terminated file, blank line in its own style", "# Mine\r\n", `# Mine\r\n\r\n${BLOCK}`],
    ["a lone-CR-terminated file, blank line in its own style", "# Mine\r", `# Mine\r\r${BLOCK}`],
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
    // A blank line continues a list item and the leaf inside it absorbs it, so a fence, comment or
    // pre block left open in an item is closed at the item's column before it. With no closer the
    // blank line lands inside the user's fence (markdown-it 14.3.1 reads that form's fence content
    // as "x\n\n", the closed form's as "x\n"); a closer at column 0 would end the item and open a
    // new fence that swallows the block. A block-tag kind is closed by the blank line inside the
    // item as it is at column 0.
    [
      "a file ending inside a list item's fence, closed at the item's column",
      "- a\n  ```\n  x\n",
      ["- a\n  ```\n  x\n  ```\n\n", BLOCK].join(""),
    ],
    [
      "a CRLF file ending inside a list item's fence, closer in the file's own ending",
      "- a\r\n  ```\r\n  x\r\n",
      ["- a\r\n  ```\r\n  x\r\n  ```\r\n\r\n", BLOCK].join(""),
    ],
    [
      "a file ending inside a nested item's fence, closed at the inner item's column",
      "- a\n  - b\n    ~~~\n    x\n",
      ["- a\n  - b\n    ~~~\n    x\n    ~~~\n\n", BLOCK].join(""),
    ],
    [
      "a file ending inside an item's fence indented past the item's column",
      "- a\n    ```\n    x\n",
      ["- a\n    ```\n    x\n    ```\n\n", BLOCK].join(""),
    ],
    [
      "a file ending inside a fence under a tab-padded item, closed at the tab's column",
      "-\t```\n\tx\n",
      ["-\t```\n\tx\n    ```\n\n", BLOCK].join(""),
    ],
    [
      "a file ending inside a list item's comment, closed at the item's column",
      "- a\n  <!--\n  x\n",
      `- a\n  <!--\n  x\n  -->\n\n${BLOCK}`,
    ],
    [
      "a file ending inside a list item's pre block, closed at the item's column",
      "- a\n  <pre>\n  x\n",
      `- a\n  <pre>\n  x\n  </pre>\n\n${BLOCK}`,
    ],
    // An HTML closer indented past the item's column would put the indentation inside the user's
    // preformatted text (markdown-it 14.3.1 renders it as a trailing space run before `</pre>`).
    [
      "a file ending inside an item's pre block opened past the item's column",
      "- a\n   <pre>\n  x\n",
      `- a\n   <pre>\n  x\n  </pre>\n\n${BLOCK}`,
    ],
    [
      "a file ending inside an indented top-level pre block",
      "  <pre>\nx\n",
      `  <pre>\nx\n</pre>\n\n${BLOCK}`,
    ],
    // The parsers part here: CommonMark and commonmark.js 0.31.2 read a heading-shaped line
    // indented four columns, short of the item's five, as lazily continuing the item's paragraph,
    // so the fence on the next line opens inside the item and the closer belongs at its column.
    // markdown-it 14.3.1 and marked 16.4.2 end the item at that line and read the two lines as a
    // top-level indented code block, which the closer then joins. No one line closes the fence in
    // the first reading and stays out of the code block in the second; the scanner keeps the
    // specification's reading.
    [
      "a file ending inside an item's fence reached across a lazy heading-shaped line",
      "-    a\n    # h\n     ```\n",
      ["-    a\n    # h\n     ```\n     ```\n\n", BLOCK].join(""),
    ],
    [
      "a file ending inside a list item's block tag, which the blank line closes",
      "- a\n  <div>\n  x\n",
      `- a\n  <div>\n  x\n\n${BLOCK}`,
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
    [
      "a lowercase doctype, which opens a declaration block",
      "<!doctype\nx\n",
      `<!doctype\nx\n>\n\n${BLOCK}`,
    ],
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
  // Stripping takes back the block and its blank line, never the closer the append wrote or any
  // byte of the user's text.
  test.each(appends)("an absent block is appended after %s", (_label, before, expected) => {
    expect(replaceBlock(before, SOURCE, BLOCK)).toBe(expected);
    expect(parseBlocks(expected).blocks.map((block) => block.source)).toContain(SOURCE);
    const stripped = stripBlock(expected, SOURCE).text;
    expect(stripped.startsWith(before)).toBe(true);
    expect(parseBlocks(stripped).blocks.map((block) => block.source)).not.toContain(SOURCE);
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
    ["a block after CR then CRLF", `# Mine\r\r\n${BLOCK}`, { text: "# Mine\r", emptied: false }],
    ["a block after LF then CR", `# Mine\n\r${BLOCK}`, { text: "# Mine\n", emptied: false }],
    ["a block after CRLF then LF", `# Mine\r\n\n${BLOCK}`, { text: "# Mine\r\n", emptied: false }],
    ["a block after LF then CRLF", `# Mine\n\r\n${BLOCK}`, { text: "# Mine\n", emptied: false }],
    ["a block after nothing but CRLF endings", `\r\n\r\n${BLOCK}`, { text: "\r\n", emptied: true }],
    [
      "a block after a CRLF run that text ends, which leaves one trailing ending",
      `\r\n\r\n\r\nnotes\n${BLOCK}`,
      { text: "\r\n\r\n\r\nnotes\n", emptied: false },
    ],
    ["a block between user texts", `a\n\n${BLOCK}\nb\n`, { text: "a\n\nb\n", emptied: false }],
    ["a block glued to user text", `a\n\n${BLOCK}b\n`, { text: "a\n\nb\n", emptied: false }],
    ["a block beside another source's", `${OTHER}\n${BLOCK}`, { text: OTHER, emptied: false }],
    [
      "a block after another source's with text glued below it",
      `${OTHER}\n${BLOCK}notes\n`,
      { text: `${OTHER}notes\n`, emptied: false },
    ],
    ["whitespace only around a block", `\n\n${BLOCK}\n`, { text: "\n\n", emptied: true }],
    ["no block at all", "# Mine\n", { text: "# Mine\n", emptied: false }],
    ["no block in a blank file", "\n", { text: "\n", emptied: false }],
  ];
  test.each(strips)("stripping %s", (_label, text, expected) => {
    expect(stripBlock(text, SOURCE)).toEqual(expected);
  });

  // The gap's trailing endings were once read by a regex anchored at the end, which backtracks
  // over every way to split a CRLF run when text follows it: a session-start hook removing a
  // block behind such a run took time exponential in the run's length.
  test("a removal behind a long CRLF run finishes in linear time", () => {
    const run = "\r\n".repeat(40);
    const started = performance.now();
    const stripped = stripBlock(`${BLOCK}${run}notes\n${OTHER}`, SOURCE);
    const elapsed = performance.now() - started;
    expect(stripped).toEqual({ text: `${OTHER}${run}notes\n`, emptied: false });
    expect(elapsed).toBeLessThan(50);
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
