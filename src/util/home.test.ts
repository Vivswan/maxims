// Guards store-path derivation: two local sources sharing a basename must not share an entry, and
// a github entry must fold case so one repo never lands in two folders.
import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { homePaths, storePathFor } from "./home.ts";

describe("storePathFor", () => {
  const home = "/home/user/.agents/maxims";
  const store = homePaths(home).store;

  test("github sources key on lower-cased owner/repo", () => {
    const path = storePathFor(home, { type: "github", repo: "Example-User/Rules", ref: "HEAD" });
    expect(path).toBe(join(store, "example-user", "rules"));
    expect(storePathFor(home, { type: "github", repo: "example-user/rules", ref: "v1" })).toBe(
      path,
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
      storePathFor(home, { type: "git", url: "git@gitlab.example.com:team/sub/rules", ref: "v1" }),
    ).toBe(https);
    expect(
      storePathFor(home, { type: "git", url: "ssh://git@gitea.example.com:2222/a/b", ref: "HEAD" }),
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
