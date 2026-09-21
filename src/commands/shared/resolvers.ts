import type { ResolverFor, SourceFrom, SourceResolver } from "../../sources/contract.ts";
import { createGitResolver } from "../../sources/git/index.ts";
import { createGithubResolver } from "../../sources/github/index.ts";
import type { Runner } from "../../sources/github/ladder.ts";
import { createLocalResolver } from "../../sources/local.ts";
import type { WarnSink } from "../../sources/tree.ts";

export type ResolverOptions = {
  warn: WarnSink;
  rung: WarnSink;
  runner?: Runner;
  env: NodeJS.ProcessEnv;
};

// The real registry behind `ResolverFor`: one resolver per source variant, each built once. The
// returned resolver closes over the value it was asked for and ignores the one handed back to
// its members, which is how a variant-typed resolver serves the generic contract without a cast.
export function createResolvers(options: ResolverOptions): ResolverFor {
  const runner = options.runner === undefined ? {} : { runner: options.runner };
  const sinks = { warn: options.warn, rung: options.rung };
  const github = createGithubResolver({ ...sinks, env: options.env, ...runner });
  const git = createGitResolver({ ...sinks, env: options.env, ...runner });
  const local = createLocalResolver(options.warn);
  return <F extends SourceFrom>(from: F): SourceResolver<F> => {
    if (from.type === "github") {
      return {
        resolveRef: (_target, pin, request) => github.resolveRef(from, pin, request),
        fetch: (_target, opts) => github.fetch(from, opts),
      };
    }
    if (from.type === "git") {
      return {
        resolveRef: (_target, pin, request) => git.resolveRef(from, pin, request),
        fetch: (_target, opts) => git.fetch(from, opts),
      };
    }
    return { fetch: (_target, opts) => local.fetch(from, opts) };
  };
}
