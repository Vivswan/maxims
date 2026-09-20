import { join } from "node:path";
import type { FetchResult, SourceFrom, SourceResolver } from "../contract.ts";
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

export type GithubResolverOptions = {
  warn: WarnSink;
  runner?: Runner;
  env?: NodeJS.ProcessEnv;
  endpoints?: Partial<Endpoints>;
};

// `resolveRef` is required here where the contract leaves it optional: a GitHub ref always has a
// remote to ask.
export interface GithubResolver extends SourceResolver<GithubSourceFrom> {
  resolveRef(from: GithubSourceFrom, pin?: string, options?: { auth?: boolean }): Promise<string>;
}

const FULL_SHA = /^[0-9a-f]{40}$/i;

// `auth` is false unless the caller says otherwise: only then may `gh` run or a token leave the
// process. The CLI's `--auth` flag and a stored `intent.auth` are what supply it. A ref that is
// already a full sha never touches the network, which is why a caller that has resolved a ref once
// should pass the sha back as `from.ref` when it fetches. GH_HOST names the GitHub host for both
// the API and the clone URL; github.com when unset.
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
    from: GithubSourceFrom,
    pin?: string,
    request: { auth?: boolean } = {},
  ): Promise<string> => {
    const ref = pin ?? from.ref;
    if (FULL_SHA.test(ref)) return ref.toLowerCase();
    return ladder.resolveRef(coordinate(from), ref, { auth: request.auth === true });
  };
  return {
    resolveRef,
    async fetch(from, opts): Promise<FetchResult> {
      const sha = await resolveRef(from, undefined, { auth: opts.auth });
      const treeDir = join(opts.tempDir, "tree");
      const sparsePath = sparsePathFor(opts);
      await ladder.fetchTree(coordinate(from), sha, treeDir, {
        auth: opts.auth,
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
