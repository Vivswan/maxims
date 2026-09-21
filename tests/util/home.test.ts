// Guards store-path derivation: two local sources sharing a basename must not share an entry, a
// github entry must fold case so one repo never lands in two folders, and the derived path must
// already be the proven-inside-root type that a store write accepts, so no caller re-asserts it.
// Also guards the pending root: a held revision must land where the store entry would, under
// `pending/` instead of `store/`, or a pinned source's hold would be swapped into its tracking
// twin's slot.
import { describe, expect, test } from "bun:test";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import type { SourceFrom } from "../../src/contracts/source.ts";
import type { RootedPath } from "../../src/util/fs.ts";
import { homePaths, pendingPathFor, storePathFor } from "../../src/util/home.ts";

describe("storePathFor", () => {
  const home = resolve("/home/user/.agents/maxims");
  const store = homePaths(home).store;

  test("github sources key on lower-cased owner/repo", () => {
    const path: RootedPath = storePathFor(home, {
      type: "github",
      repo: "Example-User/Rules",
      ref: "HEAD",
    });
    expect<string>(path).toBe(join(store, "example-user", "rules"));
    expect<string>(
      storePathFor(home, { type: "github", repo: "example-user/rules", ref: "HEAD" }),
    ).toBe(path);
  });

  test("a pin or an enterprise host gives a source its own store entry", () => {
    const tracking = storePathFor(home, { type: "github", repo: "acme/rules", ref: "HEAD" });
    const pinnedV2 = storePathFor(home, { type: "github", repo: "acme/rules", ref: "v2" });
    const pinnedSlash = storePathFor(home, {
      type: "github",
      repo: "acme/rules",
      ref: "release/1.0",
    });
    const pinnedDash = storePathFor(home, {
      type: "github",
      repo: "acme/rules",
      ref: "release-1.0",
    });
    const hosted = storePathFor(home, {
      type: "github",
      repo: "acme/rules",
      ref: "HEAD",
      host: "github.example.com",
    });
    expect<string>(tracking).toBe(join(store, "acme", "rules"));
    expect(dirname(pinnedV2)).toBe(join(store, "acme"));
    expect(basename(pinnedV2)).toMatch(/^rules@v2-[0-9a-f]{8}$/);
    expect(new Set([tracking, pinnedV2, pinnedSlash, pinnedDash, hosted]).size).toBe(5);
    const longRef = storePathFor(home, {
      type: "github",
      repo: "acme/rules",
      ref: "r".repeat(250),
    });
    expect(basename(longRef).length).toBeLessThan(80);
    expect<string>(longRef).not.toBe(
      storePathFor(home, { type: "github", repo: "acme/rules", ref: "r".repeat(251) }),
    );
    expect<string>(hosted).toBe(join(store, "_github", "github.example.com", "acme", "rules"));
    const gitPinned = storePathFor(home, {
      type: "git",
      url: "https://gitlab.example.com/team/rules.git",
      ref: "v2",
    });
    expect(dirname(gitPinned)).toBe(join(store, "_git", "gitlab.example.com", "team"));
    expect(basename(gitPinned)).toMatch(/^rules@v2-[0-9a-f]{8}$/);
  });

  test("git remotes key on host and path under _git, with .git stripped and slashes kept", () => {
    const https = storePathFor(home, {
      type: "git",
      url: "https://GitLab.example.com/team/sub/rules.git",
      ref: "HEAD",
    });
    expect<string>(https).toBe(join(store, "_git", "gitlab.example.com", "team", "sub", "rules"));
    expect<string>(
      storePathFor(home, {
        type: "git",
        url: "git@gitlab.example.com:team/sub/rules",
        ref: "HEAD",
      }),
    ).toBe(https);
    expect<string>(
      storePathFor(home, { type: "git", url: "ssh://git@gitea.example.com/a/b", ref: "HEAD" }),
    ).toBe(join(store, "_git", "gitea.example.com", "a", "b"));
    expect<string>(
      storePathFor(home, { type: "git", url: "git@gitea.example.com:/srv/a/b.git", ref: "HEAD" }),
    ).toBe(join(store, "_git", "gitea.example.com", "srv", "a", "b"));
  });

  test("local sources with the same basename get distinct entries under _local", () => {
    const a = storePathFor(home, { type: "local", path: "/home/user/dotfiles/memories" });
    const b = storePathFor(home, { type: "local", path: "/home/user/work/notes/memories" });
    expect<string>(a).not.toBe(b);
    for (const entry of [a, b]) {
      expect(dirname(entry)).toBe(join(store, "_local"));
      expect(basename(entry)).toMatch(/^memories-[0-9a-f]{8}$/);
    }
    expect<string>(
      storePathFor(home, { type: "local", path: "/home/user/dotfiles/memories", live: true }),
    ).toBe(a);
  });
});

// Every source variant, pins and hosts included, pinned to the layout the store test pins for the
// same sources: a held revision lands at the store entry's own place under `pending/`, so a hold of
// a pinned source can never be swapped into its tracking twin's slot.
const HEX8 = "[0-9a-f]{8}";
const heldSources: [string, SourceFrom, string | RegExp][] = [
  [
    "a tracking github source",
    { type: "github", repo: "Acme/Rules", ref: "HEAD" },
    "pending/acme/rules",
  ],
  [
    "a pinned github source",
    { type: "github", repo: "acme/rules", ref: "release/1.0" },
    new RegExp(`^pending/acme/rules@release-1.0-${HEX8}$`),
  ],
  [
    "an enterprise github source",
    { type: "github", repo: "acme/rules", ref: "HEAD", host: "github.example.com" },
    "pending/_github/github.example.com/acme/rules",
  ],
  [
    "a git remote with a port and a pin",
    { type: "git", url: "ssh://git@git.example.com:2222/team/rules.git", ref: "v2" },
    new RegExp(`^pending/_git/git.example.com_2222/team/rules@v2-${HEX8}$`),
  ],
  [
    "a copied local directory",
    { type: "local", path: "/home/user/dotfiles/memories" },
    new RegExp(`^pending/_local/memories-${HEX8}$`),
  ],
];
test.each(heldSources)("pendingPathFor lays %s out under the pending root", (_title, from, at) => {
  const home = resolve("/home/user/.agents/maxims");
  const held: RootedPath = pendingPathFor(home, from);
  // The layout is spelled with forward slashes so the same table holds on either separator.
  const inHome = relative(home, held).split(sep).join("/");
  if (typeof at === "string") expect(inHome).toBe(at);
  else expect(inHome).toMatch(at);
  expect(relative(homePaths(home).store, storePathFor(home, from))).toBe(
    relative(homePaths(home).pending, held),
  );
});

// The canonical key keeps the URL verbatim, so two ports are two sources; the store must not fold
// them onto one directory where a fetch of one would overwrite the other.
test("a git remote's port becomes part of the store host segment", () => {
  const home = resolve("/home/user/.agents/maxims");
  const store = homePaths(home).store;
  const at = (url: string) => storePathFor(home, { type: "git", url, ref: "HEAD" });
  expect<string>(at("ssh://git@git.example.com:2222/team/rules")).toBe(
    join(store, "_git", "git.example.com_2222", "team", "rules"),
  );
  expect<string>(at("ssh://git@git.example.com:2223/team/rules")).toBe(
    join(store, "_git", "git.example.com_2223", "team", "rules"),
  );
  expect<string>(at("ssh://git@git.example.com/team/rules")).toBe(
    join(store, "_git", "git.example.com", "team", "rules"),
  );
  expect<string>(at("https://git.example.com:443/team/rules")).toBe(
    join(store, "_git", "git.example.com", "team", "rules"),
  );
});
