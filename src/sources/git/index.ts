import { join } from "node:path";
import { canonicalSourceKey, type SourceFrom } from "../../state/schema.ts";
import type { FetchResult, SourceResolver } from "../contract.ts";
import type { AuthOptions, GithubFetchOptions } from "../github/index.ts";
import {
  climb,
  cloneRung,
  FetchFailure,
  lsRemoteRung,
  type Runner,
  sparsePathFor,
  systemRunner,
} from "../github/ladder.ts";
import { readMemoryTree, type WarnSink } from "../tree.ts";

export type GitSourceFrom = Extract<SourceFrom, { type: "git" }>;

export type GitResolverOptions = {
  warn: WarnSink;
  runner?: Runner;
  env?: NodeJS.ProcessEnv;
};

export interface GitResolver extends SourceResolver {
  resolveRef(from: SourceFrom, pin?: string, options?: AuthOptions): Promise<string>;
  fetch(from: SourceFrom, opts: GithubFetchOptions): Promise<FetchResult>;
}

const FULL_SHA = /^[0-9a-f]{40}$/i;

// One transport only: the URL is handed to git exactly as the user wrote it (a mirror path that
// happens to contain "github.com" is still this remote), and no GitHub token is ever attached,
// because a token for github.com has no business reaching another host. `auth` is acknowledged
// with a notice: git's own credential helpers are what authenticate here.
export function createGitResolver(options: GitResolverOptions): GitResolver {
  const env = options.env ?? process.env;
  const runner = options.runner ?? systemRunner(env);
  const noteAuth = (from: GitSourceFrom, auth: AuthOptions): void => {
    if (auth.auth === true) {
      options.warn(
        `${displayUrl(from.url)}: --auth does not apply a GitHub token to this host; git's own credential helpers are used`,
      );
    }
  };
  const inherited = { credentials: { kind: "inherited" } } as const;
  const resolveRef = async (
    from: SourceFrom,
    pin?: string,
    auth: AuthOptions = {},
  ): Promise<string> => {
    const git = expectGit(from);
    noteAuth(git, auth);
    const ref = pin ?? git.ref;
    if (FULL_SHA.test(ref)) return ref.toLowerCase();
    return withoutRateLimitClass(
      climb(options.warn, [lsRemoteRung(runner, git.url, ref, inherited)]),
    );
  };
  return {
    resolveRef,
    async fetch(from: SourceFrom, opts: GithubFetchOptions): Promise<FetchResult> {
      const git = expectGit(from);
      const sha = await resolveRef(git, undefined, { auth: opts.auth });
      const treeDir = join(opts.tempDir, "tree");
      const sparsePath = sparsePathFor(opts);
      const clone = cloneRung(runner, git.url, sha, treeDir, {
        ...inherited,
        ...(sparsePath === undefined ? {} : { sparsePath }),
      });
      await withoutRateLimitClass(climb(options.warn, [clone]));
      const tree = await readMemoryTree(treeDir, opts, options.warn);
      return { sha, memoryPath: opts.memoryPath, files: tree.files };
    },
  };
}

// A plain git remote has no rate-limit contract to report against, so an HTTP 429 from one is the
// same transient condition as any other network fault: retry later, nothing to fix.
async function withoutRateLimitClass<T>(action: Promise<T>): Promise<T> {
  try {
    return await action;
  } catch (cause) {
    if (cause instanceof FetchFailure && cause.kind === "ratelimit") {
      throw new FetchFailure("network", cause.message, cause.retryAfterSeconds);
    }
    throw cause;
  }
}

// A remote URL may carry `user:password@`; a notice is not the place for it.
function displayUrl(url: string): string {
  try {
    const parsed = new URL(url);
    parsed.username = "";
    parsed.password = "";
    return parsed.toString();
  } catch {
    return url;
  }
}

function expectGit(from: SourceFrom): GitSourceFrom {
  if (from.type !== "git") {
    throw new Error(`the git resolver cannot fetch ${canonicalSourceKey(from)}`);
  }
  return from;
}
