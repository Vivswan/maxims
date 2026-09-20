import { join } from "node:path";
import type { SourceFrom } from "../../state/schema.ts";
import type { FetchOptions, FetchResult, SourceResolver } from "../contract.ts";
import { readMemoryTree, type WarnSink } from "../tree.ts";
import {
  createLadder,
  type Endpoints,
  GITHUB_ENDPOINTS,
  type RepoCoordinate,
  type Runner,
  systemRunner,
} from "./ladder.ts";

export type GithubSourceFrom = Extract<SourceFrom, { type: "github" }>;

export type GithubResolverOptions = {
  warn: WarnSink;
  runner?: Runner;
  endpoints?: Partial<Endpoints>;
};

export interface GithubResolver extends SourceResolver {
  resolveRef(from: SourceFrom, pin?: string): Promise<string>;
}

const FULL_SHA = /^[0-9a-f]{40}$/i;

// A ref that is already a full sha never touches the network, which is why a caller that has
// resolved a ref once should pass the sha back as `from.ref` when it fetches.
export function createGithubResolver(options: GithubResolverOptions): GithubResolver {
  const ladder = createLadder({
    runner: options.runner ?? systemRunner(),
    endpoints: { ...GITHUB_ENDPOINTS, ...options.endpoints },
    warn: options.warn,
  });
  const resolveRef = async (from: SourceFrom, pin?: string): Promise<string> => {
    const github = expectGithub(from);
    const ref = pin ?? github.ref;
    if (FULL_SHA.test(ref)) return ref.toLowerCase();
    return ladder.resolveRef(coordinate(github), ref);
  };
  return {
    resolveRef,
    async fetch(from: SourceFrom, opts: FetchOptions): Promise<FetchResult> {
      const github = expectGithub(from);
      const sha = await resolveRef(github);
      const treeDir = join(opts.tempDir, "tree");
      await ladder.fetchTree(coordinate(github), sha, treeDir);
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
  if (from.type !== "github") throw new Error(`the github resolver cannot fetch ${from.path}`);
  return from;
}
