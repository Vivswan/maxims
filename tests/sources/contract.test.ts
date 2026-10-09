// Guards the resolver contract against widening: if the members reverted to method shorthand, a
// resolver typed for one source variant would silently become assignable to the slot typed for
// every variant. That pin is compile-time only, so the typecheck gate is its test. `needsFetch`
// is pinned at runtime: a live source that fetched, or an equal sha that fetched again, would cost
// every session start.
import { describe, expect, test } from "bun:test";
import type { SourceFrom } from "../../src/contracts/source.ts";
import { type FetchResult, needsFetch, type SourceResolver } from "../../src/sources/contract.ts";

type GithubFrom = Extract<SourceFrom, { type: "github" }>;

const empty: Omit<FetchResult, "sha"> = { memoryPath: "memories", files: [] };
const githubOnly: SourceResolver<GithubFrom> = {
  resolveRef: async (from, pin) => `${from.repo}@${pin ?? from.ref}`,
  fetch: async (from) => ({ ...empty, sha: from.repo }),
};

// @ts-expect-error a resolver for one variant is not a resolver for every variant
const widened: SourceResolver = githubOnly;
void widened;

const SHA = "0123abc0123abc0123abc0123abc0123abc01234";
const FROM = { type: "github" as const, repo: "Example-User/rules", ref: "HEAD" };

describe("needsFetch", () => {
  const cases: [string, Parameters<typeof needsFetch>, boolean][] = [
    ["equal shas skip the fetch", [FROM, SHA, SHA], false],
    ["a changed sha fetches", [FROM, "sha256:old", SHA], true],
    ["a never-fetched source fetches", [FROM, undefined, SHA], true],
    [
      "a copied local source compares like a remote",
      [{ type: "local", path: "/home/user/m" }, "a", "b"],
      true,
    ],
    [
      "a live local source never fetches",
      [{ type: "local", path: "/home/user/m", live: true }, undefined, "b"],
      false,
    ],
  ];
  test.each(cases)("%s", (_label, args, expected) => {
    expect(needsFetch(...args)).toBe(expected);
  });
});
