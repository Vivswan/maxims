// Guards the source grammar: `owner/repo`, URLs, `.` and relative paths must keep landing on the
// shapes the rest of the tool switches on, a bad spelling must be a usage refusal, and a GH_HOST
// alias must fold the way gh folds it.
import { describe, expect, test } from "bun:test";
import { dirname, join, resolve } from "node:path";
import {
  parseSourceArgument,
  parseSourceSelector,
} from "../../../src/commands/shared/source-argument.ts";
import type { SourceFrom } from "../../../src/contracts/source.ts";
import { ExitCode } from "../../../src/util/exit-codes.ts";
import { memoryName } from "../../engine/fakes.ts";
import { outcome } from "../../shared/outcome.ts";

const RUBBER_DUCK = memoryName("rubber-duck-before-every-commit");
const USAGE_REFUSAL = expect.objectContaining({ code: ExitCode.Usage });

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
    for (const attempt of attempts) expect(attempt).toThrow(USAGE_REFUSAL);
  });

  // GH_HOST is an ambient environment variable: a github.com URL pasted from a browser must keep
  // meaning github.com whatever the shell happens to export, or the same command line would
  // install a different source on a differently configured machine. A GH_HOST or URL host that is
  // an alias of github.com must record NO host, or the fetch ladder offers the enterprise token
  // and builds `https://api.github.com/api/v3/...`; an `api.` prefix on a tenancy host must fold
  // to the tenant, or the ladder builds `api.api.<tenant>.ghe.com`. The folding is go-gh's
  // NormalizeHostname, so gh and maxims agree on what one GH_HOST means.
  const hosted = (host: string): SourceFrom => ({
    type: "github",
    repo: "team/rules",
    ref: "HEAD",
    host,
  });
  const enterprise = hosted("github.example.com");
  const underGhHost: [string, string | undefined, SourceFrom][] = [
    ["https://github.example.com/team/rules", "github.example.com", enterprise],
    ["git@github.example.com:team/rules.git", "github.example.com", enterprise],
    ["@team/rules", "github.example.com", enterprise],
    ["team/rules", "github.example.com", enterprise],
    ["@team/rules", "GitHub.Example.com", enterprise],
    ["https://github.com/team/rules", "github.example.com", github("team/rules")],
    ["git@github.com:team/rules.git", "github.example.com", github("team/rules")],
    [
      "https://github.com/team/rules/tree/main",
      "github.example.com",
      { type: "github", repo: "team/rules", ref: "main" },
    ],
    [
      "https://gitlab.example.com/team/rules",
      "github.example.com",
      git("https://gitlab.example.com/team/rules"),
    ],
    ["https://gitlab.example.com/team/rules", "", git("https://gitlab.example.com/team/rules")],
    ["@team/rules", "github.com", github("team/rules")],
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
  test.each(underGhHost)(
    "%s with GH_HOST %j records the host gh would",
    (arg, ghHost, expected) => {
      expect(parseSourceArgument(arg, cwd, ghHost === undefined ? {} : { ghHost })).toEqual(
        expected,
      );
    },
  );

  // An `@owner/repo` shorthand in the advice would be re-hosted under GH_HOST on an enterprise
  // shell, so the message must point at the URL the user already has plus the two flags.
  test("a tree URL with a path is refused as usage, advised without an @owner/repo shorthand", () => {
    const refused = outcome(() =>
      parseSourceArgument("https://github.com/example-user/rules/tree/release/1.0", cwd),
    );
    expect(refused).toMatchObject({ kind: "threw", error: { code: ExitCode.Usage } });
    const message = refused.kind === "threw" ? (refused.error as Error).message : "";
    expect(message.slice(message.indexOf(": ") + 2)).not.toContain("@");
    expect(message).toContain("--pin <ref> --from <path>");
  });

  const rejected = [
    "",
    "@only-owner",
    "@a/b/c",
    "ftp://gitlab.example.com/a/b",
    "https://github.com/only-owner",
    "https://github.com/example-user/rules/blob/main",
    "https://gitlab.example.com/team/.git",
    "https://gitlab.example.com/acme/rules/..git",
    "git@gitlab.example.com:acme/rules#v2",
    "git@gitlab.example.com:acme/rules@v2-fb04dcb6",
    "https://gitlab.example.com/acme/rules#v2",
    "https://gitlab.example.com/acme/rules#",
    "https://gitlab.example.com/...git",
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
    expect(() => parseSourceArgument(arg, cwd)).toThrow(USAGE_REFUSAL);
  });
});
