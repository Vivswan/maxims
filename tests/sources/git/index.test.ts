// Guards the plain git resolver: a URL rewritten on its way to git, a GitHub token attached to a
// foreign host, or a second transport tried behind the user's back would each install from a place
// the user never named.
import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { FetchFailure } from "../../../src/sources/contract.ts";
import { createGitResolver } from "../../../src/sources/git/index.ts";
import { createFixtureRepo } from "../../../src/sources/github/fixtures/repo.ts";
import {
  exited,
  ghScript,
  httpResponse,
  scriptedGit,
  scriptedRunner,
} from "../../../src/sources/github/fixtures/runner.ts";
import { simpleGitRunner } from "../../../src/sources/github/ladder.ts";
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

  // What would drift: a redaction that only knows http(s) would print an ssh URL's password, which
  // the CLI accepts in a `ssh://user:password@host` remote, into the notice.
  const embedded: [string, string][] = [
    [
      "https://example-user:s3cret@mirror.example.com/rules.git",
      "https://mirror.example.com/rules.git",
    ],
    [
      "ssh://example-user:s3cret@mirror.example.com/rules.git",
      "ssh://mirror.example.com/rules.git",
    ],
  ];
  test.each(embedded)(
    "the auth notice never repeats credentials embedded in %s",
    async (url, shown) => {
      const warnings: string[] = [];
      const resolver = createGitResolver({
        runner: scriptedRunner(),
        warn: (m) => warnings.push(m),
        rung: () => {},
        env: {},
      });
      await resolver.resolveRef({ type: "git", url, ref: "HEAD" }, SHA, { auth: true });
      expect(warnings).toEqual([
        `${shown}: --auth does not apply a GitHub token to this host; git's own credential helpers are used`,
      ]);
    },
  );

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

  // What would drift: a runner that hands git the URL as typed has git decode it and print the
  // password in pieces (cut at a decoded `/`, `:port`, `@` or `[]`, lowercased or octal-escaped by
  // ssh, a control byte written as `?`) that no shape-based redaction can know; one that
  // re-serializes the URL changes the host, port or path an `insteadOf` rule matches. Every line
  // names the host as typed and no piece of the password.
  const passwordUrls: [string, string[], string[]][] = [
    [
      "git://fixture-user:fixture%20secret@host.invalid/o/r.git",
      ["fixture secret", "fixture%20secret", "fixture"],
      ["host.invalid"],
    ],
    [
      "git://fixture-user:fixture%2Fsecret@HOST.invalid:9418/o/r.git",
      ["fixture/secret", "fixture%2Fsecret", "fixture"],
      ["HOST.invalid", "9418"],
    ],
    [
      "git://fixture-user:fixture%2Fsecret%ZZ@host.invalid/o/r.git",
      ["fixture", "%ZZ"],
      ["host.invalid"],
    ],
    [
      "git://fixture-user:fixture%00%2Fsecret@host.invalid/o/r.git",
      ["fixture", "%00"],
      ["host.invalid"],
    ],
    ["git://fixture-user:fixture%01%2Fsecret@host.invalid/o/r.git", ["fixture"], ["host.invalid"]],
    ["git://fixture-user:77%2Fsecret@host.invalid/o/r.git", ["77", "secret"], ["host.invalid"]],
    [
      "git://fixture-user:fixture\tsecret%2Frest@host.invalid/o/r.git",
      ["fixture", "secret"],
      ["host.invalid"],
    ],
    [
      "git://fixture-user:prefix%40%5Bfixture-secret%5Dtrailing%2Frest@host.invalid/o/r.git",
      ["prefix", "fixture-secret", "trailing"],
      ["host.invalid"],
    ],
    [
      "ssh://fixture-user:fixture%40fixture-secret%2Frest@host.invalid/o/r.git",
      ["fixture", "rest"],
      ["host.invalid"],
    ],
    [
      "ssh://fixture-user:prefix%40FiXtUrE-SeCrEt%2Frest@host.invalid/o/r.git",
      ["prefix", "fixture-secret", "FiXtUrE"],
      ["host.invalid"],
    ],
    [
      "ssh://fixture-user:fixture%C3%A9%2Fsecret@host.invalid/o/r.git",
      ["fixture", "\\303"],
      ["host.invalid"],
    ],
    [
      "https://fixture-user:fixture%20secret@HOST.invalid:443/o/r.git",
      ["fixture", "secret"],
      ["https://HOST.invalid:443/o/r.git"],
    ],
    [
      "https://fixture-user:prefix@fixture secret@host.invalid/o/r.git",
      ["prefix", "fixture", "secret"],
      ["https://host.invalid/o/r.git"],
    ],
    [
      "https://\t/fixture-user:fixture secret@host.invalid/o/r.git",
      ["fixture", "secret"],
      ["https://host.invalid/o/r.git"],
    ],
    [
      "https://fixture-user:fixture%0Asecret@host.invalid/o/r.git",
      ["fixture%0Asecret", "fixture", "secret"],
      ["host.invalid"],
    ],
  ];
  const passwordRung = async (
    url: string,
    env: NodeJS.ProcessEnv,
    absent: string[],
    kept: string[],
  ): Promise<void> => {
    const rungs: string[] = [];
    const resolver = createGitResolver({ warn: () => {}, rung: (m) => rungs.push(m), env });
    const error = await failure(resolver.resolveRef({ type: "git", url, ref: "HEAD" }));
    expect(rungs).toEqual([error.message]);
    expect(error.message).toMatch(/^git ls-remote: /);
    for (const piece of absent) expect(error.message).not.toContain(piece);
    for (const part of kept) expect(error.message).toContain(part);
  };
  test.each(passwordUrls)(
    "the password in %j reaches neither the rung line nor the recorded failure, and the host does",
    (url, absent, kept) => passwordRung(url, process.env, absent, kept),
  );

  // What would drift: git applies the user's `insteadOf` to the bytes they typed, after the runner
  // has handed them over. A runner that withholds the password first defeats a rule keyed on it,
  // so the lookup goes to the typed host instead of the mirror; one that lets git expand a rule
  // whose target carries a password has git decode and print it in pieces. Each row is one
  // gitconfig rule `url.<to>.insteadOf = <from>` and the URL the user typed.
  const rewrittenUrls: [string, string, string, string[], string[]][] = [
    [
      "https://host.invalid/o/r.git",
      "https://host.invalid/",
      "git://fixture-user:fixture%2Fsecret@host.invalid/",
      ["fixture/secret", "fixture%2Fsecret", "fixture-user:fixture"],
      ["host.invalid"],
    ],
    [
      "git://fixture-user:fixture-secret@host.invalid/o/r.git",
      "git://fixture-user:fixture-secret@host.invalid/",
      "https://mirror.invalid/",
      ["fixture-secret", "host.invalid"],
      ["mirror.invalid"],
    ],
    [
      "https://fixture-user:fixture@secret@host.invalid/o/r.git",
      "https://fixture-user:fixture@secret@host.invalid/",
      "https://mirror.invalid/",
      ["fixture@secret", "fixture%40secret", "host.invalid"],
      ["mirror.invalid"],
    ],
  ];
  test.each(rewrittenUrls)(
    "typed %j under the rule %j -> %j follows the rule and prints no password",
    (url, from, to, absent, kept) =>
      passwordRung(
        url,
        {
          ...process.env,
          GIT_CONFIG_COUNT: "1",
          GIT_CONFIG_KEY_0: `url.${to}.insteadOf`,
          GIT_CONFIG_VALUE_0: from,
        },
        absent,
        kept,
      ),
  );

  // What would drift: a runner that withholds a typed password from git over http(s) too would
  // leave nothing to answer a 401 with. Git decodes the userinfo before it builds the Basic
  // credential, so a `%40` arrives at the server as `@`.
  const basic = (userinfo: string): string => `Basic ${Buffer.from(userinfo).toString("base64")}`;
  const typedPasswords: [string, string][] = [
    ["fixture-secret", basic("example-user:fixture-secret")],
    ["fixture%40secret", basic("example-user:fixture@secret")],
  ];
  test.each(typedPasswords)(
    "a typed http password %s answers the server's 401 as Basic auth and stays out of the failure",
    async (password, expected) => {
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
        const url = `http://example-user:${password}@127.0.0.1:${server.port ?? 0}/rules.git`;
        const resolver = createGitResolver({ warn: () => {}, rung: () => {}, env: process.env });
        const error = await failure(resolver.resolveRef({ type: "git", url, ref: "HEAD" }));
        expect(seen.filter((value) => value !== null)).toEqual([expected]);
        expect(error.kind).toBe("auth");
        expect(error.message).not.toContain("secret");
      } finally {
        server.stop(true);
      }
    },
  );

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
