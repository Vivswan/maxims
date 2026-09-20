// Guards the fetch ladder's contract: an anonymous fetch that runs gh or sends a token, a rung that
// throws instead of falling through, a 403 recorded as "missing", a Retry-After dropped, or a
// tarball fetched after git failed on the network would each pass silently and change what users
// install.
import { describe, expect, test } from "bun:test";
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { simpleGit } from "simple-git";
import { withTempDir } from "../../../tests/shared/temp_dir.ts";
import { createFixtureRepo } from "./fixtures/repo.ts";
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
  endpointsFor,
  FetchFailure,
  type FetchFailureKind,
  type GitCredentials,
  gitEnvironment,
  type Runner,
  simpleGitRunner,
  systemRunner,
} from "./ladder.ts";

const REPO = { owner: "example-user", repo: "rules" };
const SHA = "0123abc0123abc0123abc0123abc0123abc01234";
const OTHER = "89abcdef89abcdef89abcdef89abcdef89abcdef";
const GIT_URL = "https://github.com/example-user/rules.git";
const ANON = { auth: false };
const AUTH = { auth: true };
const INHERITED = { credentials: { kind: "inherited" } } as const;

type LadderSetup = {
  endpoints?: Partial<Endpoints>;
  warnings?: string[];
  token?: string;
  timeoutMs?: number;
};

function ladder(runner: Runner, setup: LadderSetup = {}) {
  return createLadder({
    runner,
    endpoints: { ...endpointsFor("github.com"), ...setup.endpoints },
    warn: (m) => setup.warnings?.push(m),
    timeoutMs: setup.timeoutMs ?? 60_000,
    token: setup.token,
  });
}

// The private include file a credentialed call writes must be gone when the call returns.
function includeDirs(): string[] {
  return readdirSync(tmpdir())
    .filter((name) => name.startsWith("maxims-git-"))
    .sort();
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

function headerCapture(): { headers: Record<string, string>[]; fetch: Runner["fetch"] } {
  const headers: Record<string, string>[] = [];
  return {
    headers,
    fetch: async (_url, init) => {
      headers.push({ ...(init.headers as Record<string, string>) });
      return httpResponse(200, SHA);
    },
  };
}

describe("resolveRef without auth", () => {
  test("starts with ls-remote and never runs gh, even with a token in reach", async () => {
    const runner = scriptedRunner({
      exec: ghScript(() => exited(0, OTHER)),
      git: scriptedGit({ lsRemote: () => ({ kind: "ok", value: `${SHA}\tHEAD\n` }) }),
    });
    expect(await ladder(runner, { token: "secret" }).resolveRef(REPO, "HEAD", ANON)).toBe(SHA);
    expect(runner.calls).toEqual([`git ls-remote ${GIT_URL} HEAD HEAD^{} [creds=none]`]);
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
    expect(await ladder(runner).resolveRef(REPO, "v1", ANON)).toBe(SHA);
    expect(runner.calls).toEqual([
      `git ls-remote ${GIT_URL} refs/tags/v1 refs/tags/v1^{} refs/heads/v1 refs/heads/v1^{} [creds=none]`,
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
    expect(await ladder(runner).resolveRef(REPO, "main", ANON)).toBe(SHA);
    const tagWins = scriptedRunner({
      git: scriptedGit({
        lsRemote: () => ({ kind: "ok", value: `${OTHER}\trefs/heads/v1\n${SHA}\trefs/tags/v1\n` }),
      }),
    });
    expect(await ladder(tagWins).resolveRef(REPO, "v1", ANON)).toBe(SHA);
  });

  test("with git absent the API answers anonymously, without an Authorization header", async () => {
    const capture = headerCapture();
    const runner = scriptedRunner({ fetch: capture.fetch });
    expect(await ladder(runner, { token: "secret" }).resolveRef(REPO, "v1", ANON)).toBe(SHA);
    expect(runner.calls).toEqual([
      `git ls-remote ${GIT_URL} refs/tags/v1 refs/tags/v1^{} refs/heads/v1 refs/heads/v1^{} [creds=none]`,
      "fetch https://api.github.com/repos/example-user/rules/commits/v1",
    ]);
    expect(capture.headers).toEqual([
      { "User-Agent": "maxims", Accept: "application/vnd.github.sha" },
    ]);
  });

  // The API answers 404 here, so a rung that reaches it ends as "missing" unless a more actionable
  // kind (auth) already outranks it; a network fault never reaches it at all.
  const fallthrough: [string, string, boolean, FetchFailureKind][] = [
    [
      "a missing repo",
      "fatal: repository 'https://github.com/o/r.git/' not found",
      true,
      "missing",
    ],
    ["an auth refusal", "fatal: could not read Username: terminal prompts disabled", true, "auth"],
    [
      "a network fault",
      "fatal: unable to access: Could not resolve host: github.com",
      false,
      "network",
    ],
  ];
  test.each(fallthrough)(
    "%s from ls-remote reaches the API: %p",
    async (_label, message, reachesApi, kind) => {
      const warnings: string[] = [];
      const runner = scriptedRunner({
        git: scriptedGit({ lsRemote: () => ({ kind: "failed", message }) }),
        fetch: () => httpResponse(404),
      });
      const error = await failure(ladder(runner, { warnings }).resolveRef(REPO, "HEAD", ANON));
      expect(runner.calls.some((c) => c.startsWith("fetch "))).toBe(reachesApi);
      expect(error.kind).toBe(kind);
      expect(warnings[0]).toBe(`git ls-remote: ${message}`);
    },
  );

  test("a ref with URL-significant characters is percent-encoded in API paths", async () => {
    const runner = scriptedRunner({ fetch: () => httpResponse(200, SHA) });
    expect(await ladder(runner).resolveRef(REPO, "release#1", ANON)).toBe(SHA);
    expect(runner.calls.at(-1)).toBe(
      "fetch https://api.github.com/repos/example-user/rules/commits/release%231",
    );
  });

  test("an empty ls-remote answer is a missing ref, and a garbage sha is invalid", async () => {
    const empty = scriptedRunner({
      git: scriptedGit({ lsRemote: () => ({ kind: "ok", value: "" }) }),
    });
    expect((await failure(ladder(empty).resolveRef(REPO, "nope", ANON))).kind).toBe("missing");
    const garbage = scriptedRunner({ fetch: () => httpResponse(200, "null\n") });
    expect((await failure(ladder(garbage).resolveRef(REPO, "HEAD", ANON))).kind).toBe("invalid");
  });

  test("a body that dies after a 200 is a network failure, not an escaped exception", async () => {
    const warnings: string[] = [];
    const runner = scriptedRunner({ fetch: () => brokenBodyResponse() });
    const error = await failure(ladder(runner, { warnings }).resolveRef(REPO, "HEAD", ANON));
    expect(error.kind).toBe("network");
    expect(warnings).toEqual([
      "https://api.github.com/repos/example-user/rules/commits/HEAD: terminated",
    ]);
  });
});

describe("resolveRef with auth", () => {
  test("gh answers first, bound to the host, and nothing below it runs", async () => {
    const runner = scriptedRunner({ exec: ghScript(() => exited(0, `${SHA}\n`)) });
    expect(await ladder(runner).resolveRef(REPO, "HEAD", AUTH)).toBe(SHA);
    expect(runner.calls).toEqual([
      "exec gh auth status --hostname github.com",
      "exec gh api --hostname github.com repos/example-user/rules/commits/HEAD --jq .sha",
    ]);
  });

  test("an unauthenticated gh is skipped silently and ls-remote carries the token header", async () => {
    const warnings: string[] = [];
    const runner = scriptedRunner({
      exec: ghScript(() => exited(0, SHA), false),
      git: scriptedGit({ lsRemote: () => ({ kind: "ok", value: `${SHA}\tHEAD\n` }) }),
    });
    const climb = ladder(runner, { warnings, token: "secret" });
    expect(await climb.resolveRef(REPO, "HEAD", AUTH)).toBe(SHA);
    expect(warnings).toEqual([]);
    expect(runner.calls).toEqual([
      "exec gh auth status --hostname github.com",
      `git ls-remote ${GIT_URL} HEAD HEAD^{} [header=Authorization: Bearer secret]`,
    ]);
  });

  test("with gh and git absent the API carries the Bearer token", async () => {
    const capture = headerCapture();
    const runner = scriptedRunner({ fetch: capture.fetch });
    expect(await ladder(runner, { token: "secret" }).resolveRef(REPO, "HEAD", AUTH)).toBe(SHA);
    expect(capture.headers).toEqual([
      {
        "User-Agent": "maxims",
        Accept: "application/vnd.github.sha",
        Authorization: "Bearer secret",
      },
    ]);
  });

  test("without a token in the environment, auth adds no header and no git option", async () => {
    const capture = headerCapture();
    const runner = scriptedRunner({ fetch: capture.fetch });
    expect(await ladder(runner).resolveRef(REPO, "HEAD", AUTH)).toBe(SHA);
    expect(runner.calls[1]).toBe(`git ls-remote ${GIT_URL} HEAD HEAD^{} [creds=inherited]`);
    expect(capture.headers[0]?.Authorization).toBeUndefined();
  });

  test("gh encodes the ref too, and a gh failure warns then falls through", async () => {
    const warnings: string[] = [];
    const runner = scriptedRunner({
      exec: ghScript(() => exited(1, "", "gh: Not Found (HTTP 404)")),
      fetch: () => httpResponse(200, SHA),
    });
    expect(await ladder(runner, { warnings }).resolveRef(REPO, "release#1", AUTH)).toBe(SHA);
    expect(runner.calls[1]).toBe(
      "exec gh api --hostname github.com repos/example-user/rules/commits/release%231 --jq .sha",
    );
    expect(warnings).toEqual(["gh api: gh: Not Found (HTTP 404)"]);
  });

  test("when every rung fails the most actionable failure is thrown and Retry-After survives", async () => {
    const runner = scriptedRunner({
      exec: ghScript(() => exited(1, "", "gh: API rate limit exceeded (HTTP 403)")),
      git: scriptedGit({
        lsRemote: () => ({ kind: "failed", message: "fatal: repository not found" }),
      }),
      fetch: () => httpResponse(403, "", { "retry-after": "120", "x-ratelimit-remaining": "0" }),
    });
    const error = await failure(ladder(runner).resolveRef(REPO, "HEAD", AUTH));
    expect(error.kind).toBe("ratelimit");
    expect(error.retryAfterSeconds).toBe(120);
    expect(error.message).toBe(
      "https://api.github.com/repos/example-user/rules/commits/HEAD: HTTP 403",
    );
  });
});

describe("fetchTree", () => {
  test("anonymous fetch clones a sparse cone of the memory folder and never downloads a tarball", async () => {
    await withTempDir(async (dir) => {
      const runner = scriptedRunner({
        git: scriptedGit({ shallowClone: () => ({ kind: "ok", value: SHA }) }),
        exec: ghScript(() => exited(0, cleanTarball())),
      });
      const climb = ladder(runner, { token: "secret" });
      await climb.fetchTree(REPO, SHA, join(dir, "tree"), { ...ANON, sparsePath: "memories" });
      await climb.fetchTree(REPO, SHA, join(dir, "full"), ANON);
      expect(runner.calls).toEqual([
        `git clone ${GIT_URL} ${SHA} [creds=none sparse=memories]`,
        `git clone ${GIT_URL} ${SHA} [creds=none]`,
      ]);
    });
  });

  const tarballWhen: [string, ReturnType<typeof scriptedGit>, boolean, FetchFailureKind | null][] =
    [
      ["git is absent", scriptedGit({}), true, null],
      [
        "the clone failed for a non-network reason",
        scriptedGit({ shallowClone: () => ({ kind: "ok", value: OTHER }) }),
        true,
        null,
      ],
      [
        "the clone failed on the network",
        scriptedGit({
          shallowClone: () => ({
            kind: "failed",
            message: "fatal: unable to access: Could not resolve host",
          }),
        }),
        false,
        "network",
      ],
    ];
  test.each(tarballWhen)("the tarball rung runs only when %s", async (_label, git, runs, kind) => {
    await withTempDir(async (dir) => {
      const runner = scriptedRunner({ git, fetch: () => httpResponse(200, cleanTarball()) });
      const attempt = ladder(runner).fetchTree(REPO, SHA, join(dir, "tree"), ANON);
      if (kind === null) {
        await attempt;
        expect(readdirSync(join(dir, "tree"))).toContain("README.md");
      } else {
        expect((await failure(attempt)).kind).toBe(kind);
      }
      expect(runner.calls.some((c) => c.startsWith("fetch "))).toBe(runs);
    });
  });

  test("with auth the gh tarball comes first and is extracted into the destination", async () => {
    await withTempDir(async (dir) => {
      const runner = scriptedRunner({ exec: ghScript(() => exited(0, cleanTarball())) });
      await ladder(runner).fetchTree(REPO, SHA, join(dir, "tree"), AUTH);
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

  test("a rung that failed half-way leaves nothing for the next rung to merge into", async () => {
    await withTempDir(async (dir) => {
      const warnings: string[] = [];
      const runner = scriptedRunner({
        exec: ghScript(() => exited(0, corruptAfterOneFileTarball())),
        fetch: () => httpResponse(200, cleanTarball()),
      });
      await ladder(runner, { warnings }).fetchTree(REPO, SHA, join(dir, "tree"), AUTH);
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
      await ladder(runner, { warnings }).fetchTree(REPO, SHA, join(dir, "tree"), ANON);
      expect(warnings).toEqual(["ENOSPC: no space left on device"]);
      expect(readdirSync(join(dir, "tree"))).toContain("README.md");
    });
  });

  test("a body that is not an archive fails the rung as invalid rather than leaving an empty tree", async () => {
    await withTempDir(async (dir) => {
      const runner = scriptedRunner({ fetch: () => httpResponse(200, "<html>nope</html>") });
      const error = await failure(ladder(runner).fetchTree(REPO, SHA, join(dir, "tree"), ANON));
      expect(error.kind).toBe("invalid");
      expect(error.message).toMatch(/^tarball could not be extracted: /);
    });
  });

  test("everything offline is a network failure", async () => {
    await withTempDir(async (dir) => {
      const runner = scriptedRunner();
      const error = await failure(ladder(runner).fetchTree(REPO, SHA, join(dir, "tree"), ANON));
      expect(error.kind).toBe("network");
      expect(error.message).toBe(
        `https://codeload.github.com/example-user/rules/tar.gz/${SHA}: fetch failed: getaddrinfo ENOTFOUND api.github.com`,
      );
    });
  });
});

// gh's URL shapes per host class, which nothing else enforces: github.com and a ghe.com tenant
// serve their API from an `api.` subdomain, an enterprise server under its own /api/v3; archives
// come from codeload, the REST tarball endpoint, or the repository's own path respectively.
describe("endpoints per host class", () => {
  const cases: [string, string, string, string, string][] = [
    [
      "github.com",
      "github.com",
      "github.com",
      "https://api.github.com",
      `https://codeload.github.com/example-user/rules/tar.gz/${SHA}`,
    ],
    [
      "an enterprise server",
      "GHE.example.com",
      "ghe.example.com",
      "https://ghe.example.com/api/v3",
      `https://ghe.example.com/example-user/rules/archive/${SHA}.tar.gz`,
    ],
    [
      "a ghe.com tenant",
      "Octo.ghe.com",
      "octo.ghe.com",
      "https://api.octo.ghe.com",
      `https://api.octo.ghe.com/repos/example-user/rules/tarball/${SHA}`,
    ],
  ];
  test.each(cases)(
    "%s: every URL and the gh hostname",
    async (_label, host, ghHost, api, archive) => {
      await withTempDir(async (dir) => {
        const runner = scriptedRunner({
          exec: ghScript(() => exited(1, "", "gh: Not Found (HTTP 404)")),
          fetch: (url) => httpResponse(200, url.includes("/commits/") ? SHA : cleanTarball()),
        });
        const climb = ladder(runner, { endpoints: endpointsFor(host) });
        expect(await climb.resolveRef(REPO, "v1", AUTH)).toBe(SHA);
        await climb.fetchTree(REPO, SHA, join(dir, "tree"), AUTH);
        expect(runner.calls).toEqual([
          `exec gh auth status --hostname ${ghHost}`,
          `exec gh api --hostname ${ghHost} repos/example-user/rules/commits/v1 --jq .sha`,
          `git ls-remote https://${ghHost}/example-user/rules.git refs/tags/v1 refs/tags/v1^{} refs/heads/v1 refs/heads/v1^{} [creds=inherited]`,
          `fetch ${api}/repos/example-user/rules/commits/v1`,
          `exec gh api --hostname ${ghHost} repos/example-user/rules/tarball/${SHA}`,
          `git clone https://${ghHost}/example-user/rules.git ${SHA} [creds=inherited]`,
          `fetch ${archive}`,
        ]);
      });
    },
  );
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
    expect((await failure(ladder(runner).resolveRef(REPO, "HEAD", ANON))).kind).toBe("network");
  });

  const gh: [string, FetchFailureKind][] = [
    ["gh: API rate limit exceeded for user ID 1 (HTTP 403)", "ratelimit"],
    ["gh: Not Found (HTTP 404)", "missing"],
    ["gh: No commit found for SHA: absent (HTTP 422)", "missing"],
    ["gh: Must have admin rights to Repository. (HTTP 403)", "auth"],
    ["gh: Bad credentials (HTTP 401)", "auth"],
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
    [
      "fetch-pack: unexpected disconnect while reading sideband packet\nfatal: early EOF\nfatal: fetch-pack: invalid index-pack output",
      "network",
    ],
    ["error: RPC failed; curl 56 Recv failure: Connection reset by peer", "network"],
    ["error: unknown option `--filter=blob:none'", "invalid"],
  ];
  test.each(git)("git message %j is %s", (message, kind) => {
    expect(classifyGit(message)).toBe(kind);
  });
});

describe("systemRunner", () => {
  test("arguments reach the child literally: no shell expands them", async () => {
    const result = await systemRunner({ PATH: process.env.PATH }).exec("printf", [
      "%s",
      "a;b $HOME `id` && rm",
    ]);
    expect(result).toEqual({
      kind: "exited",
      code: 0,
      stdout: Buffer.from("a;b $HOME `id` && rm"),
      stderr: "",
    });
  });

  test("a child that outlives MAXIMS_FETCH_TIMEOUT is killed and reads as a network failure", async () => {
    const runner = systemRunner({ PATH: process.env.PATH, MAXIMS_FETCH_TIMEOUT: "1" });
    const result = await runner.exec("sleep", ["5"]);
    expect(result).toEqual({
      kind: "exited",
      code: -1,
      stdout: new Uint8Array(),
      stderr: "sleep timed out",
    });
    if (result.kind === "exited") expect(classifyGh(result.stderr)).toBe("network");
  });

  test("an HTTP request that stalls past the timeout is a network failure", async () => {
    const server = Bun.serve({
      port: 0,
      fetch: () => new Promise<Response>(() => {}),
    });
    try {
      const runner = scriptedRunner({ fetch: (url, init) => fetch(url, init) });
      const climb = ladder(runner, {
        timeoutMs: 300,
        endpoints: { apiBase: `http://127.0.0.1:${server.port}` },
      });
      const error = await failure(climb.resolveRef(REPO, "HEAD", ANON));
      expect(error.kind).toBe("network");
      expect(error.message).toMatch(/timed out|TimeoutError|aborted/i);
    } finally {
      server.stop(true);
    }
  });
});

describe("git rung against a file:// fixture repo", () => {
  test("resolves HEAD and an annotated tag, then sparse-clones the pinned commit", async () => {
    await withTempDir(async (dir) => {
      const repo = await createFixtureRepo(join(dir, "repo"));
      const runner = scriptedRunner({ git: simpleGitRunner() });
      const climb = ladder(runner, { endpoints: { gitUrl: () => repo.url } });
      expect(await climb.resolveRef(REPO, "HEAD", ANON)).toBe(repo.head);
      expect(await climb.resolveRef(REPO, "v1", ANON)).toBe(repo.tagged);
      const sparse = join(dir, "sparse");
      await climb.fetchTree(REPO, repo.tagged, sparse, { ...ANON, sparsePath: "memories" });
      expect(readdirSync(join(sparse, "memories"))).toEqual(["first-rule.md"]);
      expect(readFileSync(join(sparse, "memories", "first-rule.md"), "utf8")).toBe("first\n");
      expect(existsSync(join(sparse, "src"))).toBe(false);
      const full = join(dir, "full");
      await climb.fetchTree(REPO, repo.head, full, ANON);
      expect(readdirSync(join(full, "memories")).sort()).toEqual([
        "first-rule.md",
        "second-rule.md",
      ]);
      expect(existsSync(join(full, "src", "deep", "unrelated.txt"))).toBe(true);
      expect(runner.calls.filter((c) => c.startsWith("fetch ") || c.startsWith("exec "))).toEqual(
        [],
      );
      expect((await failure(climb.resolveRef(REPO, "v9", ANON))).kind).toBe("missing");
    });
  });

  test("a repository path that merely contains ENOENT is a failed command, not an absent git", async () => {
    const outcome = await simpleGitRunner().lsRemote(
      "file:///nonexistent/ENOENT-repo",
      ["HEAD"],
      INHERITED,
    );
    expect(outcome.kind).toBe("failed");
  });

  test("a command-running transport is refused even when the user's gitconfig allows it", async () => {
    await withTempDir(async (dir) => {
      const gitconfig = join(dir, "gitconfig");
      writeFileSync(gitconfig, '[protocol "ext"]\n\tallow = always\n');
      const marker = join(dir, "pwned");
      const env = childEnvironment({ ...process.env, GIT_CONFIG_GLOBAL: gitconfig });
      const outcome = await simpleGitRunner({ env }).lsRemote(
        `ext::sh -c touch%20${marker}`,
        ["HEAD"],
        INHERITED,
      );
      expect(outcome.kind).toBe("failed");
      if (outcome.kind === "failed") expect(outcome.message).toMatch(/not allowed/);
      expect(existsSync(marker)).toBe(false);
    });
  });

  // The user's gitconfig below carries an unscoped header, one scoped to the server's host, and one
  // scoped to the exact repository URL, plus an insteadOf rewrite of github.com onto the server. Git
  // sends every matching header, so the server sees them joined; what it sees is the whole contract.
  const identity: [string, GitCredentials, (port: number) => string, string | null][] = [
    [
      "inherited credentials keep the user's own headers",
      { kind: "inherited" },
      (p) => `http://127.0.0.1:${p}/rules.git`,
      "Bearer inherited, Bearer scoped-inherited, Bearer exact-inherited",
    ],
    [
      "anonymous strips the user's own headers, scoped and unscoped alike",
      { kind: "none" },
      (p) => `http://127.0.0.1:${p}/rules.git`,
      null,
    ],
    [
      "anonymous stays anonymous across an insteadOf rewrite",
      { kind: "none" },
      () => "https://github.com/example-user/rules.git",
      null,
    ],
    [
      "a token replaces the user's headers for the URL it was given",
      { kind: "header", header: "Authorization: Bearer ours" },
      (p) => `http://127.0.0.1:${p}/rules.git`,
      "Bearer ours",
    ],
    [
      "a token does not follow an insteadOf rewrite to another host",
      { kind: "header", header: "Authorization: Bearer ours" },
      () => "https://github.com/example-user/rules.git",
      "Bearer inherited, Bearer scoped-inherited",
    ],
  ];
  test.each(identity)("%s", async (_label, credentials, urlFor, expected) => {
    const seen: (string | null)[] = [];
    const server = Bun.serve({
      port: 0,
      fetch: (request) => {
        seen.push(request.headers.get("authorization"));
        return new Response("not here", { status: 404 });
      },
    });
    try {
      await withTempDir(async (dir) => {
        const port = server.port ?? 0;
        const gitconfig = join(dir, "gitconfig");
        writeFileSync(
          gitconfig,
          [
            "[http]",
            "\textraheader = Authorization: Bearer inherited",
            `[http "http://127.0.0.1:${port}/"]`,
            "\textraheader = Authorization: Bearer scoped-inherited",
            `[http "http://127.0.0.1:${port}/rules.git"]`,
            "\textraheader = Authorization: Bearer exact-inherited",
            `[url "http://127.0.0.1:${port}/"]`,
            "\tinsteadOf = https://github.com/",
            "",
          ].join("\n"),
        );
        const env = childEnvironment({ ...process.env, GIT_CONFIG_GLOBAL: gitconfig });
        const outcome = await simpleGitRunner({ env }).lsRemote(urlFor(port), ["HEAD"], {
          credentials,
        });
        expect(outcome.kind).toBe("failed");
        expect(seen.length).toBeGreaterThan(0);
        expect(new Set(seen)).toEqual(new Set([expected]));
      });
    } finally {
      server.stop(true);
    }
  });

  // Two rewrites carry a password: one onto the loopback host, one from the loopback host onto
  // itself, so that stripping the userinfo and handing git the plain URL would trigger it again.
  const BASIC = `Basic ${Buffer.from("example-user:fixture-secret").toString("base64")}`;
  const userinfo: [string, GitCredentials, (port: number) => string, string | null][] = [
    [
      "inherited credentials replay a password the user's insteadOf wrote into the URL",
      { kind: "inherited" },
      () => "https://github.com/example-user/rules.git",
      BASIC,
    ],
    [
      "anonymous never sends a password a rewrite onto another host carries",
      { kind: "none" },
      () => "https://github.com/example-user/rules.git",
      null,
    ],
    [
      "anonymous never sends a password a rewrite onto the same host carries",
      { kind: "none" },
      (p) => `http://127.0.0.1:${p}/rules.git`,
      null,
    ],
  ];
  test.each(userinfo)("%s", async (_label, credentials, urlFor, expected) => {
    const seen: (string | null)[] = [];
    const server = Bun.serve({
      port: 0,
      fetch: (request) => {
        seen.push(request.headers.get("authorization"));
        return new Response("who are you", {
          status: 401,
          headers: { "WWW-Authenticate": "Basic" },
        });
      },
    });
    try {
      await withTempDir(async (dir) => {
        const port = server.port ?? 0;
        const gitconfig = join(dir, "gitconfig");
        writeFileSync(
          gitconfig,
          [
            `[url "http://example-user:fixture-secret@127.0.0.1:${port}/"]`,
            "\tinsteadOf = https://github.com/",
            `\tinsteadOf = http://127.0.0.1:${port}/`,
            "",
          ].join("\n"),
        );
        const env = childEnvironment({ ...process.env, GIT_CONFIG_GLOBAL: gitconfig });
        const outcome = await simpleGitRunner({ env }).lsRemote(urlFor(port), ["HEAD"], {
          credentials,
        });
        expect(outcome.kind).toBe("failed");
        expect(seen.length).toBeGreaterThan(0);
        expect(seen.filter((value) => value !== null)).toEqual(expected === null ? [] : [expected]);
      });
    } finally {
      server.stop(true);
    }
  });

  const netrc: [string, GitCredentials, string | null][] = [
    ["inherited credentials let libcurl answer a 401 from ~/.netrc", { kind: "inherited" }, BASIC],
    ["anonymous never reaches ~/.netrc", { kind: "none" }, null],
  ];
  test.each(netrc)("%s", async (_label, credentials, expected) => {
    const seen: (string | null)[] = [];
    const server = Bun.serve({
      port: 0,
      fetch: (request) => {
        seen.push(request.headers.get("authorization"));
        return new Response("who are you", {
          status: 401,
          headers: { "WWW-Authenticate": "Basic" },
        });
      },
    });
    try {
      await withTempDir(async (home) => {
        writeFileSync(
          join(home, ".netrc"),
          "machine 127.0.0.1 login example-user password fixture-secret\n",
          { mode: 0o600 },
        );
        const env = gitEnvironment({ ...process.env, HOME: home, GIT_CONFIG_GLOBAL: "/dev/null" });
        const outcome = await simpleGitRunner({ env }).lsRemote(
          `http://127.0.0.1:${server.port ?? 0}/rules.git`,
          ["HEAD"],
          { credentials },
        );
        expect(outcome.kind).toBe("failed");
        expect(seen.length).toBeGreaterThan(0);
        expect(seen.filter((value) => value !== null)).toEqual(expected === null ? [] : [expected]);
      });
    } finally {
      server.stop(true);
    }
  });

  test("anonymous calls still read ~/.gitconfig and a ~-relative include from the real HOME", async () => {
    const agents: string[] = [];
    const server = Bun.serve({
      port: 0,
      fetch: (request) => {
        agents.push(request.headers.get("user-agent") ?? "");
        return new Response("not here", { status: 404 });
      },
    });
    try {
      await withTempDir(async (home) => {
        writeFileSync(join(home, ".gitconfig"), "[include]\n\tpath = ~/extra-config\n");
        writeFileSync(join(home, "extra-config"), "[http]\n\tuserAgent = tilde-include-agent\n");
        writeFileSync(join(home, ".netrc"), "machine 127.0.0.1 login example-user password x\n");
        const base: NodeJS.ProcessEnv = { ...process.env, HOME: home };
        delete base.GIT_CONFIG_GLOBAL;
        const env = gitEnvironment(base);
        const outcome = await simpleGitRunner({ env }).lsRemote(
          `http://127.0.0.1:${server.port ?? 0}/rules.git`,
          ["HEAD"],
          { credentials: { kind: "none" } },
        );
        expect(outcome.kind).toBe("failed");
        expect(new Set(agents)).toEqual(new Set(["tilde-include-agent"]));
        expect(readdirSync(home).sort()).toEqual([".gitconfig", ".netrc", "extra-config"]);
      });
    } finally {
      server.stop(true);
    }
  });

  test("a memory folder named like an option is still a sparse path, not a flag", async () => {
    await withTempDir(async (dir) => {
      const repo = await createFixtureRepo(join(dir, "repo"));
      const dest = join(dir, "clone");
      const outcome = await simpleGitRunner().shallowClone(repo.url, repo.head, dest, {
        credentials: { kind: "none" },
        sparsePath: "-dashed",
      });
      expect(outcome).toEqual({ kind: "ok", value: repo.head });
      expect(readdirSync(join(dest, "-dashed"))).toEqual(["odd-rule.md"]);
      expect(existsSync(join(dest, "memories"))).toBe(false);
    });
  });

  const helpers: [string, GitCredentials, boolean][] = [
    ["inherited credentials let the user's helper answer a 401", { kind: "inherited" }, true],
    ["anonymous never consults the user's helper", { kind: "none" }, false],
  ];
  test.each(helpers)("%s", async (_label, credentials, consulted) => {
    const server = Bun.serve({
      port: 0,
      fetch: () =>
        new Response("who are you", { status: 401, headers: { "WWW-Authenticate": "Basic" } }),
    });
    try {
      await withTempDir(async (dir) => {
        const marker = join(dir, "helper-ran");
        const helper = join(dir, "helper.sh");
        writeFileSync(helper, `#!/bin/sh\ntouch ${marker}\n`, { mode: 0o755 });
        const gitconfig = join(dir, "gitconfig");
        writeFileSync(gitconfig, `[credential]\n\thelper = ${helper}\n`);
        const env = childEnvironment({ ...process.env, GIT_CONFIG_GLOBAL: gitconfig });
        const url = `http://127.0.0.1:${server.port ?? 0}/rules.git`;
        const before = includeDirs();
        const outcome = await simpleGitRunner({ env }).lsRemote(url, ["HEAD"], { credentials });
        expect(outcome.kind).toBe("failed");
        expect(existsSync(marker)).toBe(consulted);
        expect(includeDirs()).toEqual(before);
      });
    } finally {
      server.stop(true);
    }
  });

  test("ssh runs in batch mode ahead of the user's own options, so a question fails instead of waiting", async () => {
    await withTempDir(async (dir) => {
      const record = join(dir, "ssh-args");
      const fakeSsh = join(dir, "ssh.sh");
      writeFileSync(fakeSsh, `#!/bin/sh\necho "$@" > ${record}\nexit 255\n`, { mode: 0o755 });
      const env = gitEnvironment({
        ...process.env,
        GIT_SSH_COMMAND: `${fakeSsh} -o BatchMode=no -i /home/user/.ssh/key`,
      });
      const outcome = await simpleGitRunner({ env }).lsRemote(
        "ssh://example.com/rules.git",
        ["HEAD"],
        {
          credentials: { kind: "inherited" },
        },
      );
      expect(outcome.kind).toBe("failed");
      const args = readFileSync(record, "utf8").trim().split(" ");
      expect(args.indexOf("BatchMode=yes")).toBeGreaterThan(-1);
      expect(args.indexOf("BatchMode=yes")).toBeLessThan(args.indexOf("BatchMode=no"));
      expect(args).toContain("/home/user/.ssh/key");
    });
  });

  test("a GIT_SSH program path stays one literal word ahead of BatchMode", () => {
    const env = gitEnvironment({ GIT_SSH: "/home/user/My $Tools/it's ssh" });
    expect(env.GIT_SSH_COMMAND).toBe("'/home/user/My $Tools/it'\\''s ssh' -o BatchMode=yes");
    expect(env.GIT_SSH).toBeUndefined();
  });

  test("git's environment carries no GitHub token under any of gh's names", () => {
    const env = gitEnvironment({
      PATH: "/usr/bin",
      GITHUB_TOKEN: "a",
      GH_TOKEN: "b",
      GH_ENTERPRISE_TOKEN: "c",
      GITHUB_ENTERPRISE_TOKEN: "d",
    });
    expect(Object.keys(env).filter((key) => /TOKEN/i.test(key))).toEqual([]);
    expect(env.PATH).toBe("/usr/bin");
  });

  test("simple-git's debug channel prints nothing, so a token in the environment stays out of stderr", async () => {
    await withTempDir(async (dir) => {
      const repo = await createFixtureRepo(join(dir, "repo"));
      const script = [
        `import { simpleGitRunner } from ${JSON.stringify(join(import.meta.dir, "ladder.ts"))};`,
        `const out = await simpleGitRunner().lsRemote(${JSON.stringify(repo.url)}, ["HEAD"], { credentials: { kind: "none" } });`,
        "console.log(out.kind);",
      ].join("\n");
      const proc = Bun.spawnSync(["bun", "-e", script], {
        env: { ...process.env, DEBUG: "simple-git:*", GITHUB_TOKEN: "ghp-fixture-secret" },
        stdout: "pipe",
        stderr: "pipe",
      });
      expect(proc.stdout.toString().trim()).toBe("ok");
      expect(proc.stderr.toString()).toBe("");
    });
  });

  test("an inherited GIT_DIR cannot point the clone at the caller's own repository", async () => {
    await withTempDir(async (dir) => {
      const source = await createFixtureRepo(join(dir, "source"));
      const victim = await createFixtureRepo(join(dir, "victim"));
      const env = childEnvironment({
        ...process.env,
        GIT_DIR: join(dir, "victim", ".git"),
        GIT_WORK_TREE: join(dir, "victim"),
      });
      const dest = join(dir, "clone");
      const outcome = await simpleGitRunner({ env }).shallowClone(source.url, source.head, dest, {
        credentials: { kind: "inherited" },
      });
      expect(outcome).toEqual({ kind: "ok", value: source.head });
      expect(readdirSync(join(dest, "memories")).sort()).toEqual([
        "first-rule.md",
        "second-rule.md",
      ]);
      const untouched = simpleGit(join(dir, "victim"));
      expect((await untouched.revparse(["HEAD"])).trim()).toBe(victim.head);
      expect((await untouched.raw(["remote"])).trim()).toBe("");
    });
  });

  test("a git binary that does not exist drops the rung silently", async () => {
    const warnings: string[] = [];
    const runner = scriptedRunner({
      git: simpleGitRunner({ binary: "/nonexistent/maxims-test-git" }),
      fetch: () => httpResponse(200, SHA),
    });
    expect(await ladder(runner, { warnings }).resolveRef(REPO, "HEAD", ANON)).toBe(SHA);
    expect(warnings).toEqual([]);
  });
});
