// Guards the fetch ladder's fail-soft contract: a rung that throws instead of falling through, a 403
// recorded as "missing", or a Retry-After dropped would each turn into a silently stale rule file.
import { describe, expect, test } from "bun:test";
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { simpleGit } from "simple-git";
import { withTempDir } from "../../../tests/shared/temp_dir.ts";
import {
  brokenBodyResponse,
  exited,
  ghScript,
  httpResponse,
  networkError,
  scriptedGit,
  scriptedRunner,
} from "./fixtures/runner.ts";
import { cleanTarball, corruptAfterOneFileTarball } from "./fixtures/tarballs.ts";
import {
  childEnvironment,
  classifyGh,
  classifyGit,
  classifyResponse,
  createLadder,
  type Endpoints,
  FetchFailure,
  type FetchFailureKind,
  GITHUB_ENDPOINTS,
  type Runner,
  simpleGitRunner,
} from "./ladder.ts";

const REPO = { owner: "example-user", repo: "rules" };
const SHA = "0123abc0123abc0123abc0123abc0123abc01234";
const OTHER = "89abcdef89abcdef89abcdef89abcdef89abcdef";

function ladder(runner: Runner, endpoints: Partial<Endpoints> = {}, warnings: string[] = []) {
  return createLadder({
    runner,
    endpoints: { ...GITHUB_ENDPOINTS, ...endpoints },
    warn: (m) => warnings.push(m),
  });
}

async function failure(action: Promise<unknown>): Promise<FetchFailure> {
  try {
    await action;
  } catch (error) {
    if (error instanceof FetchFailure) return error;
    throw error;
  }
  throw new Error("expected the ladder to fail");
}

describe("resolveRef rungs", () => {
  test("gh answers first and nothing below it runs", async () => {
    const runner = scriptedRunner({ exec: ghScript(() => exited(0, `${SHA}\n`)) });
    expect(await ladder(runner).resolveRef(REPO, "HEAD")).toBe(SHA);
    expect(runner.calls).toEqual([
      "exec gh auth status --hostname github.com",
      "exec gh api --hostname github.com repos/example-user/rules/commits/HEAD --jq .sha",
    ]);
  });

  test("an unauthenticated gh is skipped silently and git ls-remote answers", async () => {
    const warnings: string[] = [];
    const runner = scriptedRunner({
      exec: ghScript(() => exited(0, SHA), false),
      git: scriptedGit({ lsRemote: () => ({ kind: "ok", value: `${SHA}\tHEAD\n` }) }),
    });
    expect(await ladder(runner, {}, warnings).resolveRef(REPO, "HEAD")).toBe(SHA);
    expect(warnings).toEqual([]);
    expect(runner.calls).toEqual([
      "exec gh auth status --hostname github.com",
      "git ls-remote https://github.com/example-user/rules.git HEAD HEAD^{}",
    ]);
  });

  test("a pinned tag asks for the peeled ref and records the commit, not the tag object", async () => {
    const runner = scriptedRunner({
      git: scriptedGit({
        lsRemote: () => ({
          kind: "ok",
          value: `${OTHER}\trefs/tags/v1\n${SHA}\trefs/tags/v1^{}\n`,
        }),
      }),
    });
    expect(await ladder(runner).resolveRef(REPO, "v1")).toBe(SHA);
    expect(runner.calls).toEqual([
      "exec gh auth status --hostname github.com",
      "git ls-remote https://github.com/example-user/rules.git refs/tags/v1 refs/tags/v1^{} refs/heads/v1 refs/heads/v1^{}",
    ]);
  });

  test("a ref only matches its fully qualified name, tags before branches", async () => {
    const rows = [
      `${OTHER}\trefs/heads/feature/main`,
      `${SHA}\trefs/heads/main`,
      `${OTHER}\trefs/tags/main-tag`,
    ].join("\n");
    const runner = scriptedRunner({
      git: scriptedGit({ lsRemote: () => ({ kind: "ok", value: `${rows}\n` }) }),
    });
    expect(await ladder(runner).resolveRef(REPO, "main")).toBe(SHA);
    const tagWins = scriptedRunner({
      git: scriptedGit({
        lsRemote: () => ({ kind: "ok", value: `${OTHER}\trefs/heads/v1\n${SHA}\trefs/tags/v1\n` }),
      }),
    });
    expect(await ladder(tagWins).resolveRef(REPO, "v1")).toBe(SHA);
  });

  test("a ref with URL-significant characters is percent-encoded in API paths", async () => {
    const runner = scriptedRunner({
      exec: ghScript(() => exited(1, "", "gh: Not Found (HTTP 404)")),
      fetch: () => httpResponse(200, SHA),
    });
    expect(await ladder(runner).resolveRef(REPO, "release#1")).toBe(SHA);
    expect(runner.calls[1]).toBe(
      "exec gh api --hostname github.com repos/example-user/rules/commits/release%231 --jq .sha",
    );
    expect(runner.calls.at(-1)).toBe(
      "fetch https://api.github.com/repos/example-user/rules/commits/release%231",
    );
  });

  test("with neither binary the API over HTTPS answers", async () => {
    const runner = scriptedRunner({ fetch: () => httpResponse(200, `${SHA}\n`) });
    expect(await ladder(runner).resolveRef(REPO, "v1")).toBe(SHA);
    expect(runner.calls).toEqual([
      "exec gh auth status --hostname github.com",
      "git ls-remote https://github.com/example-user/rules.git refs/tags/v1 refs/tags/v1^{} refs/heads/v1 refs/heads/v1^{}",
      "fetch https://api.github.com/repos/example-user/rules/commits/v1",
    ]);
  });

  test("a failing rung warns and falls through to the next", async () => {
    const warnings: string[] = [];
    const runner = scriptedRunner({
      exec: ghScript(() => exited(1, "", "gh: Not Found (HTTP 404)")),
      git: scriptedGit({
        lsRemote: () => ({
          kind: "failed",
          message: "fatal: unable to access: Could not resolve host",
        }),
      }),
      fetch: () => httpResponse(200, SHA),
    });
    expect(await ladder(runner, {}, warnings).resolveRef(REPO, "HEAD")).toBe(SHA);
    expect(warnings).toEqual([
      "gh api: gh: Not Found (HTTP 404)",
      "git ls-remote: fatal: unable to access: Could not resolve host",
    ]);
  });

  test("when every rung fails the most actionable failure is thrown and Retry-After is kept", async () => {
    const runner = scriptedRunner({
      exec: ghScript(() => exited(1, "", "gh: Not Found (HTTP 404)")),
      git: scriptedGit({
        lsRemote: () => ({ kind: "failed", message: "fatal: Could not resolve host: github.com" }),
      }),
      fetch: () => httpResponse(403, "", { "retry-after": "120", "x-ratelimit-remaining": "0" }),
    });
    const error = await failure(ladder(runner).resolveRef(REPO, "HEAD"));
    expect(error.kind).toBe("ratelimit");
    expect(error.retryAfterSeconds).toBe(120);
    expect(error.message).toBe(
      "https://api.github.com/repos/example-user/rules/commits/HEAD: HTTP 403",
    );
  });

  test("Retry-After survives when an earlier rung reported the rate limit without one", async () => {
    const runner = scriptedRunner({
      exec: ghScript(() => exited(1, "", "gh: API rate limit exceeded (HTTP 403)")),
      fetch: () => httpResponse(403, "", { "retry-after": "45" }),
    });
    const error = await failure(ladder(runner).resolveRef(REPO, "HEAD"));
    expect(error.kind).toBe("ratelimit");
    expect(error.retryAfterSeconds).toBe(45);
  });

  test("a body that dies after a 200 is a network failure, not an escaped exception", async () => {
    const warnings: string[] = [];
    const runner = scriptedRunner({ fetch: () => brokenBodyResponse() });
    const error = await failure(ladder(runner, {}, warnings).resolveRef(REPO, "HEAD"));
    expect(error.kind).toBe("network");
    expect(warnings).toEqual([
      "https://api.github.com/repos/example-user/rules/commits/HEAD: terminated",
    ]);
  });

  test("an empty ls-remote answer is a missing ref, and a garbage sha is invalid", async () => {
    const empty = scriptedRunner({
      git: scriptedGit({ lsRemote: () => ({ kind: "ok", value: "" }) }),
    });
    expect((await failure(ladder(empty).resolveRef(REPO, "nope"))).kind).toBe("missing");
    const garbage = scriptedRunner({ exec: ghScript(() => exited(0, "null\n")) });
    expect((await failure(ladder(garbage).resolveRef(REPO, "HEAD"))).kind).toBe("invalid");
  });
});

describe("fetchTree rungs", () => {
  test("the gh tarball is extracted into the destination", async () => {
    await withTempDir(async (dir) => {
      const runner = scriptedRunner({ exec: ghScript(() => exited(0, cleanTarball())) });
      await ladder(runner).fetchTree(REPO, SHA, join(dir, "tree"));
      expect(runner.calls).toEqual([
        "exec gh auth status --hostname github.com",
        `exec gh api --hostname github.com repos/example-user/rules/tarball/${SHA}`,
      ]);
      expect(readdirSync(join(dir, "tree", "memories")).sort()).toEqual([
        "commit-review.md",
        "tests-first.md",
      ]);
    });
  });

  test("a clone that lands on another commit is invalid and codeload takes over", async () => {
    await withTempDir(async (dir) => {
      const warnings: string[] = [];
      const runner = scriptedRunner({
        git: scriptedGit({ shallowClone: () => ({ kind: "ok", value: OTHER }) }),
        fetch: () => httpResponse(200, cleanTarball()),
      });
      await ladder(runner, {}, warnings).fetchTree(REPO, SHA, join(dir, "tree"));
      expect(warnings).toEqual([`git clone checked out ${OTHER}, expected ${SHA}`]);
      expect(runner.calls.at(-1)).toBe(
        `fetch https://codeload.github.com/example-user/rules/tar.gz/${SHA}`,
      );
      expect(readdirSync(join(dir, "tree"))).toContain("README.md");
    });
  });

  test("a rung that failed half-way leaves nothing for the next rung to merge into", async () => {
    await withTempDir(async (dir) => {
      const warnings: string[] = [];
      const runner = scriptedRunner({
        exec: ghScript(() => exited(0, corruptAfterOneFileTarball())),
        fetch: () => httpResponse(200, cleanTarball()),
      });
      await ladder(runner, {}, warnings).fetchTree(REPO, SHA, join(dir, "tree"));
      expect(warnings).toEqual([expect.stringMatching(/^tarball could not be extracted: /)]);
      expect(readdirSync(join(dir, "tree", "memories")).sort()).toEqual([
        "commit-review.md",
        "tests-first.md",
      ]);
    });
  });

  test("a rung that throws is that rung's failure, and the ladder goes on", async () => {
    await withTempDir(async (dir) => {
      const warnings: string[] = [];
      const runner = scriptedRunner({
        git: scriptedGit({
          shallowClone: () => {
            throw new Error("ENOSPC: no space left on device");
          },
        }),
        fetch: () => httpResponse(200, cleanTarball()),
      });
      await ladder(runner, {}, warnings).fetchTree(REPO, SHA, join(dir, "tree"));
      expect(warnings).toEqual(["ENOSPC: no space left on device"]);
      expect(readdirSync(join(dir, "tree"))).toContain("README.md");
    });
  });

  test("a body that is not an archive fails the rung as invalid rather than leaving an empty tree", async () => {
    await withTempDir(async (dir) => {
      const runner = scriptedRunner({ fetch: () => httpResponse(200, "<html>nope</html>") });
      const error = await failure(ladder(runner).fetchTree(REPO, SHA, join(dir, "tree")));
      expect(error.kind).toBe("invalid");
      expect(error.message).toMatch(/^tarball could not be extracted: /);
    });
  });

  test("every rung offline is a network failure", async () => {
    await withTempDir(async (dir) => {
      const runner = scriptedRunner();
      const error = await failure(ladder(runner).fetchTree(REPO, SHA, join(dir, "tree")));
      expect(error.kind).toBe("network");
      expect(error.message).toBe(
        `https://codeload.github.com/example-user/rules/tar.gz/${SHA}: fetch failed: getaddrinfo ENOTFOUND api.github.com`,
      );
    });
  });
});

describe("failure classification", () => {
  const resetIn = (seconds: number) => ({
    "x-ratelimit-remaining": "0",
    "x-ratelimit-reset": String(Math.floor(Date.now() / 1000) + seconds),
  });
  const http: [number, () => Record<string, string>, FetchFailureKind, number | undefined][] = [
    [403, () => resetIn(90), "ratelimit", 90],
    [403, () => ({ "retry-after": "60" }), "ratelimit", 60],
    [429, () => ({}), "ratelimit", undefined],
    [404, () => ({}), "missing", undefined],
    [422, () => ({}), "missing", undefined],
    [403, () => ({}), "auth", undefined],
    [401, () => ({}), "auth", undefined],
    [500, () => ({}), "invalid", undefined],
  ];
  test.each(http)("HTTP %d (case %#) is %s", (status, headers, kind, retryAfterSeconds) => {
    const classified = classifyResponse(httpResponse(status, "", headers()));
    expect(classified.kind).toBe(kind);
    if (retryAfterSeconds === undefined) expect(classified.retryAfterSeconds).toBeUndefined();
    else
      expect(Math.abs((classified.retryAfterSeconds ?? 0) - retryAfterSeconds)).toBeLessThanOrEqual(
        1,
      );
  });

  test("a thrown fetch is a network failure", async () => {
    const runner = scriptedRunner({
      fetch: () => {
        throw networkError();
      },
    });
    expect((await failure(ladder(runner).resolveRef(REPO, "HEAD"))).kind).toBe("network");
  });

  const gh: [string, FetchFailureKind][] = [
    ["gh: API rate limit exceeded for user ID 1 (HTTP 403)", "ratelimit"],
    ["gh: Not Found (HTTP 404)", "missing"],
    ["gh: Must have admin rights to Repository. (HTTP 403)", "auth"],
    ["gh: Bad credentials (HTTP 401)", "auth"],
    ["gh: No commit found for SHA: absent (HTTP 422)", "missing"],
    [
      "error connecting to api.github.com\ndial tcp: lookup api.github.com: no such host",
      "network",
    ],
    ["gh timed out", "network"],
    ['Get "https://api.github.com/repos/example-user/rules/commits/HEAD": EOF', "network"],
    ['Post "https://api.github.com/graphql": read tcp: connection reset by peer', "network"],
    ["something else entirely", "invalid"],
  ];
  test.each(gh)("gh stderr %j is %s", (stderr, kind) => {
    expect(classifyGh(stderr)).toBe(kind);
  });

  const git: [string, FetchFailureKind][] = [
    [
      "remote: Repository not found.\nfatal: repository 'https://github.com/o/r.git/' not found",
      "missing",
    ],
    [
      "fatal: '/x/missing' does not appear to be a git repository\nfatal: Could not read from remote repository.",
      "missing",
    ],
    ["fatal: couldn't find remote ref v9", "missing"],
    ["fatal: could not read Username for 'https://github.com': terminal prompts disabled", "auth"],
    ["fatal: Authentication failed for 'https://github.com/o/r.git/'", "auth"],
    ["fatal: unable to get password from user", "auth"],
    [
      "fatal: unable to access 'https://github.com/o/r.git/': The requested URL returned error: 429",
      "ratelimit",
    ],
    [
      "fatal: unable to access 'https://github.com/o/r.git/': Could not resolve host: github.com",
      "network",
    ],
    [
      "fatal: unable to access 'https://github.com/o/r.git/': Failed to connect to github.com port 443",
      "network",
    ],
    ["block timeout reached", "network"],
    ["error: unknown option `--filter=blob:none'", "invalid"],
  ];
  test.each(git)("git message %j is %s", (message, kind) => {
    expect(classifyGit(message)).toBe(kind);
  });
});

describe("childEnvironment", () => {
  test("drops prompt and repository-selection variables, keeps the rest, and disables prompts", () => {
    const env = childEnvironment({
      PATH: "/usr/bin",
      GIT_CONFIG_GLOBAL: "/dev/null",
      GH_TOKEN: "token",
      GIT_DIR: "/home/user/project/.git",
      GIT_WORK_TREE: "/home/user/project",
      GIT_INDEX_FILE: "/home/user/project/.git/index",
      GIT_ASKPASS: "/usr/bin/ask",
      EDITOR: "vi",
      PAGER: "less",
      GIT_SSH_COMMAND: "ssh -v",
    });
    expect(env).toEqual({
      PATH: "/usr/bin",
      GIT_CONFIG_GLOBAL: "/dev/null",
      GH_TOKEN: "token",
      GIT_TERMINAL_PROMPT: "0",
      GCM_INTERACTIVE: "never",
      GH_PROMPT_DISABLED: "1",
      GH_NO_UPDATE_NOTIFIER: "1",
      NO_COLOR: "1",
    });
  });
});

describe("git rung against a file:// fixture repo", () => {
  test("resolves HEAD and an annotated tag, then clones the pinned commit", async () => {
    await withTempDir(async (dir) => {
      const repo = join(dir, "repo");
      mkdirSync(join(repo, "memories"), { recursive: true });
      writeFileSync(join(repo, "memories", "first-rule.md"), "first\n");
      const git = simpleGit(repo);
      await git.raw(["init", "--quiet", "-b", "main"]);
      await git.add(".");
      await git.commit("one");
      await git.addAnnotatedTag("v1", "first release");
      const tagged = (await git.revparse(["v1^{commit}"])).trim();
      writeFileSync(join(repo, "memories", "second-rule.md"), "second\n");
      await git.add(".");
      await git.commit("two");
      const head = (await git.revparse(["HEAD"])).trim();
      expect(tagged).not.toBe(head);

      const runner = scriptedRunner({ git: simpleGitRunner() });
      const endpoints = { gitUrl: () => `file://${repo}` };
      const climb = ladder(runner, endpoints);
      expect(await climb.resolveRef(REPO, "HEAD")).toBe(head);
      expect(await climb.resolveRef(REPO, "v1")).toBe(tagged);
      const dest = join(dir, "tree");
      await climb.fetchTree(REPO, tagged, dest);
      expect(readdirSync(join(dest, "memories"))).toEqual(["first-rule.md"]);
      expect(readFileSync(join(dest, "memories", "first-rule.md"), "utf8")).toBe("first\n");
      expect(runner.calls.filter((c) => c.startsWith("fetch "))).toEqual([]);

      const missing = await failure(climb.resolveRef(REPO, "v9"));
      expect(missing.kind).toBe("missing");
    });
  });

  test("a repository path that merely contains ENOENT is a failed command, not an absent git", async () => {
    const outcome = await simpleGitRunner().lsRemote("file:///nonexistent/ENOENT-repo", ["HEAD"]);
    expect(outcome.kind).toBe("failed");
  });

  test("a git binary that does not exist drops the rung silently", async () => {
    const warnings: string[] = [];
    const runner = scriptedRunner({
      git: simpleGitRunner("/nonexistent/maxims-test-git"),
      fetch: () => httpResponse(200, SHA),
    });
    expect(await ladder(runner, {}, warnings).resolveRef(REPO, "HEAD")).toBe(SHA);
    expect(warnings).toEqual([]);
  });
});
