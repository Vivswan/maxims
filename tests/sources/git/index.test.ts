// Guards the plain git resolver: a URL rewritten on its way to git, a GitHub token attached to a
// foreign host, or a second transport tried behind the user's back would each install from a place
// the user never named.
import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createGitResolver } from "../../../src/sources/git/index.ts";
import { createFixtureRepo } from "../../../src/sources/github/fixtures/repo.ts";
import {
  exited,
  ghScript,
  httpResponse,
  scriptedGit,
  scriptedRunner,
} from "../../../src/sources/github/fixtures/runner.ts";
import { FetchFailure, simpleGitRunner } from "../../../src/sources/github/ladder.ts";
import { withTempDir } from "../../shared/temp_dir.ts";

const SHA = "0123abc0123abc0123abc0123abc0123abc01234";
const MIRROR = "https://mirror.example.com/github.com/example-user/rules.git";
const FROM = { type: "git" as const, url: MIRROR, ref: "HEAD" };

async function failure(action: Promise<unknown>): Promise<FetchFailure> {
  try {
    await action;
  } catch (error) {
    if (error instanceof FetchFailure) return error;
    throw error;
  }
  throw new Error("expected the resolver to fail");
}

describe("createGitResolver", () => {
  test("a mirror URL naming github.com in its path reaches git verbatim, with no token and no gh", async () => {
    await withTempDir(async (tempDir) => {
      const runner = scriptedRunner({
        exec: ghScript(() => exited(0, SHA)),
        git: scriptedGit({
          lsRemote: () => ({ kind: "ok", value: `${SHA}\tHEAD\n` }),
          shallowClone: (_url, _ref, dir) => {
            mkdirSync(join(dir, "memories"), { recursive: true });
            writeFileSync(join(dir, "memories", "a-rule.md"), "cloned\n");
            return { kind: "ok", value: SHA };
          },
        }),
        fetch: () => httpResponse(200, "never"),
      });
      const warnings: string[] = [];
      const resolver = createGitResolver({
        runner,
        warn: (m) => warnings.push(m),
        rung: () => {},
        env: { GITHUB_TOKEN: "secret", GH_TOKEN: "secret" },
      });
      const result = await resolver.fetch(FROM, {
        memoryPath: "memories",
        fullDepth: false,
        tempDir,
        auth: true,
      });
      expect(result.sha).toBe(SHA);
      expect(result.files).toEqual([{ relPath: "memories/a-rule.md", text: "cloned\n" }]);
      expect(runner.calls).toEqual([
        `git ls-remote ${MIRROR} HEAD HEAD^{} [creds=inherited]`,
        `git clone ${MIRROR} ${SHA} [creds=inherited sparse=memories]`,
      ]);
      expect(warnings).toEqual([
        `${MIRROR}: --auth does not apply a GitHub token to this host; git's own credential helpers are used`,
      ]);
    });
  });

  test("clone is the only transport: a failure ends there, and a 429 is a network fault", async () => {
    await withTempDir(async (tempDir) => {
      const runner = scriptedRunner({
        git: scriptedGit({
          lsRemote: () => ({
            kind: "failed",
            message: "fatal: unable to access: The requested URL returned error: 429",
          }),
        }),
        fetch: () => httpResponse(200, SHA),
      });
      const resolver = createGitResolver({ runner, warn: () => {}, rung: () => {}, env: {} });
      const error = await failure(
        resolver.fetch(FROM, { memoryPath: "memories", fullDepth: false, tempDir, auth: false }),
      );
      expect(error.kind).toBe("network");
      expect(runner.calls).toEqual([`git ls-remote ${MIRROR} HEAD HEAD^{} [creds=inherited]`]);
    });
  });

  test("a full sha pin resolves without a rung", async () => {
    const runner = scriptedRunner();
    const resolver = createGitResolver({ runner, warn: () => {}, rung: () => {}, env: {} });
    expect(await resolver.resolveRef(FROM, SHA.toUpperCase())).toBe(SHA);
    expect(runner.calls).toEqual([]);
  });

  test("the auth notice never repeats credentials embedded in the URL", async () => {
    const warnings: string[] = [];
    const resolver = createGitResolver({
      runner: scriptedRunner(),
      warn: (m) => warnings.push(m),
      rung: () => {},
      env: {},
    });
    await resolver.resolveRef(
      { type: "git", url: "https://example-user:s3cret@mirror.example.com/rules.git", ref: "HEAD" },
      SHA,
      { auth: true },
    );
    expect(warnings).toEqual([
      "https://mirror.example.com/rules.git: --auth does not apply a GitHub token to this host; git's own credential helpers are used",
    ]);
  });

  test("a password in the URL reaches neither a warning nor the recorded failure, even under GIT_TRACE", async () => {
    const warnings: string[] = [];
    const resolver = createGitResolver({
      warn: (m) => warnings.push(m),
      rung: () => {},
      env: { ...process.env, GIT_TRACE: "1", GIT_TRACE_CURL: "1", GIT_CURL_VERBOSE: "1" },
    });
    const error = await failure(
      resolver.resolveRef(
        {
          type: "git",
          url: "http://example-user:fixture-secret@127.0.0.1:1/rules.git",
          ref: "HEAD",
        },
        undefined,
        { auth: true },
      ),
    );
    expect(error.kind).toBe("network");
    expect(error.message).not.toContain("fixture-secret");
    expect(warnings.join("\n")).not.toContain("fixture-secret");
    expect(error.message).toMatch(/^git ls-remote: /);
  });

  test("a file:// fixture repo is resolved, pinned to its tag, and sparse-cloned", async () => {
    await withTempDir(async (dir) => {
      const repo = await createFixtureRepo(join(dir, "repo"));
      const from = { type: "git" as const, url: repo.url, ref: "v1" };
      const runner = scriptedRunner({ git: simpleGitRunner() });
      const resolver = createGitResolver({ runner, warn: () => {}, rung: () => {}, env: {} });
      expect(await resolver.resolveRef(from, "HEAD")).toBe(repo.head);
      const tempDir = join(dir, "temp");
      const result = await resolver.fetch(from, {
        memoryPath: "memories",
        fullDepth: false,
        tempDir,
        auth: false,
      });
      expect(result.sha).toBe(repo.tagged);
      expect(result.files).toEqual([{ relPath: "memories/first-rule.md", text: "first\n" }]);
      expect(readdirSync(join(tempDir, "tree"))).not.toContain("src");
      expect(existsSync(join(tempDir, "tree", "memories", "first-rule.md"))).toBe(true);
    });
  });

  test("a memory path naming the repository root checks out the whole tree, nested files included", async () => {
    await withTempDir(async (dir) => {
      const repo = await createFixtureRepo(join(dir, "repo"));
      const resolver = createGitResolver({
        runner: scriptedRunner({ git: simpleGitRunner() }),
        warn: () => {},
        rung: () => {},
        env: {},
      });
      const result = await resolver.fetch(
        { type: "git", url: repo.url, ref: repo.head },
        { memoryPath: "./", fullDepth: false, tempDir: join(dir, "temp"), auth: false },
      );
      expect(result.files.map((f) => f.relPath)).toEqual([
        "-dashed/odd-rule.md",
        "memories/first-rule.md",
        "memories/second-rule.md",
      ]);
    });
  });
});
