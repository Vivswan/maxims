// Guards store-path derivation: two local sources sharing a basename must not share an entry, a
// github entry must fold case so one repo never lands in two folders, and the derived path must
// already be the proven-inside-root type that a store write accepts, so no caller re-asserts it.
// Also guards the pending root: a held revision must land where the store entry would, under
// `pending/` instead of `store/`, or a pinned source's hold would be swapped into its tracking
// twin's slot.
import { expect, test } from "bun:test";
import { basename, relative, resolve, sep } from "node:path";
import type { SourceFrom } from "../../src/contracts/source.ts";
import type { RootedPath } from "../../src/util/fs.ts";
import { homePaths, pendingPathFor, storePathFor } from "../../src/util/home.ts";

const home = resolve("/home/user/.agents/maxims");

// The layout is spelled with forward slashes so one table holds on either separator.
function under(root: string, path: string): string {
  return relative(root, path).split(sep).join("/");
}

// An entry's trailing eight-hex-digit digest is spelled `<hex8>`, so every row stays a literal
// path with its dots and separators exact; a digest of the wrong length is left unmasked.
function masked(layout: string): string {
  return layout.replace(/-[0-9a-f]{8}$/, "-<hex8>");
}

// Every source variant, pins, hosts and ports included: its entry under the store, which a held
// revision mirrors under the pending root.
const layouts: [string, SourceFrom, string][] = [
  [
    "a github source, owner and repo folded to lower case",
    { type: "github", repo: "Example-User/Rules", ref: "HEAD" },
    "example-user/rules",
  ],
  [
    "the same github source already in lower case",
    { type: "github", repo: "example-user/rules", ref: "HEAD" },
    "example-user/rules",
  ],
  [
    "an enterprise github host",
    { type: "github", repo: "acme/rules", ref: "HEAD", host: "github.example.com" },
    "_github/github.example.com/acme/rules",
  ],
  [
    "a pinned github source",
    { type: "github", repo: "acme/rules", ref: "v2" },
    "acme/rules@v2-<hex8>",
  ],
  [
    "a pin holding a character no directory name takes",
    { type: "github", repo: "acme/rules", ref: "release/1.0" },
    "acme/rules@release-1.0-<hex8>",
  ],
  [
    "an https git remote, host folded, .git stripped, slashes kept",
    { type: "git", url: "https://GitLab.example.com/team/sub/rules.git", ref: "HEAD" },
    "_git/gitlab.example.com/team/sub/rules",
  ],
  [
    "the same git remote in scp form",
    { type: "git", url: "git@gitlab.example.com:team/sub/rules", ref: "HEAD" },
    "_git/gitlab.example.com/team/sub/rules",
  ],
  [
    "an ssh git remote",
    { type: "git", url: "ssh://git@gitea.example.com/a/b", ref: "HEAD" },
    "_git/gitea.example.com/a/b",
  ],
  [
    "an scp git remote with an absolute path",
    { type: "git", url: "git@gitea.example.com:/srv/a/b.git", ref: "HEAD" },
    "_git/gitea.example.com/srv/a/b",
  ],
  [
    "a git remote with a port",
    { type: "git", url: "ssh://git@git.example.com:2222/team/rules", ref: "HEAD" },
    "_git/git.example.com_2222/team/rules",
  ],
  [
    "a git remote with another port",
    { type: "git", url: "ssh://git@git.example.com:2223/team/rules", ref: "HEAD" },
    "_git/git.example.com_2223/team/rules",
  ],
  [
    "a git remote on its scheme's default port",
    { type: "git", url: "https://git.example.com:443/team/rules", ref: "HEAD" },
    "_git/git.example.com/team/rules",
  ],
  [
    "a pinned git remote",
    { type: "git", url: "https://gitlab.example.com/team/rules.git", ref: "v2" },
    "_git/gitlab.example.com/team/rules@v2-<hex8>",
  ],
  [
    "a pinned git remote with a port",
    { type: "git", url: "ssh://git@git.example.com:2222/team/rules.git", ref: "v2" },
    "_git/git.example.com_2222/team/rules@v2-<hex8>",
  ],
  [
    "a copied local directory",
    { type: "local", path: "/home/user/dotfiles/memories" },
    "_local/memories-<hex8>",
  ],
  [
    "a second local directory sharing the basename",
    { type: "local", path: "/home/user/work/notes/memories" },
    "_local/memories-<hex8>",
  ],
];

test.each(layouts)("%s lays out alike under the store and the pending root", (_title, from, at) => {
  const entry: RootedPath = storePathFor(home, from);
  const held: RootedPath = pendingPathFor(home, from);
  const inStore = under(homePaths(home).store, entry);
  expect(masked(inStore)).toBe(at);
  expect(under(home, held)).toBe(`pending/${inStore}`);
});

// What the rows above cannot show through a masked digest: a pin stays apart from its tracking
// twin, from the same repo on an enterprise host, and from a ref that sanitizes or truncates alike;
// two local directories sharing a basename stay apart; the capped name stays well under NAME_MAX;
// and copying or living in place is not a different source.
test("distinct sources get distinct entries, and a live local source shares its copied twin's", () => {
  const github = (ref: string) => storePathFor(home, { type: "github", repo: "acme/rules", ref });
  const local = (path: string) => storePathFor(home, { type: "local", path });
  const entries = [
    github("HEAD"),
    github("v2"),
    github("release/1.0"),
    github("release-1.0"),
    github("r".repeat(250)),
    github("r".repeat(251)),
    storePathFor(home, {
      type: "github",
      repo: "acme/rules",
      ref: "HEAD",
      host: "github.example.com",
    }),
    local("/home/user/dotfiles/memories"),
    local("/home/user/work/notes/memories"),
  ];
  expect(new Set(entries).size).toBe(entries.length);
  expect(basename(github("r".repeat(250))).length).toBeLessThan(80);
  expect<string>(
    storePathFor(home, { type: "local", path: "/home/user/dotfiles/memories", live: true }),
  ).toBe(local("/home/user/dotfiles/memories"));
});
