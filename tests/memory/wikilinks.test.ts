// Guards dependency resolution across a collision rename: a link written against an upstream name
// must resolve to the renamed local memory and to nothing else, and a dangling link must surface
// as the unmet dependency rather than being satisfied by another source's same-named memory.
import { describe, expect, test } from "bun:test";
import { contentHashOf, type Memory } from "../../src/memory/contract.ts";
import {
  extractWikilinks,
  resolveWikilinks,
  type UnmetWikilink,
} from "../../src/memory/wikilinks.ts";

function memory(name: string, body: string): Memory {
  return {
    name: name as Memory["name"],
    description: name,
    body,
    metadata: { extra: {} },
    raw: body,
    contentHash: contentHashOf(body),
  };
}

describe("extractWikilinks", () => {
  test("returns targets in order of first appearance, deduplicated, alias stripped", () => {
    const body = [
      "See [[alpha]] and [[beta|the beta rule]], then [[alpha]] again.",
      "Not a link: [single] or [[ ]] or [[nested [[x]]]].",
      "Trailing [[gamma]]",
    ].join("\n");
    expect(extractWikilinks(body)).toEqual(["alpha", "beta", "x", "gamma"]);
    expect(extractWikilinks("no links here")).toEqual([]);
  });

  // Without these a shell test or a TOML table shown in a memory's code becomes a dependency no source can provide, and `add` refuses the install with exit 7.
  const code: { title: string; body: string }[] = [
    { title: "a fenced shell test", body: "```bash\nif [[ -f .env ]]; then\n```" },
    { title: "a fenced TOML table array", body: "~~~toml\n[[servers]]\nname = 'a'\n~~~" },
    { title: "a fence left open to the end", body: "```\n[[servers]]" },
    { title: "indented code", body: "Run:\n\n    [[ -f .env ]] && echo yes" },
    { title: "an inline span showing the syntax", body: "Write `[[name]]` to link." },
    { title: "a double-backtick span", body: "Write ``[[name|`alias`]]`` to link." },
    { title: "a fence inside a list item", body: "- step\n\n  ```sh\n  [[ -n $x ]]\n  ```" },
    { title: "a fence inside a block quote", body: "> ```toml\n> [[servers]]\n> ```" },
  ];
  test.each(code)("$title names no dependency", ({ body }) => {
    expect(extractWikilinks(body)).toEqual([]);
  });

  // Without these the code fix could quietly drop a real dependency written inside other Markdown, and a dangling link would install unreported.
  const prose: { title: string; body: string; links: string[] }[] = [
    {
      title: "emphasis and strong",
      body: "*see [[a]]* and **[[b|the b rule]]**",
      links: ["a", "b"],
    },
    { title: "an alias carrying emphasis", body: "[[a|the *a* rule]]", links: ["a"] },
    { title: "an alias carrying a code span", body: "[[a|`--timeout`]]", links: ["a"] },
    {
      title: "an alias carrying a code span that holds brackets",
      body: "[[a|`x[0]`]]",
      links: ["a"],
    },
    { title: "a Markdown link's text", body: "[see [[a]]](https://example.com)", links: ["a"] },
    { title: "list items", body: "- [[a]]\n  1. [[b]]", links: ["a", "b"] },
    { title: "a block quote", body: "> Sibling of [[a]].", links: ["a"] },
    { title: "a heading", body: "## After [[a]]", links: ["a"] },
    { title: "a table row", body: "| rule |\n| --- |\n| [[a]] |", links: ["a"] },
    {
      title: "a target a link definition also names",
      body: "[[a]]\n\n[a]: https://example.com",
      links: ["a"],
    },
    {
      title: "prose beside code",
      body: "`[[x]]` then [[a]]\n\n```\n[[y]]\n```\n\n[[b]]",
      links: ["a", "b"],
    },
    { title: "a lone backtick, which opens no span", body: "a ` then [[a]]", links: ["a"] },
    {
      title: "a paragraph continuation indented four spaces",
      body: "text\n    [[a]]",
      links: ["a"],
    },
    {
      title:
        "a link touching a span after byte order marks, which the parser counts unlike the body",
      body: "\ufeff\ufeff[[a]]`x`",
      links: ["a"],
    },
  ];
  test.each(prose)("$title still names its dependencies", ({ body, links }) => {
    expect(extractWikilinks(body)).toEqual(links);
  });

  // The decision this pins: only Markdown code hides a link. An agent reads the raw file, so a link inside HTML or an HTML comment is still text it follows.
  const html: { title: string; body: string; links: string[] }[] = [
    {
      title: "an HTML block",
      body: "<details>\n<summary>See [[a]]</summary>\n</details>",
      links: ["a"],
    },
    { title: "an HTML comment", body: "<!-- depends on [[a]] -->", links: ["a"] },
    { title: "inline HTML", body: "text <span>[[a]]</span>", links: ["a"] },
    { title: "an HTML pre block", body: "<pre>\n[[a]]\n</pre>", links: ["a"] },
  ];
  test.each(html)("$title is not code, so its link is a dependency", ({ body, links }) => {
    expect(extractWikilinks(body)).toEqual(links);
  });
});

describe("resolveWikilinks", () => {
  const INSTALLED = new Set(["already-installed", "commit-small-and-often-dotfiles"]);
  const RENAME = { "commit-small-and-often": "commit-small-and-often-dotfiles" };

  const cases: {
    title: string;
    incoming: Memory[];
    installed: Set<string>;
    rename: Record<string, string>;
    unmet: UnmetWikilink[];
  }[] = [
    {
      title: "resolves within the install set, among installed names, and through the rename map",
      incoming: [
        memory("one", "links [[two]] and [[already-installed]]"),
        memory("two", "links [[commit-small-and-often]] by its upstream name"),
        memory("three", "links [[commit-small-and-often-dotfiles]] by its local name"),
      ],
      installed: INSTALLED,
      rename: RENAME,
      unmet: [],
    },
    {
      title: "an incoming memory renamed in this install satisfies links to either of its names",
      incoming: [
        memory("commit-small-and-often", "the renamed one"),
        memory("user", "[[commit-small-and-often]] and [[commit-small-and-often-dotfiles]]"),
      ],
      installed: new Set(),
      rename: RENAME,
      unmet: [],
    },
    {
      title: "a renamed upstream name is not satisfied by another source's memory of that name",
      incoming: [memory("caller", "needs [[alpha]]")],
      installed: new Set(["alpha"]),
      rename: { alpha: "alpha-local" },
      unmet: [{ memory: "caller", link: "alpha" }],
    },
    {
      title: "a renamed upstream name is satisfied once the renamed memory is installed",
      incoming: [memory("caller", "needs [[alpha]]")],
      installed: new Set(["alpha", "alpha-local"]),
      rename: { alpha: "alpha-local" },
      unmet: [],
    },
    {
      title: "a memory named like an Object prototype member is looked up as an own key only",
      incoming: [memory("caller", "[[constructor]] and [[has-own-property]]")],
      installed: new Set(["constructor"]),
      rename: {},
      unmet: [{ memory: "caller", link: "has-own-property" }],
    },
    {
      title: "reports every dangling link with the memory that carries it",
      incoming: [
        memory("one", "[[missing-a]] [[already-installed]] [[missing-b]]"),
        memory("two", "[[missing-a]]"),
      ],
      installed: INSTALLED,
      rename: {},
      unmet: [
        { memory: "one", link: "missing-a" },
        { memory: "one", link: "missing-b" },
        { memory: "two", link: "missing-a" },
      ],
    },
  ];
  test.each(cases)("$title", ({ incoming, installed, rename, unmet }) => {
    expect(resolveWikilinks(incoming, installed, rename)).toEqual({ unmet });
  });
});
