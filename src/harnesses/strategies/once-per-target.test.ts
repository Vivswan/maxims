// The self-refresh line is a per-target singleton chosen by byte order: a locale-aware sort or a
// leak onto tier 1 would put two instructions in one file, or one on a harness whose hook refreshes.
import { expect, test } from "bun:test";
import { chooseSelfRefreshSource } from "./once-per-target.ts";

const cases: { tier: 1 | 2; stale: string[]; chosen: string | null }[] = [
  { tier: 1, stale: ["@a/b", "@c/d"], chosen: null },
  { tier: 2, stale: [], chosen: null },
  { tier: 2, stale: ["@zed/one", "@Alpha/two", "@alpha/three"], chosen: "@Alpha/two" },
  { tier: 2, stale: ["/home/user/notes", "@example-user/skills"], chosen: "/home/user/notes" },
];

test.each(cases)(
  "tier $tier with $stale carries the line on $chosen",
  ({ tier, stale, chosen }) => {
    expect(chooseSelfRefreshSource({ tier }, stale)).toBe(chosen);
    expect(chooseSelfRefreshSource({ tier }, [...stale].reverse())).toBe(chosen);
  },
);
