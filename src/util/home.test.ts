// Guards store-path derivation: two local sources sharing a basename must not share an entry, and
// a github entry must fold case so one repo never lands in two folders.
import { describe, expect, test } from "bun:test";
import { basename, join } from "node:path";
import { homePaths, storePathFor } from "./home.ts";

describe("storePathFor", () => {
  const home = "/home/user/.agents/maxims";
  const store = homePaths(home).store;

  test("github sources key on lower-cased owner/repo", () => {
    const path = storePathFor(home, { type: "github", repo: "Example-User/Rules", ref: "HEAD" });
    expect(path).toBe(join(store, "example-user", "rules"));
    expect(storePathFor(home, { type: "github", repo: "example-user/rules", ref: "HEAD" })).toBe(
      path,
    );
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
    expect(tracking).toBe(join(store, "acme", "rules"));
    expect(pinnedV2).toMatch(new RegExp(`^${join(store, "acme", "rules@v2-")}[0-9a-f]{8}$`));
    expect(new Set([tracking, pinnedV2, pinnedSlash, pinnedDash, hosted]).size).toBe(5);
    const longRef = storePathFor(home, {
      type: "github",
      repo: "acme/rules",
      ref: "r".repeat(250),
    });
    expect(basename(longRef).length).toBeLessThan(80);
    expect(longRef).not.toBe(
      storePathFor(home, { type: "github", repo: "acme/rules", ref: "r".repeat(251) }),
    );
    expect(hosted).toBe(join(store, "_github", "github.example.com", "acme", "rules"));
    const gitPinned = storePathFor(home, {
      type: "git",
      url: "https://gitlab.example.com/team/rules.git",
      ref: "v2",
    });
    expect(gitPinned).toMatch(
      new RegExp(`^${join(store, "_git", "gitlab.example.com", "team", "rules@v2-")}[0-9a-f]{8}$`),
    );
  });

  test("git remotes key on host and path under _git, with .git stripped and slashes kept", () => {
    const https = storePathFor(home, {
      type: "git",
      url: "https://GitLab.example.com/team/sub/rules.git",
      ref: "HEAD",
    });
    expect(https).toBe(join(store, "_git", "gitlab.example.com", "team", "sub", "rules"));
    expect(
      storePathFor(home, {
        type: "git",
        url: "git@gitlab.example.com:team/sub/rules",
        ref: "HEAD",
      }),
    ).toBe(https);
    expect(
      storePathFor(home, { type: "git", url: "ssh://git@gitea.example.com/a/b", ref: "HEAD" }),
    ).toBe(join(store, "_git", "gitea.example.com", "a", "b"));
    expect(
      storePathFor(home, { type: "git", url: "git@gitea.example.com:/srv/a/b.git", ref: "HEAD" }),
    ).toBe(join(store, "_git", "gitea.example.com", "srv", "a", "b"));
  });

  test("local sources with the same basename get distinct entries under _local", () => {
    const a = storePathFor(home, { type: "local", path: "/home/user/dotfiles/memories" });
    const b = storePathFor(home, { type: "local", path: "/home/user/work/notes/memories" });
    expect(a).not.toBe(b);
    expect(a).toMatch(new RegExp(`^${join(store, "_local", "memories-")}[0-9a-f]{8}$`));
    expect(b).toMatch(new RegExp(`^${join(store, "_local", "memories-")}[0-9a-f]{8}$`));
    expect(
      storePathFor(home, { type: "local", path: "/home/user/dotfiles/memories", live: true }),
    ).toBe(a);
  });
});

// The canonical key keeps the URL verbatim, so two ports are two sources; the store must not fold
// them onto one directory where a fetch of one would overwrite the other.
test("a git remote's port becomes part of the store host segment", () => {
  const home = "/home/user/.agents/maxims";
  const store = homePaths(home).store;
  const at = (url: string) => storePathFor(home, { type: "git", url, ref: "HEAD" });
  expect(at("ssh://git@git.example.com:2222/team/rules")).toBe(
    join(store, "_git", "git.example.com_2222", "team", "rules"),
  );
  expect(at("ssh://git@git.example.com:2223/team/rules")).toBe(
    join(store, "_git", "git.example.com_2223", "team", "rules"),
  );
  expect(at("ssh://git@git.example.com/team/rules")).toBe(
    join(store, "_git", "git.example.com", "team", "rules"),
  );
  expect(at("https://git.example.com:443/team/rules")).toBe(
    join(store, "_git", "git.example.com", "team", "rules"),
  );
});
