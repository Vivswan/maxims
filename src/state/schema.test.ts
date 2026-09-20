// Guards the state boundary: a corrupt or hand-edited file must be refused whole rather than half
// obeyed, a newer file must never be rewritten, and the source grammar must keep `owner/repo`,
// URLs, `.` and relative paths landing on the shapes the rest of the tool switches on.
import { describe, expect, test } from "bun:test";
import { type MemoryName, parseMemoryName } from "../memory/contract.ts";
import { ExitCode, type MaximsError } from "../util/exit-codes.ts";
import {
  CURRENT_STATE_VERSION,
  canonicalSourceKey,
  emptyState,
  parseSourceArgument,
  parseSourceSelector,
  parseState,
  type SourceFrom,
} from "./schema.ts";

function memoryName(candidate: string): MemoryName {
  const name = parseMemoryName(candidate);
  if (name === null) throw new Error(`test fixture name is not kebab-case: ${candidate}`);
  return name;
}

const RUBBER_DUCK = memoryName("rubber-duck-before-every-commit");

const VALID = {
  version: 1,
  writtenBy: "maxims@0.4.1",
  hooks: ["claude-code", "codex"],
  sources: {
    "@example-user/rules": {
      intent: {
        from: { type: "github", repo: "example-user/rules", ref: "HEAD" },
        select: ["rubber-duck-before-every-commit"],
        rename: { "gate-exit-conditions-the-merge": "gate-exit-conditions-the-merge-dotfiles" },
        rule: true,
        destination: { scope: "global" },
        copy: false,
        auth: true,
        harnesses: ["claude-code", "codex"],
      },
      fetched: {
        at: "2026-08-27T04:12:09.113Z",
        sha: "fc675572711b0a1c9e0000000000000000000000",
        memoryPath: "memories",
        memories: {
          "rubber-duck-before-every-commit": {
            content: `sha256:${"9f".repeat(32)}`,
            description: `sha256:${"11".repeat(32)}`,
          },
        },
        lastError: null,
      },
      addedAt: "2026-08-20T08:38:04.471Z",
    },
    "https://gitlab.example.com/team/rules.git": {
      intent: {
        from: { type: "git", url: "https://gitlab.example.com/team/rules.git", ref: "HEAD" },
        select: "*",
        rename: {},
        rule: false,
        destination: { scope: "project" },
        copy: false,
        harnesses: ["codex"],
      },
      addedAt: "2026-08-20T08:38:04.471Z",
    },
    "/home/user/dotfiles/memories": {
      intent: {
        from: { type: "local", path: "/home/user/dotfiles/memories", live: true },
        select: "*",
        rename: {},
        rule: true,
        destination: { scope: "out", path: "/home/user/team-rules" },
        copy: true,
        harnesses: ["claude-code"],
        memoryPath: "notes",
        fullDepth: true,
        paths: ["src/**"],
      },
      addedAt: "2026-08-20T08:38:04.471Z",
    },
  },
};

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

describe("parseState", () => {
  test("a valid v1 file parses with intent defaults filled in", () => {
    const result = parseState(clone(VALID));
    expect(result.ok).toBe("parsed");
    if (result.ok !== "parsed") return;
    const github = result.state.sources["@example-user/rules"];
    expect(github?.intent.memoryPath).toBe("memories");
    expect(github?.intent.fullDepth).toBe(false);
    expect(github?.intent.auth).toBe(true);
    const git = result.state.sources["https://gitlab.example.com/team/rules.git"];
    expect(git?.intent.from.type).toBe("git");
    expect(git?.intent.auth).toBe(false);
    expect(github !== undefined && "fetched" in github).toBe(true);
    if (github === undefined || !("fetched" in github)) return;
    expect(github.fetched?.memories[RUBBER_DUCK]?.content).toMatch(/^sha256:/);
    const local = result.state.sources["/home/user/dotfiles/memories"];
    expect(local?.intent.from).toEqual({
      type: "local",
      path: "/home/user/dotfiles/memories",
      live: true,
    });
    expect(local?.intent.memoryPath).toBe("notes");
    expect(local !== undefined && "fetched" in local).toBe(false);
  });

  test("a newer version is reported as such, never parsed", () => {
    expect(parseState({ version: CURRENT_STATE_VERSION + 1, anything: true })).toEqual({
      ok: "newer",
      version: CURRENT_STATE_VERSION + 1,
    });
    expect(parseState({ version: 99 })).toEqual({ ok: "newer", version: 99 });
  });

  const corrupt: { title: string; mutate: (json: typeof VALID) => unknown; issue: RegExp }[] = [
    { title: "not an object", mutate: () => "state", issue: /expected object/i },
    { title: "a fractional version", mutate: (j) => ({ ...j, version: 1.5 }), issue: /^version:/ },
    { title: "missing version", mutate: (j) => ({ ...j, version: undefined }), issue: /^version:/ },
    {
      title: "a -g destination smuggling an -o path",
      mutate: (j) => {
        (j.sources["@example-user/rules"].intent.destination as Record<string, unknown>).path =
          "/x";
        return j;
      },
      issue: /destination/,
    },
    {
      title: "a pinned local source",
      mutate: (j) => {
        (j.sources["/home/user/dotfiles/memories"].intent.from as Record<string, unknown>).ref =
          "v1";
        return j;
      },
      issue: /intent\.from/,
    },
    {
      title: "a live local source carrying a fetched block",
      mutate: (j) => {
        j.sources["/home/user/dotfiles/memories"] = {
          ...j.sources["/home/user/dotfiles/memories"],
          fetched: j.sources["@example-user/rules"].fetched,
        } as (typeof j.sources)["/home/user/dotfiles/memories"];
        return j;
      },
      issue: /fetched/,
    },
    {
      title: "a source key that is not the canonical key",
      mutate: (j) => ({ ...j, sources: { "@Other/name": j.sources["@example-user/rules"] } }),
      issue: /source key must be @example-user\/rules/,
    },
    {
      title: "an unknown source type",
      mutate: (j) => {
        (j.sources["@example-user/rules"].intent.from as Record<string, unknown>).type = "gitlab";
        return j;
      },
      issue: /intent\.from/,
    },
    {
      title: "a git source whose URL is not a usable remote",
      mutate: (j) => {
        j.sources["https://gitlab.example.com/team/rules.git"].intent.from.url = "not-a-url";
        return j;
      },
      issue: /git remote URL/,
    },
    {
      title: "a traversal name in select",
      mutate: (j) => {
        j.sources["@example-user/rules"].intent.select = ["../../x"];
        return j;
      },
      issue: /kebab-case memory name/,
    },
    {
      title: "an unknown harness id",
      mutate: (j) => ({ ...j, hooks: ["claude-code", "vim"] }),
      issue: /^hooks\.1:/,
    },
    {
      title: "a relative local path",
      mutate: (j) => {
        j.sources["/home/user/dotfiles/memories"].intent.from.path = "dotfiles/memories";
        return j;
      },
      issue: /absolute path/,
    },
    {
      title: "two github keys that differ only in case",
      mutate: (j) => ({
        ...j,
        sources: {
          ...j.sources,
          "@Example-User/Rules": {
            ...j.sources["@example-user/rules"],
            intent: {
              ...j.sources["@example-user/rules"].intent,
              from: { type: "github", repo: "Example-User/Rules", ref: "HEAD" },
            },
          },
        },
      }),
      issue: /sources\.@Example-User\/Rules: .*same GitHub repository as @example-user\/rules/,
    },
    {
      title: "a local source path carrying NUL",
      mutate: (j) => {
        const from = { type: "local", path: "/home/user/a\u0000b", live: true };
        return {
          ...j,
          sources: {
            [from.path]: {
              ...j.sources["/home/user/dotfiles/memories"],
              intent: { ...j.sources["/home/user/dotfiles/memories"].intent, from },
            },
          },
        };
      },
      issue: /intent\.from\.path: .*NUL/,
    },
    {
      title: "an out destination path carrying NUL",
      mutate: (j) => {
        j.sources["/home/user/dotfiles/memories"].intent.destination = {
          scope: "out",
          path: "/home/user/team\u0000rules",
        };
        return j;
      },
      issue: /destination\.path: .*NUL/,
    },
    {
      title: "an unknown key in intent",
      mutate: (j) => {
        (j.sources["@example-user/rules"].intent as Record<string, unknown>).installedPath = "/x";
        return j;
      },
      issue: /installedPath/,
    },
  ];
  test.each(corrupt)("is corrupt: $title", ({ mutate, issue }) => {
    const result = parseState(mutate(clone(VALID)));
    expect(result.ok).toBe("corrupt");
    if (result.ok !== "corrupt") return;
    expect(result.issues.some((line) => issue.test(line))).toBe(true);
  });

  test("emptyState round-trips through the parser", () => {
    const state = emptyState("maxims@0.0.0");
    expect(parseState(clone(state))).toEqual({ ok: "parsed", state });
  });
});

describe("parseSourceArgument", () => {
  const cwd = "/home/user/project";
  const github = (repo: string): SourceFrom => ({ type: "github", repo, ref: "HEAD" });
  const git = (url: string): SourceFrom => ({ type: "git", url, ref: "HEAD" });
  const accepted: [string, SourceFrom][] = [
    ["https://gitlab.example.com/team/rules.git", git("https://gitlab.example.com/team/rules.git")],
    [
      "ssh://git@gitea.example.com:2222/team/rules",
      git("ssh://git@gitea.example.com:2222/team/rules"),
    ],
    ["git@gitlab.example.com:team/rules.git", git("git@gitlab.example.com:team/rules.git")],
    [
      "git@gitlab.example.com:/srv/team/rules.git",
      git("git@gitlab.example.com:/srv/team/rules.git"),
    ],
    ["git@gitlab.example.com:.git/rules.git", git("git@gitlab.example.com:.git/rules.git")],
    ["git@github.com:example-user/rules.git", github("example-user/rules")],
    [
      "https://mirror.example.com/github.com/example-user/rules",
      git("https://mirror.example.com/github.com/example-user/rules"),
    ],
    [
      "https://dev.azure.com/org/project/_git/repo",
      git("https://dev.azure.com/org/project/_git/repo"),
    ],
    [
      "https://github.com/example-user/rules/tree/main",
      { type: "github", repo: "example-user/rules", ref: "main" },
    ],
    [
      "https://github.com/example-user/rules/tree/release.git",
      { type: "github", repo: "example-user/rules", ref: "release.git" },
    ],
    [
      "https://github.com/example-user/rules/tree/release@2026",
      { type: "github", repo: "example-user/rules", ref: "release@2026" },
    ],
    [
      "https://github.com/example-user/rules.git/tree/v1",
      { type: "github", repo: "example-user/rules", ref: "v1" },
    ],
    ["@Example-User/rules", github("Example-User/rules")],
    ["example-user/rules", github("example-user/rules")],
    ["https://github.com/example-user/rules", github("example-user/rules")],
    ["https://github.com/example-user/rules.git", github("example-user/rules")],
    ["https://github.com/example-user/rules/", github("example-user/rules")],
    ["https://GitHub.com/Example-User/rules", github("Example-User/rules")],
    [".", { type: "local", path: cwd, live: true }],
    ["./memories", { type: "local", path: `${cwd}/memories` }],
    ["../shared/memories", { type: "local", path: "/home/user/shared/memories" }],
    ["/home/user/dotfiles/memories", { type: "local", path: "/home/user/dotfiles/memories" }],
    ["memories", { type: "local", path: `${cwd}/memories` }],
  ];
  test.each(accepted)("%s", (arg, expected) => {
    expect(parseSourceArgument(arg, cwd)).toEqual(expected);
  });

  test("a pinned source and its tracking twin are distinct keys; an enterprise host is named", () => {
    expect(canonicalSourceKey({ type: "github", repo: "acme/rules", ref: "HEAD" })).toBe(
      "@acme/rules",
    );
    expect(canonicalSourceKey({ type: "github", repo: "acme/rules", ref: "v2" })).toBe(
      "@acme/rules#v2",
    );
    expect(
      canonicalSourceKey({
        type: "github",
        repo: "acme/rules",
        ref: "HEAD",
        host: "github.example.com",
      }),
    ).toBe("@github.example.com/acme/rules");
    expect(
      canonicalSourceKey({ type: "git", url: "https://gitlab.example.com/a/b", ref: "1.0" }),
    ).toBe("https://gitlab.example.com/a/b#1.0");
  });

  test("the @owner/repo@memory-name suffix selects one memory", () => {
    expect(parseSourceSelector("@example-user/rules@rubber-duck-before-every-commit", cwd)).toEqual(
      {
        from: github("example-user/rules"),
        memory: RUBBER_DUCK,
      },
    );
    expect(parseSourceSelector("example-user/rules", cwd)).toEqual({
      from: github("example-user/rules"),
      memory: null,
    });
    const attempts: (() => unknown)[] = [
      () => parseSourceSelector("@example-user/rules@NotKebab", cwd),
      () => parseSourceSelector("@example-user/rules@", cwd),
      () => parseSourceSelector("@example-user/rules@one@two", cwd),
      () => parseSourceArgument("@example-user/rules@rubber-duck-before-every-commit", cwd),
    ];
    for (const attempt of attempts) {
      let caught: unknown;
      try {
        attempt();
      } catch (error) {
        caught = error;
      }
      expect((caught as MaximsError).code).toBe(ExitCode.Usage);
    }
  });

  // GH_HOST is an ambient environment variable: a github.com URL pasted from a browser must keep
  // meaning github.com whatever the shell happens to export, or the same command line would
  // install a different source on a differently configured machine.
  test("GH_HOST names the host for shorthands and its own URLs; a github.com URL is always github.com", () => {
    const ghHost = "github.example.com";
    const hosted: SourceFrom = { type: "github", repo: "team/rules", ref: "HEAD", host: ghHost };
    const cases: [string, SourceFrom][] = [
      ["https://github.example.com/team/rules", hosted],
      ["git@github.example.com:team/rules.git", hosted],
      ["@team/rules", hosted],
      ["team/rules", hosted],
      ["https://github.com/team/rules", github("team/rules")],
      ["git@github.com:team/rules.git", github("team/rules")],
      [
        "https://github.com/team/rules/tree/main",
        { type: "github", repo: "team/rules", ref: "main" },
      ],
      ["https://gitlab.example.com/team/rules", git("https://gitlab.example.com/team/rules")],
    ];
    for (const [arg, expected] of cases) {
      expect(parseSourceArgument(arg, cwd, { ghHost })).toEqual(expected);
    }
    expect(parseSourceArgument("@team/rules", cwd, { ghHost: "github.com" })).toEqual(
      github("team/rules"),
    );
    expect(parseSourceArgument("@team/rules", cwd, { ghHost: "GitHub.Example.com" })).toEqual(
      hosted,
    );
    expect(
      parseSourceArgument("https://gitlab.example.com/team/rules", cwd, { ghHost: "" }),
    ).toEqual(git("https://gitlab.example.com/team/rules"));
  });

  const rejected = [
    "",
    "@only-owner",
    "@a/b/c",
    "ftp://gitlab.example.com/a/b",
    "https://github.com/only-owner",
    "https://github.com/example-user/rules/blob/main/README.md",
    "https://gitlab.example.com/team/.git",
    "https://gitlab.example.com/acme/rules/..git",
    "git@gitlab.example.com:acme/rules#v2",
    "git@gitlab.example.com:acme/rules@v2-fb04dcb6",
    "https://gitlab.example.com/acme/rules#v2",
    "https://gitlab.example.com/acme/rules#",
    "https://gitlab.example.com/...git",
    "https://github.com/example-user/rules/tree/release/1.0",
    "https://gitlab.example.com/team/100%.git",
    "https://gitlab.example.com/team/a%00b.git",
    "https://gitlab.example.com/team/a%2Fb.git",
    "https://github.com/example-user%2Frules.git",
    "git@gitlab.example.com:/",
    "git@..:example-user/rules.git",
    "git@gitlab.example.com:a/../b",
    "https://gitlab.example.com/",
    "~/dotfiles",
    "@-bad/repo",
    "@octocat/..",
    "@octocat/.",
  ];
  test.each(rejected)("rejects %j as a usage error", (arg) => {
    let caught: unknown;
    try {
      parseSourceArgument(arg, cwd);
    } catch (error) {
      caught = error;
    }
    expect((caught as MaximsError).code).toBe(ExitCode.Usage);
  });
});
