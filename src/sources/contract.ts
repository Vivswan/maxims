export type { SourceFrom } from "../state/schema.ts";

import type { SourceFrom } from "../state/schema.ts";

export type FetchOptions = {
  memoryPath: string;
  fullDepth: boolean;
  tempDir: string;
};

export type FetchResult = {
  sha: string;
  memoryPath: string;
  files: { relPath: string; text: string }[];
};

// `resolveRef` is optional because a local directory has no ref to resolve: its `fetch` hashes the
// tree and reports that as the sha, which is what lets change detection work identically for both.
export interface SourceResolver {
  resolveRef?(from: SourceFrom, pin?: string): Promise<string>;
  fetch(from: SourceFrom, opts: FetchOptions): Promise<FetchResult>;
}
