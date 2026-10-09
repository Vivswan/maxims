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
});

describe("resolveWikilinks", () => {
  const INSTALLED = new Set(["already-installed", "gate-exit-conditions-the-merge-dotfiles"]);
  const RENAME = { "gate-exit-conditions-the-merge": "gate-exit-conditions-the-merge-dotfiles" };

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
        memory("two", "links [[gate-exit-conditions-the-merge]] by its upstream name"),
        memory("three", "links [[gate-exit-conditions-the-merge-dotfiles]] by its local name"),
      ],
      installed: INSTALLED,
      rename: RENAME,
      unmet: [],
    },
    {
      title: "an incoming memory renamed in this install satisfies links to either of its names",
      incoming: [
        memory("gate-exit-conditions-the-merge", "the renamed one"),
        memory(
          "user",
          "[[gate-exit-conditions-the-merge]] and [[gate-exit-conditions-the-merge-dotfiles]]",
        ),
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
