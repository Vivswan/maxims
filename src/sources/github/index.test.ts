// Guards the github resolver's cheap path and its end-to-end shape: a full sha that still hit the
// network, a fetch that ran gh or sent a token without `auth`, a live source asked to fetch, or a
// fetched tree read from the wrong folder would each cost every session start or install the wrong
// memories.
import { describe, expect, test } from "bun:test";
import { withTempDir } from "../../../tests/shared/temp_dir.ts";
import { exited, ghScript, httpResponse, scriptedGit, scriptedRunner } from "./fixtures/runner.ts";
import { cleanTarball, FIXTURE_MEMORIES } from "./fixtures/tarballs.ts";
import { createGithubResolver, needsFetch } from "./index.ts";

const SHA = "0123abc0123abc0123abc0123abc0123abc01234";
const FROM = { type: "github" as const, repo: "Example-User/rules", ref: "HEAD" };
const NO_ENV = {};

function authorizationOf(init: RequestInit | undefined): string | undefined {
  const headers = init?.headers;
  return headers === undefined
    ? undefined
    : (new Headers(headers).get("authorization") ?? undefined);
}

describe("resolveRef", () => {
  test("a full sha, in any case, resolves without touching a rung", async () => {
    const runner = scriptedRunner();
    const resolver = createGithubResolver({ runner, warn: () => {}, env: NO_ENV });
    expect(await resolver.resolveRef({ ...FROM, ref: SHA.toUpperCase() })).toBe(SHA);
    expect(await resolver.resolveRef(FROM, SHA)).toBe(SHA);
    expect(runner.calls).toEqual([]);
  });

  test("a pin replaces the stored ref for that resolution only, anonymously by default", async () => {
    const seen: RequestInit[] = [];
    const runner = scriptedRunner({
      fetch: (url, init) => {
        seen.push(init);
        return httpResponse(200, url.endsWith("/v2") ? SHA : "x");
      },
    });
    const resolver = createGithubResolver({
      runner,
      warn: () => {},
      env: { GITHUB_TOKEN: "secret" },
    });
    expect(await resolver.resolveRef(FROM, "v2")).toBe(SHA);
    expect(runner.calls).toEqual([
      "git ls-remote https://github.com/Example-User/rules.git refs/tags/v2 refs/tags/v2^{} refs/heads/v2 refs/heads/v2^{} [creds=none]",
      "fetch https://api.github.com/repos/Example-User/rules/commits/v2",
    ]);
    expect(authorizationOf(seen[0])).toBeUndefined();
  });
});

describe("needsFetch", () => {
  const cases: [string, Parameters<typeof needsFetch>, boolean][] = [
    ["equal shas skip the fetch", [FROM, SHA, SHA], false],
    ["a changed sha fetches", [FROM, "sha256:old", SHA], true],
    ["a never-fetched source fetches", [FROM, undefined, SHA], true],
    [
      "a copied local source compares like a remote",
      [{ type: "local", path: "/home/user/m" }, "a", "b"],
      true,
    ],
    [
      "a live local source never fetches",
      [{ type: "local", path: "/home/user/m", live: true }, undefined, "b"],
      false,
    ],
  ];
  test.each(cases)("%s", (_label, args, expected) => {
    expect(needsFetch(...args)).toBe(expected);
  });
});

describe("fetch", () => {
  test("anonymous: sparse clone first, tarball only when git is absent, gh never, no token", async () => {
    await withTempDir(async (tempDir) => {
      const seen: (string | undefined)[] = [];
      const runner = scriptedRunner({
        exec: ghScript(() => exited(0, SHA)),
        fetch: (url, init) => {
          seen.push(authorizationOf(init));
          return httpResponse(200, url.includes("/commits/") ? SHA : cleanTarball());
        },
      });
      const warnings: string[] = [];
      const resolver = createGithubResolver({
        runner,
        warn: (m) => warnings.push(m),
        env: { GITHUB_TOKEN: "secret" },
      });
      const result = await resolver.fetch(FROM, {
        memoryPath: "memories",
        fullDepth: false,
        tempDir,
        auth: false,
      });
      expect(result).toEqual({
        sha: SHA,
        memoryPath: "memories",
        files: [
          { relPath: "memories/commit-review.md", text: FIXTURE_MEMORIES["commit-review"] },
          { relPath: "memories/tests-first.md", text: FIXTURE_MEMORIES["tests-first"] },
        ],
      });
      expect(warnings).toEqual([]);
      expect(runner.calls).toEqual([
        "git ls-remote https://github.com/Example-User/rules.git HEAD HEAD^{} [creds=none]",
        "fetch https://api.github.com/repos/Example-User/rules/commits/HEAD",
        `git clone https://github.com/Example-User/rules.git ${SHA} [creds=none sparse=memories]`,
        `fetch https://codeload.github.com/Example-User/rules/tar.gz/${SHA}`,
      ]);
      expect(seen).toEqual([undefined, undefined]);
    });
  });

  test("with auth: gh resolves and fetches first, and a pre-resolved sha skips resolution", async () => {
    await withTempDir(async (tempDir) => {
      const runner = scriptedRunner({
        exec: ghScript((args) =>
          args.some((arg) => arg.includes("/commits/"))
            ? exited(0, SHA)
            : exited(0, cleanTarball()),
        ),
      });
      const resolver = createGithubResolver({ runner, warn: () => {}, env: NO_ENV });
      const first = await resolver.fetch(FROM, {
        memoryPath: "memories",
        fullDepth: false,
        tempDir,
        auth: true,
      });
      expect(first.sha).toBe(SHA);
      const second = await resolver.fetch(
        { ...FROM, ref: SHA },
        { memoryPath: "memories", fullDepth: true, tempDir, auth: true },
      );
      expect(second.files.map((f) => f.relPath)).toEqual([
        "README.md",
        "memories/commit-review.md",
        "memories/tests-first.md",
      ]);
      expect(runner.calls).toEqual([
        "exec gh auth status --hostname github.com",
        "exec gh api --hostname github.com repos/Example-User/rules/commits/HEAD --jq .sha",
        `exec gh api --hostname github.com repos/Example-User/rules/tarball/${SHA}`,
        `exec gh api --hostname github.com repos/Example-User/rules/tarball/${SHA}`,
      ]);
    });
  });

  test("with auth and a token, the clone carries the header and the tarball the Bearer", async () => {
    await withTempDir(async (tempDir) => {
      const seen: RequestInit[] = [];
      const runner = scriptedRunner({
        git: scriptedGit({ shallowClone: () => ({ kind: "ok", value: "not-the-sha" }) }),
        fetch: (_url, init) => {
          seen.push(init);
          return httpResponse(200, cleanTarball());
        },
      });
      const resolver = createGithubResolver({ runner, warn: () => {}, env: { GH_TOKEN: "t0k" } });
      await resolver.fetch(
        { ...FROM, ref: SHA },
        { memoryPath: "memories", fullDepth: false, tempDir, auth: true },
      );
      expect(runner.calls).toEqual([
        "exec gh auth status --hostname github.com",
        `git clone https://github.com/Example-User/rules.git ${SHA} [header=Authorization: Bearer t0k sparse=memories]`,
        `fetch https://codeload.github.com/Example-User/rules/tar.gz/${SHA}`,
      ]);
      expect(authorizationOf(seen[0])).toBe("Bearer t0k");
    });
  });

  // GH_HOST is resolved once, when a source is added, into the record's `host`; at fetch time the
  // shell's value is ambient noise, or one machine would fetch a recorded source from another host.
  const hosts: [string, string | undefined, string, string][] = [
    [
      "a github.com source stays on github.com under a foreign GH_HOST",
      undefined,
      "ghe.example.com",
      "github.com",
    ],
    [
      "an enterprise source reaches its own host under a foreign GH_HOST",
      "ghe.example.com",
      "other.example.com",
      "ghe.example.com",
    ],
    [
      "an enterprise source reaches its own host with GH_HOST unset",
      "ghe.example.com",
      "",
      "ghe.example.com",
    ],
  ];
  test.each(hosts)("%s", async (_label, host, ghHost, expected) => {
    await withTempDir(async (tempDir) => {
      const runner = scriptedRunner({ fetch: () => httpResponse(200, cleanTarball()) });
      const resolver = createGithubResolver({
        runner,
        warn: () => {},
        env: ghHost === "" ? {} : { GH_HOST: ghHost },
      });
      const from = host === undefined ? { ...FROM, ref: SHA } : { ...FROM, ref: SHA, host };
      await resolver.fetch(from, {
        memoryPath: "memories",
        fullDepth: false,
        tempDir,
        auth: false,
      });
      const archive =
        expected === "github.com"
          ? `https://codeload.github.com/Example-User/rules/tar.gz/${SHA}`
          : `https://${expected}/Example-User/rules/archive/${SHA}.tar.gz`;
      expect(runner.calls).toEqual([
        `git clone https://${expected}/Example-User/rules.git ${SHA} [creds=none sparse=memories]`,
        `fetch ${archive}`,
      ]);
    });
  });

  // gh's own convention: GITHUB_TOKEN and GH_TOKEN belong to github.com and its ghe.com tenants,
  // the two ENTERPRISE names to every other host. A github.com token sent to an enterprise server
  // would hand it to a third party; an enterprise token sent to a tenant is a leak the other way.
  test("with auth, each host is offered only its own token, and gh is asked per host", async () => {
    await withTempDir(async (tempDir) => {
      const seen: { url: string; authorization: string | undefined }[] = [];
      const runner = scriptedRunner({
        git: scriptedGit({ shallowClone: () => ({ kind: "ok", value: "not-the-sha" }) }),
        fetch: (url, init) => {
          seen.push({ url, authorization: authorizationOf(init) });
          return httpResponse(200, cleanTarball());
        },
      });
      const resolver = createGithubResolver({
        runner,
        warn: () => {},
        env: { GITHUB_TOKEN: "dotcom", GH_ENTERPRISE_TOKEN: "ghe" },
      });
      const opts = { memoryPath: "memories", fullDepth: false, tempDir, auth: true };
      await resolver.fetch({ ...FROM, ref: SHA }, opts);
      await resolver.fetch({ ...FROM, ref: SHA, host: "ghe.example.com" }, opts);
      await resolver.fetch({ ...FROM, ref: SHA, host: "ghe.example.com" }, opts);
      await resolver.fetch({ ...FROM, ref: SHA, host: "octo.ghe.com" }, opts);
      expect(runner.calls).toEqual([
        "exec gh auth status --hostname github.com",
        `git clone https://github.com/Example-User/rules.git ${SHA} [header=Authorization: Bearer dotcom sparse=memories]`,
        `fetch https://codeload.github.com/Example-User/rules/tar.gz/${SHA}`,
        "exec gh auth status --hostname ghe.example.com",
        `git clone https://ghe.example.com/Example-User/rules.git ${SHA} [header=Authorization: Bearer ghe sparse=memories]`,
        `fetch https://ghe.example.com/Example-User/rules/archive/${SHA}.tar.gz`,
        `git clone https://ghe.example.com/Example-User/rules.git ${SHA} [header=Authorization: Bearer ghe sparse=memories]`,
        `fetch https://ghe.example.com/Example-User/rules/archive/${SHA}.tar.gz`,
        "exec gh auth status --hostname octo.ghe.com",
        `git clone https://octo.ghe.com/Example-User/rules.git ${SHA} [header=Authorization: Bearer dotcom sparse=memories]`,
        `fetch https://api.octo.ghe.com/repos/Example-User/rules/tarball/${SHA}`,
      ]);
      expect(seen.map((s) => s.authorization)).toEqual([
        "Bearer dotcom",
        "Bearer ghe",
        "Bearer ghe",
        "Bearer dotcom",
      ]);
    });
  });
});
