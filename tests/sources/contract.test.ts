// Guards the resolver contract against widening: if the members reverted to method shorthand, a
// resolver typed for one source variant would silently become assignable to the slot typed for
// every variant. The pin is compile-time only, so the typecheck gate is the test.
import type { SourceFrom } from "../../src/contracts/source.ts";
import type { FetchResult, SourceResolver } from "../../src/sources/contract.ts";

type GithubFrom = Extract<SourceFrom, { type: "github" }>;

const empty: Omit<FetchResult, "sha"> = { memoryPath: "memories", files: [] };
const githubOnly: SourceResolver<GithubFrom> = {
  resolveRef: async (from, pin) => `${from.repo}@${pin ?? from.ref}`,
  fetch: async (from) => ({ ...empty, sha: from.repo }),
};

// @ts-expect-error a resolver for one variant is not a resolver for every variant
const widened: SourceResolver = githubOnly;
void widened;
