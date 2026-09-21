// Guards the state boundary: a corrupt or hand-edited file must be refused whole rather than half
// obeyed, a newer file must never be rewritten, and the source grammar must keep `owner/repo`,
// URLs, `.` and relative paths landing on the shapes the rest of the tool switches on.
import { describe, expect, test } from "bun:test";
import { dirname, join, resolve } from "node:path";
import type { SourceFrom } from "../../src/contracts/source.ts";
import { type MemoryName, parseMemoryName } from "../../src/memory/contract.ts";
import {
  CURRENT_STATE_VERSION,
  canonicalSourceKey,
  emptyState,
  parseSourceArgument,
  parseSourceSelector,
  parseState,
} from "../../src/state/schema.ts";
import { ExitCode, type MaximsError } from "../../src/util/exit-codes.ts";

function memoryName(candidate: string): MemoryName {
  const name = parseMemoryName(candidate);
  if (name === null) throw new Error(`test fixture name is not kebab-case: ${candidate}`);
  return name;
}

const RUBBER_DUCK = memoryName("rubber-duck-before-every-commit");

const VALID = {
  version: 1,
  writtenBy: "maxims@0.4.1",
  hooks: { global: ["claude-code", "codex"] },
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
        destination: { scope: "project", root: "/home/user/project" },
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
        destination: { scope: "project", root: "/home/user/project" },
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

  // A state written before project destinations carried their root reads as corrupt rather than as
  // every project's at once, and sharing is refused outside a project destination; the parsed
  // shapes are pinned by the v1 fixture golden in the store test.
  const destinations: [string, unknown, unknown, RegExp][] = [
    ["a project destination without a root", { scope: "project" }, undefined, /root/],
    [
      "a relative project root",
      { scope: "project", root: "./project" },
      undefined,
      /destination\.root.*absolute/,
    ],
    [
      "a shared user-scope entry",
      { scope: "global" },
      true,
      /^sources\..*shared applies to a project destination$/,
    ],
    [
      "a shared out folder",
      { scope: "out", path: "/home/user/team" },
      true,
      /shared applies to a project destination/,
    ],
  ];
  test.each(destinations)("destination refused: %s", (_title, destination, shared, issue) => {
    const json = clone(VALID);
    const intent = json.sources["@example-user/rules"].intent as Record<string, unknown>;
    intent.destination = destination;
    if (shared !== undefined) intent.shared = shared;
    const result = parseState(json);
    expect(result.ok).toBe("corrupt");
    if (result.ok === "corrupt") expect(result.issues.some((line) => issue.test(line))).toBe(true);
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

  // `add --review` and `maxims review` hold a refresh under `pending` until `accept`; the flag is
  // read back on every refresh, so it must round-trip and stay absent, never `false`, when unset.
  test("intent.review round-trips when set, stays absent when unset, and refuses false", () => {
    const json = clone(VALID);
    (json.sources["@example-user/rules"].intent as Record<string, unknown>).review = true;
    const result = parseState(json);
    expect(result.ok).toBe("parsed");
    if (result.ok !== "parsed") return;
    expect(result.state.sources["@example-user/rules"]?.intent.review).toBe(true);
    expect(
      "review" in (result.state.sources["https://gitlab.example.com/team/rules.git"]?.intent ?? {}),
    ).toBe(false);
    (json.sources["@example-user/rules"].intent as Record<string, unknown>).review = false;
    expect(parseState(json).ok).toBe("corrupt");
  });

  // A held revision records the sha of the variant it belongs to: a commit id for a remote, a
  // content hash for a copied directory, and nothing at all for a live source, whose tree is the
  // record. A `pending` on the wrong variant or with the other brand is a hand edit the file
  // refuses whole. Every row marks the source for review, so the verdict is the variant's alone.
  const pendingShapes: [string, string, unknown, "parsed" | "corrupt"][] = [
    [
      "a commit sha on a remote entry",
      "@example-user/rules",
      { sha: "b".repeat(40), at: "2026-09-01T00:00:00.000Z", summary: ["+ new-rule"] },
      "parsed",
    ],
    [
      "a content hash on a remote entry",
      "@example-user/rules",
      { sha: `sha256:${"cd".repeat(32)}`, at: "2026-09-01T00:00:00.000Z", summary: [] },
      "corrupt",
    ],
    [
      "a content hash on a copied local entry",
      "/home/user/shared/memories",
      { sha: `sha256:${"cd".repeat(32)}`, at: "2026-09-01T00:00:00.000Z", summary: [] },
      "parsed",
    ],
    [
      "a commit sha on a copied local entry",
      "/home/user/shared/memories",
      { sha: "b".repeat(40), at: "2026-09-01T00:00:00.000Z", summary: [] },
      "corrupt",
    ],
    [
      "any pending on a live entry",
      "/home/user/dotfiles/memories",
      { sha: `sha256:${"cd".repeat(32)}`, at: "2026-09-01T00:00:00.000Z", summary: [] },
      "corrupt",
    ],
    [
      "a pending without a summary",
      "@example-user/rules",
      { sha: "b".repeat(40), at: "2026-09-01T00:00:00.000Z" },
      "corrupt",
    ],
  ];
  test.each(pendingShapes)("pending: %s", (_title, key, pending, verdict) => {
    const json = clone(VALID);
    const source = json.sources[key as keyof typeof json.sources] as Record<string, unknown>;
    source.intent = { ...(source.intent as Record<string, unknown>), review: true };
    source.pending = pending;
    const result = parseState(json);
    expect(result.ok).toBe(verdict);
    if (result.ok !== "parsed") return;
    const entry = result.state.sources[key];
    expect<unknown>(entry !== undefined && "pending" in entry ? entry.pending : undefined).toEqual(
      pending,
    );
  });

  // `disable <name>` records the name in state at either scope: the global list, or the project
  // list keyed by the project root, so one file owns every answer and the project lock only
  // carries a committed copy. Each list is sorted and unique so two syncs that disable the same
  // names write the same bytes.
  // Every row has four members: a shorter row would make the runner pass its `done` callback as
  // the missing argument and wait on it.
  const disabledShapes: [string, unknown, "parsed" | "corrupt", RegExp | null][] = [
    ["a sorted global list", { global: ["alpha", "beta"] }, "parsed", null],
    [
      "sorted project lists keyed by project root",
      { project: { "/home/user/a": ["alpha"], "/home/user/b": ["beta", "gamma"] } },
      "parsed",
      null,
    ],
    ["both scopes", { global: [], project: {} }, "parsed", null],
    ["an unsorted global list", { global: ["beta", "alpha"] }, "corrupt", /^disabled\.global\.1/],
    [
      "a duplicate",
      { global: ["alpha", "alpha"] },
      "corrupt",
      /^disabled\.global\.1: listed twice/,
    ],
    ["a name that is not kebab-case", { global: ["Alpha"] }, "corrupt", /^disabled\.global\.0/],
    [
      "an unsorted project list",
      { project: { "/home/user/a": ["beta", "alpha"] } },
      "corrupt",
      /^disabled\.project\./,
    ],
    [
      "a project keyed by a relative path",
      { project: { "./a": ["alpha"] } },
      "corrupt",
      /^disabled\.project\..*absolute path/,
    ],
    ["a bare list, the shape without scopes", ["alpha"], "corrupt", /^disabled/],
  ];
  test.each(disabledShapes)("disabled: %s", (_title, disabled, outcome, issue) => {
    const result = parseState({ ...clone(VALID), disabled });
    expect(result.ok).toBe(outcome);
    if (result.ok === "parsed") expect<unknown>(result.state.disabled).toEqual(disabled);
    if (result.ok === "corrupt" && issue !== null) {
      expect(result.issues.some((line) => issue.test(line))).toBe(true);
    }
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
      title: "a harness id that is neither built-in nor kebab-case",
      mutate: (j) => ({ ...j, hooks: { global: ["claude-code", "Vim"] } }),
      issue: /^hooks\.global\.1:/,
    },
    {
      title: "a harness id with an underscore",
      mutate: (j) => ({ ...j, hooks: { global: ["claude-code", "my_agent"] } }),
      issue: /^hooks\.global\.1:/,
    },
    {
      title: "hooks as one flat list, the shape without scopes",
      mutate: (j) => ({ ...j, hooks: ["claude-code"] }),
      issue: /^hooks: /,
    },
    {
      title: "an unsorted hook list",
      mutate: (j) => ({ ...j, hooks: { global: ["codex", "claude-code"] } }),
      issue: /^hooks\.global\.1: must be sorted after codex$/,
    },
    {
      title: "a project hook list under a relative root",
      mutate: (j) => ({ ...j, hooks: { project: { "./project": ["claude-code"] } } }),
      issue: /^hooks\.project\..*absolute/,
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
  const cwd = resolve("/home/user/project");
  const dotfiles = resolve("/home/user/dotfiles/memories");
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
    ["./memories", { type: "local", path: join(cwd, "memories") }],
    ["../shared/memories", { type: "local", path: join(dirname(cwd), "shared", "memories") }],
    [dotfiles, { type: "local", path: dotfiles }],
    ["memories", { type: "local", path: join(cwd, "memories") }],
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

  // A GH_HOST or URL host that is an alias of github.com must record NO host, or the fetch ladder
  // offers the enterprise token and builds `https://api.github.com/api/v3/...`; an `api.` prefix
  // on a tenancy host must fold to the tenant, or the ladder builds `api.api.<tenant>.ghe.com`.
  // The folding is go-gh's NormalizeHostname, so gh and maxims agree on what one GH_HOST means.
  const hosted = (host: string): SourceFrom => ({
    type: "github",
    repo: "team/rules",
    ref: "HEAD",
    host,
  });
  const aliases: [string, string | undefined, SourceFrom][] = [
    ["@team/rules", "api.github.com", github("team/rules")],
    ["@team/rules", "www.github.com", github("team/rules")],
    ["@team/rules", "API.Octo.GHE.com", hosted("octo.ghe.com")],
    ["@team/rules", "octo.ghe.com", hosted("octo.ghe.com")],
    ["@team/rules", "api.github.localhost", hosted("github.localhost")],
    ["@team/rules", "GitLab.Example.com", hosted("gitlab.example.com")],
    ["https://api.github.com/example-user/rules", undefined, github("example-user/rules")],
    ["https://www.github.com/example-user/rules", undefined, github("example-user/rules")],
    ["https://api.octo.ghe.com/team/rules", "octo.ghe.com", hosted("octo.ghe.com")],
    ["https://octo.ghe.com/team/rules", "api.octo.ghe.com", hosted("octo.ghe.com")],
  ];
  test.each(aliases)("%s with GH_HOST %s folds the host like go-gh", (arg, ghHost, expected) => {
    expect(parseSourceArgument(arg, cwd, ghHost === undefined ? {} : { ghHost })).toEqual(expected);
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

// A user-defined harness id is intent like any other: a state that names one still parses even
// when harnesses.json no longer defines it, because intent is never dropped on a read.
test("a kebab-case user-defined harness id is valid state beside the built-ins", () => {
  const json = structuredClone(VALID);
  json.hooks = { global: ["acme-agent", "claude-code"] };
  json.sources["@example-user/rules"].intent.harnesses = ["codex", "acme-agent"];
  const parsed = parseState(json);
  if (parsed.ok !== "parsed") throw new Error(`expected a parse: ${JSON.stringify(parsed)}`);
  expect(parsed.state.hooks?.global?.map(String)).toEqual(["acme-agent", "claude-code"]);
  expect(parsed.state.sources["@example-user/rules"]?.intent.harnesses.map(String)).toEqual([
    "codex",
    "acme-agent",
  ]);
});
