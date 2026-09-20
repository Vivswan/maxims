// Guards the state boundary: a corrupt or hand-edited file must be refused whole rather than half
// obeyed, a newer file must never be rewritten, and the source grammar must keep `owner/repo`,
// URLs, `.` and relative paths landing on the shapes the rest of the tool switches on.
import { describe, expect, test } from "bun:test";
import type { MemoryName } from "../memory/contract.ts";
import { ExitCode, type MaximsError } from "../util/exit-codes.ts";
import {
  CURRENT_STATE_VERSION,
  canonicalSourceKey,
  emptyState,
  parseSourceArgument,
  parseState,
  type SourceFrom,
} from "./schema.ts";

const RUBBER_DUCK = "rubber-duck-before-every-commit" as MemoryName;

const VALID = {
  version: 1,
  writtenBy: "maxims@0.4.1",
  hooks: ["claude-code", "codex"],
  config: { cooldownDays: 7 },
  sources: {
    "@example-user/rules": {
      intent: {
        from: { type: "github", repo: "example-user/rules", ref: "main" },
        select: ["rubber-duck-before-every-commit"],
        rename: { "gate-exit-conditions-the-merge": "gate-exit-conditions-the-merge-dotfiles" },
        rule: true,
        destination: { scope: "global" },
        copy: false,
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
  });

  const corrupt: { title: string; mutate: (json: typeof VALID) => unknown; issue: RegExp }[] = [
    { title: "not an object", mutate: () => "state", issue: /expected object/i },
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
  const accepted: [string, SourceFrom][] = [
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
    expect(canonicalSourceKey(expected)).toBe(
      expected.type === "github" ? `@${expected.repo}` : expected.path,
    );
  });

  const rejected = [
    "",
    "@only-owner",
    "@a/b/c",
    "https://gitlab.com/a/b",
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
