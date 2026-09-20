import { join } from "node:path";
import type { FetchResult, SourceFrom, SourceResolver } from "../contract.ts";
import { readMemoryTree, type WarnSink } from "../tree.ts";
import {
  createLadder,
  DEFAULT_GH_HOST,
  endpointsFor,
  fetchTimeoutMs,
  type Ladder,
  type RepoCoordinate,
  type Runner,
  sparsePathFor,
  systemRunner,
  tokenFor,
} from "./ladder.ts";

export type GithubSourceFrom = Extract<SourceFrom, { type: "github" }>;

export type GithubResolverOptions = {
  warn: WarnSink;
  runner?: Runner;
  env?: NodeJS.ProcessEnv;
};

// `resolveRef` is required here where the contract leaves it optional: a GitHub ref always has a
// remote to ask.
export interface GithubResolver extends SourceResolver<GithubSourceFrom> {
  resolveRef(from: GithubSourceFrom, pin?: string, options?: { auth?: boolean }): Promise<string>;
}

const FULL_SHA = /^[0-9a-f]{40}$/i;

// Only with `auth` may `gh` run or a token leave the process; the CLI's `--auth` flag and a stored
// `intent.auth` are what supply it. A ref that is already a full sha never touches the network,
// which is why a caller that has resolved a ref once should pass the sha back as `from.ref` when it
// fetches. The host is the source record's own (`GH_HOST` was resolved into it when the source was
// added), never the shell's at fetch time, so a recorded source fetches from the same server on
// every machine. One ladder serves each host, because a `gh` login and a token are both per host.
export function createGithubResolver(options: GithubResolverOptions): GithubResolver {
  const env = options.env ?? process.env;
  const runner = options.runner ?? systemRunner(env);
  const timeoutMs = fetchTimeoutMs(env);
  const ladders = new Map<string, Ladder>();
  const ladderFor = (from: GithubSourceFrom): Ladder => {
    const host = from.host ?? DEFAULT_GH_HOST;
    let ladder = ladders.get(host);
    if (ladder === undefined) {
      ladder = createLadder({
        runner,
        endpoints: endpointsFor(host),
        warn: options.warn,
        timeoutMs,
        token: tokenFor(env, host),
      });
      ladders.set(host, ladder);
    }
    return ladder;
  };
  const resolveRef = async (
    from: GithubSourceFrom,
    pin?: string,
    request: { auth?: boolean } = {},
  ): Promise<string> => {
    const ref = pin ?? from.ref;
    if (FULL_SHA.test(ref)) return ref.toLowerCase();
    return ladderFor(from).resolveRef(coordinate(from), ref, { auth: request.auth === true });
  };
  return {
    resolveRef,
    async fetch(from, opts): Promise<FetchResult> {
      const sha = await resolveRef(from, undefined, { auth: opts.auth });
      const treeDir = join(opts.tempDir, "tree");
      const sparsePath = sparsePathFor(opts);
      await ladderFor(from).fetchTree(coordinate(from), sha, treeDir, {
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
