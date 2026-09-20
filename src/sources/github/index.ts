import { join } from "node:path";
import { canonicalSourceKey, type SourceFrom } from "../../state/schema.ts";
import type { FetchOptions, FetchResult, SourceResolver } from "../contract.ts";
import { readMemoryTree, type WarnSink } from "../tree.ts";
import {
  createLadder,
  DEFAULT_GH_HOST,
  type Endpoints,
  endpointsFor,
  fetchTimeoutMs,
  type RepoCoordinate,
  type Runner,
  sparsePathFor,
  systemRunner,
  tokenFrom,
} from "./ladder.ts";

export type GithubSourceFrom = Extract<SourceFrom, { type: "github" }>;

// `auth` is false unless the caller says otherwise: only then may `gh` run or a token leave the
// process. The CLI's `--auth` flag and a stored `intent.auth` are what supply it.
export type AuthOptions = { auth?: boolean };
export type GithubFetchOptions = FetchOptions & AuthOptions;

export type GithubResolverOptions = {
  warn: WarnSink;
  runner?: Runner;
  env?: NodeJS.ProcessEnv;
  endpoints?: Partial<Endpoints>;
};

export interface GithubResolver extends SourceResolver {
  resolveRef(from: SourceFrom, pin?: string, options?: AuthOptions): Promise<string>;
  fetch(from: SourceFrom, opts: GithubFetchOptions): Promise<FetchResult>;
}

const FULL_SHA = /^[0-9a-f]{40}$/i;

// A ref that is already a full sha never touches the network, which is why a caller that has
// resolved a ref once should pass the sha back as `from.ref` when it fetches. GH_HOST names the
// GitHub host for both the API and the clone URL; github.com when unset.
export function createGithubResolver(options: GithubResolverOptions): GithubResolver {
  const env = options.env ?? process.env;
  const ladder = createLadder({
    runner: options.runner ?? systemRunner(env),
    endpoints: { ...endpointsFor(env.GH_HOST?.trim() || DEFAULT_GH_HOST), ...options.endpoints },
    warn: options.warn,
    timeoutMs: fetchTimeoutMs(env),
    token: tokenFrom(env),
  });
  const resolveRef = async (
    from: SourceFrom,
    pin?: string,
    auth: AuthOptions = {},
  ): Promise<string> => {
    const github = expectGithub(from);
    const ref = pin ?? github.ref;
    if (FULL_SHA.test(ref)) return ref.toLowerCase();
    return ladder.resolveRef(coordinate(github), ref, { auth: auth.auth === true });
  };
  return {
    resolveRef,
    async fetch(from: SourceFrom, opts: GithubFetchOptions): Promise<FetchResult> {
      const github = expectGithub(from);
      const auth = opts.auth === true;
      const sha = await resolveRef(github, undefined, { auth });
      const treeDir = join(opts.tempDir, "tree");
      const sparsePath = sparsePathFor(opts);
      await ladder.fetchTree(coordinate(github), sha, treeDir, {
        auth,
        ...(sparsePath === undefined ? {} : { sparsePath }),
      });
      const tree = await readMemoryTree(treeDir, opts, options.warn);
      return { sha, memoryPath: opts.memoryPath, files: tree.files };
    },
  };
}

export function needsFetch(
  from: SourceFrom,
  fetchedSha: string | undefined,
  remoteSha: string,
): boolean {
  if (from.type === "local" && from.live === true) return false;
  return fetchedSha !== remoteSha;
}

function coordinate(from: GithubSourceFrom): RepoCoordinate {
  const [owner = "", repo = ""] = from.repo.split("/", 2);
  return { owner, repo };
}

function expectGithub(from: SourceFrom): GithubSourceFrom {
  if (from.type !== "github") {
    throw new Error(`the github resolver cannot fetch ${canonicalSourceKey(from)}`);
  }
  return from;
}
