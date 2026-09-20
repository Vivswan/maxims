// Guards decision 16 through decision 17: a link written against an upstream name must still
// resolve after a collision rename, and a dangling link must surface as the unmet dependency.
import { describe, expect, test } from "bun:test";
import type { Memory } from "./contract.ts";
import { extractWikilinks, resolveWikilinks } from "./wikilinks.ts";

function memory(name: string, body: string): Memory {
  return {
    name: name as Memory["name"],
    description: name,
    body,
    metadata: { extra: {} },
    raw: body,
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
  const installed = new Set(["already-installed", "gate-exit-conditions-the-merge-dotfiles"]);
  const rename = { "gate-exit-conditions-the-merge": "gate-exit-conditions-the-merge-dotfiles" };

  test("resolves within the install set, among installed names, and through the rename map", () => {
    const incoming = [
      memory("one", "links [[two]] and [[already-installed]]"),
      memory("two", "links [[gate-exit-conditions-the-merge]] by its upstream name"),
      memory("three", "links [[gate-exit-conditions-the-merge-dotfiles]] by its local name"),
    ];
    expect(resolveWikilinks(incoming, installed, rename)).toEqual({ unmet: [] });
  });

  test("an incoming memory renamed in this install satisfies links to either of its names", () => {
    const incoming = [
      memory("gate-exit-conditions-the-merge", "the renamed one"),
      memory(
        "user",
        "[[gate-exit-conditions-the-merge]] and [[gate-exit-conditions-the-merge-dotfiles]]",
      ),
    ];
    expect(resolveWikilinks(incoming, new Set(), rename)).toEqual({ unmet: [] });
  });

  test("reports every dangling link with the memory that carries it", () => {
    const incoming = [
      memory("one", "[[missing-a]] [[already-installed]] [[missing-b]]"),
      memory("two", "[[missing-a]]"),
    ];
    expect(resolveWikilinks(incoming, installed, {})).toEqual({
      unmet: [
        { memory: "one", link: "missing-a" },
        { memory: "one", link: "missing-b" },
        { memory: "two", link: "missing-a" },
      ],
    });
  });
});
