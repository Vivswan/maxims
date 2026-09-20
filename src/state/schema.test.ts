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
    "/home/user/shared/memories": {
      intent: {
        from: { type: "local", path: "/home/user/shared/memories" },
        select: "*",
        rename: {},
        rule: true,
        destination: { scope: "project" },
        copy: false,
        harnesses: ["claude-code"],
      },
      fetched: {
        at: "2026-08-27T04:12:09.113Z",
        sha: `sha256:${"ab".repeat(32)}`,
        memoryPath: "memories",
        memories: {},
        lastError: null,
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

  // `add --allow-hidden` accepts a source whose descriptions carry hidden characters; refresh
  // reads the same answer from intent, so the flag must survive a round trip through state and
  // must stay absent, not default to false, when it was never given.
  test("intent.allowHidden round-trips when set and stays absent when not", () => {
    const json = clone(VALID);
    (json.sources["@example-user/rules"].intent as Record<string, unknown>).allowHidden = true;
    const result = parseState(json);
    expect(result.ok).toBe("parsed");
    if (result.ok !== "parsed") return;
    expect(result.state.sources["@example-user/rules"]?.intent.allowHidden).toBe(true);
    expect(
      "allowHidden" in
        (result.state.sources["https://gitlab.example.com/team/rules.git"]?.intent ?? {}),
    ).toBe(false);
    (json.sources["@example-user/rules"].intent as Record<string, unknown>).allowHidden = "yes";
    expect(parseState(json).ok).toBe("corrupt");
  });

  // `disable <name>` at user scope records the name here; the list is kept sorted and unique so
  // two syncs that disable the same names write the same bytes and a diff of the file is readable.
  const disabledLists: [string, string[], "parsed" | "corrupt"][] = [
    ["a sorted unique list", ["alpha", "beta"], "parsed"],
    ["an empty list", [], "parsed"],
    ["an unsorted list", ["beta", "alpha"], "corrupt"],
    ["a duplicate", ["alpha", "alpha"], "corrupt"],
    ["a name that is not kebab-case", ["Alpha"], "corrupt"],
  ];
  test.each(disabledLists)("disabled: %s %p is %s", (_title, disabled, outcome) => {
    const result = parseState({ ...clone(VALID), disabled });
    expect(result.ok).toBe(outcome);
    if (result.ok === "parsed")
      expect<string[] | undefined>(result.state.disabled).toEqual(disabled);
    if (result.ok === "corrupt") expect(result.issues.some((l) => /^disabled/.test(l))).toBe(true);
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

  // The rule-file renderer asserts these as invariants of its inputs; each row shows the byte
  // that would break a marker being refused, and the same value without it parsing.
  type Refusal = { title: string; bad: string; good: string; issue: RegExp; set: Setter };
  type Setter = (j: typeof VALID, value: string) => unknown;
  const localPath: Setter = (j, value) => {
    const entry = j.sources["/home/user/dotfiles/memories"];
    return {
      ...j,
      sources: {
        [value]: {
          ...entry,
          intent: { ...entry.intent, from: { ...entry.intent.from, path: value } },
        },
      },
    };
  };
  const outPath: Setter = (j, value) => {
    j.sources["/home/user/dotfiles/memories"].intent.destination = { scope: "out", path: value };
    return j;
  };
  const githubRef: Setter = (j, value) => {
    const entry = j.sources["@example-user/rules"];
    const from = { ...entry.intent.from, ref: value };
    return {
      ...j,
      sources: {
        [`@example-user/rules#${value}`]: { ...entry, intent: { ...entry.intent, from } },
      },
    };
  };
  const gitRef: Setter = (j, value) => {
    const entry = j.sources["https://gitlab.example.com/team/rules.git"];
    const from = { ...entry.intent.from, ref: value };
    return {
      ...j,
      sources: {
        [`https://gitlab.example.com/team/rules.git#${value}`]: {
          ...entry,
          intent: { ...entry.intent, from },
        },
      },
    };
  };
  const gitUrl: Setter = (j, value) => {
    const entry = j.sources["https://gitlab.example.com/team/rules.git"];
    const from = { ...entry.intent.from, url: value };
    return { ...j, sources: { [value]: { ...entry, intent: { ...entry.intent, from } } } };
  };
  const remoteSha: Setter = (j, value) => {
    j.sources["@example-user/rules"].fetched.sha = value;
    return j;
  };
  const localSha: Setter = (j, value) => {
    j.sources["/home/user/shared/memories"].fetched.sha = value;
    return j;
  };
  const GIT_SHA = "fc675572711b0a1c9e0000000000000000000000";
  const refusals: Refusal[] = [
    {
      title: "local path with -->",
      set: localPath,
      bad: "/home/user/a-->b",
      good: "/home/user/a-b",
      issue: /intent\.from\.path: a path cannot contain -->/,
    },
    {
      title: "local path with LF",
      set: localPath,
      bad: "/home/user/a\nb",
      good: "/home/user/ab",
      issue: /intent\.from\.path: .*line break/,
    },
    {
      title: "local path with trailing space",
      set: localPath,
      bad: "/home/user/a ",
      good: "/home/user/a",
      issue: /intent\.from\.path: .*whitespace/,
    },
    {
      title: "out path with -->",
      set: outPath,
      bad: "/home/user/x-->y",
      good: "/home/user/x-y",
      issue: /destination\.path: a path cannot contain -->/,
    },
    {
      title: "out path with CR",
      set: outPath,
      bad: "/home/user/x\ry",
      good: "/home/user/xy",
      issue: /destination\.path: .*line break/,
    },
    {
      title: "out path with leading space",
      set: outPath,
      bad: " /home/user/x",
      good: "/home/user/x",
      issue: /destination\.path: .*whitespace/,
    },
    {
      title: "github ref with -->",
      set: githubRef,
      bad: "v1-->",
      good: "v1",
      issue: /intent\.from\.ref: a ref cannot contain -->/,
    },
    {
      title: "github ref with LF",
      set: githubRef,
      bad: "v1\n",
      good: "v1",
      issue: /intent\.from\.ref: .*line break/,
    },
    {
      title: "github ref with trailing space",
      set: githubRef,
      bad: "v1 ",
      good: "v1",
      issue: /intent\.from\.ref: .*whitespace/,
    },
    {
      title: "git ref with CR",
      set: gitRef,
      bad: "v1\r",
      good: "v1",
      issue: /intent\.from\.ref: .*line break/,
    },
    {
      title: "git ref with leading space",
      set: gitRef,
      bad: " v1",
      good: "v1",
      issue: /intent\.from\.ref: .*whitespace/,
    },
    {
      title: "git URL with -->",
      set: gitUrl,
      bad: "https://gitlab.example.com/team/a-->b.git",
      good: "https://gitlab.example.com/team/a-b.git",
      issue: /intent\.from\.url: expected a git remote URL/,
    },
    {
      title: "git URL with LF",
      set: gitUrl,
      bad: "https://gitlab.example.com/team/rules.git\n",
      good: "https://gitlab.example.com/team/rules.git",
      issue: /intent\.from\.url: expected a git remote URL/,
    },
    {
      title: "git URL with trailing space",
      set: gitUrl,
      bad: "https://gitlab.example.com/team/rules.git ",
      good: "https://gitlab.example.com/team/rules.git",
      issue: /intent\.from\.url: expected a git remote URL/,
    },
    {
      title: "remote sha of 39 hex digits",
      set: remoteSha,
      bad: GIT_SHA.slice(1),
      good: GIT_SHA,
      issue: /fetched\.sha: .*40-character/,
    },
    {
      title: "remote sha in upper case",
      set: remoteSha,
      bad: GIT_SHA.toUpperCase(),
      good: GIT_SHA,
      issue: /fetched\.sha: .*lower-case/,
    },
    {
      title: "remote sha given as a content hash",
      set: remoteSha,
      bad: `sha256:${"ab".repeat(32)}`,
      good: GIT_SHA,
      issue: /fetched\.sha: .*40-character/,
    },
    {
      title: "copied local sha given as a commit id",
      set: localSha,
      bad: GIT_SHA,
      good: `sha256:${"ab".repeat(32)}`,
      issue: /fetched\.sha: expected sha256/,
    },
  ];
  test.each(refusals)(
    "refuses $title and accepts the same value without it",
    ({ set, bad, good, issue }) => {
      const refused = parseState(set(clone(VALID), bad));
      expect(refused.ok).toBe("corrupt");
      if (refused.ok !== "corrupt") return;
      expect(refused.issues.some((line) => issue.test(line))).toBe(true);
      expect(parseState(set(clone(VALID), good)).ok).toBe("parsed");
    },
  );

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

  // An `@owner/repo` shorthand in the advice would be re-hosted under GH_HOST on an enterprise
  // shell, so the message must point at the URL the user already has plus the two flags.
  test("a tree URL with a path is advised without an @owner/repo shorthand", () => {
    let caught: unknown;
    try {
      parseSourceArgument("https://github.com/example-user/rules/tree/release/1.0", cwd);
    } catch (error) {
      caught = error;
    }
    const message = (caught as MaximsError).message;
    expect(message.slice(message.indexOf(": ") + 2)).not.toContain("@");
    expect(message).toContain("--pin <ref> --from <path>");
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
    "https://gitlab.example.com/team/a-->b.git",
    "https://gitlab.example.com/team/rules.git\n",
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
