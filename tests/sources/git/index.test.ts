// Guards the plain git resolver: a URL rewritten on its way to git, a GitHub token attached to a
// foreign host, or a second transport tried behind the user's back would each install from a place
// the user never named.
import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
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

  // What would drift: a runner that hands git the URL as typed has git print the decoded password in
  // pieces no shape-based redaction can know; one that re-serializes the URL changes the host, port
  // or path an `insteadOf` rule matches. Each row: typed URL, pieces absent from every line, kept.
  //   cut at a decoded `/`, `:port`, `@` or `[]`   lowercased or octal-escaped by ssh   control byte as `?`
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
      "git://fixture-user%3Afixture%2Fsecret@host.invalid/o/r.git",
      ["fixture-user:fixture", "fixture%3A", "fixture/secret", "fixture%2Fsecret"],
      ["host.invalid"],
    ],
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

  // What would drift: git applies the user's `insteadOf` to the bytes it is handed, so the order of
  // expanding, withholding and pinning decides what it prints.
  //   withheld first           a rule keyed on the password misses
  //   expanded, not withheld   git prints the target's password in pieces
  //   withheld, not pinned     the user's rule applies again, password and all
  //   target not a URL         with userinfo, refused; without, handed to git as written
  const rewrittenUrls: [string, string, string, string[], string[]][] = [
    [
      "https://host.invalid/o/r.git",
      "https://host.invalid/",
      "git://fixture-user:fixture%2Fsecret@mirror.invalid/",
      ["fixture/secret", "fixture%2Fsecret", "fixture-user:fixture", "host.invalid"],
      ["mirror.invalid"],
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
    [
      "git://fixture-user@host.invalid/o/r.git",
      "git://fixture-user@host.invalid/",
      "git://fixture-user:fixture%2Fsecret@host.invalid/",
      ["fixture-user:fixture", "fixture%2Fsecret", "fixture/secret"],
      ["host.invalid"],
    ],
    [
      "https://host.invalid/o/r.git",
      "https://host.invalid/",
      "git://fixture-user:fixture%2Fsecret@mirror.invalid:bad-port/",
      ["fixture-user:fixture", "fixture%2Fsecret", "fixture/secret", "mirror.invalid", "bad-port"],
      ["https://host.invalid/o/r.git: an insteadOf rule in gitconfig rewrites it to a URL that"],
    ],
    [
      "https://host.invalid/o/r.git",
      "https://host.invalid/",
      "host.invalid:rules@team/",
      ["not allowed", "host.invalid://", "cannot be parsed"],
      ["host.invalid"],
    ],
    [
      "https://host.invalid/o/r.git",
      "https://host.invalid/",
      "git://[fe80::1%25lo]:9418/",
      ["cannot be parsed"],
      ["fe80::1"],
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

  // What would drift: a quoted `insteadOf` destination may end in a space that names the repository;
  // a runner that trims git's answer sends the lookup to a repository one byte short.
  test("an insteadOf destination ending in a space reaches git with the space", async () => {
    await withTempDir(async (dir) => {
      const repo = await createFixtureRepo(join(dir, "rules.git "));
      const spaced = `${pathToFileURL(join(dir, "rules.git")).href} `;
      const typed = pathToFileURL(join(dir, "typed.git")).href;
      const resolver = createGitResolver({
        warn: () => {},
        rung: () => {},
        env: {
          ...process.env,
          GIT_CONFIG_COUNT: "1",
          GIT_CONFIG_KEY_0: `url.${spaced}.insteadOf`,
          GIT_CONFIG_VALUE_0: typed,
        },
      });
      expect(await resolver.resolveRef({ type: "git", url: typed, ref: "HEAD" })).toBe(repo.head);
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
