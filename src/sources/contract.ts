export type { SourceFrom } from "../state/schema.ts";

import type { SourceFrom } from "../state/schema.ts";

export type FetchOptions = {
  memoryPath: string;
  fullDepth: boolean;
  tempDir: string;
  auth: boolean;
};

export type FetchResult = {
  sha: string;
  memoryPath: string;
  files: { relPath: string; text: string }[];
};

// A resolver is generic over the variant it serves, so the github resolver is never handed a local
// value and needs no throwing guard. `resolveRef` is optional because a local directory has no ref
// to resolve: its `fetch` hashes the tree and reports that as the sha, which is what lets change
// detection work identically for every variant. The members are function-valued properties, not
// methods: a method parameter is bivariant, which would let a resolver for one variant pass as a
// resolver for the union and defeat the generic.
export type SourceResolver<F extends SourceFrom = SourceFrom> = {
  resolveRef?: (from: F, pin?: string, options?: { auth?: boolean }) => Promise<string>;
  fetch: (from: F, opts: FetchOptions) => Promise<FetchResult>;
};

// The dispatch shape the resolver registry implements: the resolver returned is typed for exactly
// the variant passed in.
export type ResolverFor = <F extends SourceFrom>(from: F) => SourceResolver<F>;
