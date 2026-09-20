// A GitHub remote as the fetch ladder sees it with no `gh` and no git on the machine: the commits
// endpoint answers the ref, codeload answers the tarball, and a row rewrites either answer between
// two runs to put the ladder on the rung it wants.

import {
  httpResponse,
  networkError,
  type ScriptedRunner,
  scriptedRunner,
} from "../../../src/sources/github/fixtures/runner.ts";
import { buildTarball, type FixtureEntry } from "../../../src/sources/github/fixtures/tarballs.ts";
import { type FileSpec, memoryFile } from "./fixture-repo.ts";

export type GithubScript = {
  commits: () => Response | Promise<Response>;
  tarball: (sha: string) => Response | Promise<Response>;
};

const COMMITS_URL = /^https:\/\/api\.github\.com\/repos\/[^/]+\/[^/]+\/commits\//;
const TARBALL_URL = /^https:\/\/codeload\.github\.com\/[^/]+\/[^/]+\/tar\.gz\/([0-9a-f]{40})$/;

export function githubRunner(script: GithubScript): ScriptedRunner {
  return scriptedRunner({
    fetch: (url) => {
      if (COMMITS_URL.test(url)) return script.commits();
      const tarball = TARBALL_URL.exec(url);
      if (tarball?.[1] !== undefined) return script.tarball(tarball[1]);
      throw networkError();
    },
  });
}

export const SHA_ONE = "1".repeat(40);
export const SHA_TWO = "2".repeat(40);

export function shaResponse(sha: string): Response {
  return httpResponse(200, sha);
}

// GitHub wraps an archive in one `<owner>-<repo>-<sha7>/` folder, which the extractor drops.
export const TARBALL_TOP = "acme-rules-1111111";

export function memoriesTarball(files: Record<string, FileSpec>): Uint8Array {
  const entries: FixtureEntry[] = [
    { path: `${TARBALL_TOP}/`, type: "Directory" },
    { path: `${TARBALL_TOP}/README.md`, content: "# rules\n" },
    { path: `${TARBALL_TOP}/memories/`, type: "Directory" },
  ];
  for (const [name, spec] of Object.entries(files)) {
    const content = "raw" in spec ? spec.raw : memoryFile(name, spec);
    entries.push({ path: `${TARBALL_TOP}/memories/${name}.md`, content });
  }
  return buildTarball(entries);
}

export function healthyRemote(sha: string, files: Record<string, FileSpec>): GithubScript {
  const bytes = memoriesTarball(files);
  return {
    commits: () => shaResponse(sha),
    tarball: () => httpResponse(200, bytes),
  };
}
