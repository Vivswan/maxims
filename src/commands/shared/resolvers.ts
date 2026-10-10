import type { SourceFrom } from "../../contracts/source.ts";
import type { ResolverFor, SourceResolver } from "../../sources/contract.ts";
import type { GitResolver } from "../../sources/git/index.ts";
import type { GithubResolver } from "../../sources/github/index.ts";
import type { Runner } from "../../sources/github/ladder.ts";
import { createLocalResolver } from "../../sources/local.ts";
import type { WarnSink } from "../../sources/tree.ts";

export type ResolverOptions = {
  warn: WarnSink;
  rung: WarnSink;
  runner?: Runner;
  env: NodeJS.ProcessEnv;
};

type RemoteResolvers = { github: GithubResolver; git: GitResolver };

// The real registry behind `ResolverFor`: one resolver per source variant, each built once. The
// returned resolver closes over the value it was asked for and ignores the one handed back to
// its members, which is how a variant-typed resolver serves the generic contract without a cast.
export function createResolvers(options: ResolverOptions): ResolverFor {
  const local = createLocalResolver(options.warn);
  // Loaded on the first remote ref or fetch: the ladder brings simple-git and tar, which a
  // session-start `sync --quiet` with nothing due never pays for (tests/cli/module-graph.test.ts).
  let remote: Promise<RemoteResolvers> | undefined;
  const remoteResolvers = (): Promise<RemoteResolvers> => {
    remote ??= Promise.all([
      import("../../sources/github/index.ts"),
      import("../../sources/git/index.ts"),
    ]).then(([{ createGithubResolver }, { createGitResolver }]) => {
      const runner = options.runner === undefined ? {} : { runner: options.runner };
      const shared = { warn: options.warn, rung: options.rung, env: options.env, ...runner };
      return { github: createGithubResolver(shared), git: createGitResolver(shared) };
    });
    return remote;
  };
  return <F extends SourceFrom>(from: F): SourceResolver<F> => {
    if (from.type === "github") {
      return {
        resolveRef: async (_target, pin, request) =>
          (await remoteResolvers()).github.resolveRef(from, pin, request),
        fetch: async (_target, opts) => (await remoteResolvers()).github.fetch(from, opts),
      };
    }
    if (from.type === "git") {
      return {
        resolveRef: async (_target, pin, request) =>
          (await remoteResolvers()).git.resolveRef(from, pin, request),
        fetch: async (_target, opts) => (await remoteResolvers()).git.fetch(from, opts),
      };
    }
    return { fetch: (_target, opts) => local.fetch(from, opts) };
  };
}
