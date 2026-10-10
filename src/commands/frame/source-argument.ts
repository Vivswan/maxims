import { resolve } from "node:path";
import type { z } from "zod";
import {
  DEFAULT_GIT_REF,
  GITHUB_REPO_PATTERN,
  type GitRemote,
  HOSTNAME,
  isUsableRemote,
  parseRemote,
  SCP_LIKE,
  type SourceFrom,
  stripGitSuffix,
  URL_SCHEME,
} from "../../contracts/source.ts";
import { type MemoryName, parseMemoryName } from "../../memory/contract.ts";
import { DEFAULT_GH_HOST, normalizeGithubHost } from "../../sources/github/host.ts";
import { flattenIssues } from "../../util/zod-issues.ts";
import { usage } from "./options.ts";

export type SourceArgumentOptions = {
  ghHost?: string;
};

export type SourceSelector = {
  from: SourceFrom;
  memory: MemoryName | null;
};

// `owner/repo` with exactly one slash and no path prefix is a GitHub source, mirroring `skills`; a
// relative directory that happens to look like one is spelled `./owner/repo`. A URL is GitHub
// only when its HOST is github.com or `GH_HOST`: a mirror carrying "github.com" in its path
// stays a plain git source, stored verbatim. `GH_HOST` names the host for the shorthands and for
// URLs on that host; a github.com URL stays github.com whatever the shell exports, or one pasted
// command line would install a different source per machine. A `/tree/<ref>` GitHub URL pins
// that ref; a longer tail is refused rather than guessed, because `/tree/release/1.0` cannot be
// told from a branch `release` at path `1.0`.
export function parseSourceArgument(
  arg: string,
  cwd: string,
  options: SourceArgumentOptions = {},
): SourceFrom {
  const selector = parseSourceSelector(arg, cwd, options);
  if (selector.memory !== null) {
    throw usage(`${arg} names a single memory; this command takes a whole source (use --memory)`);
  }
  return selector.from;
}

// The `@owner/repo@memory-name` suffix selects one memory of a source; it applies only to the
// shorthand forms, where the trailing `@` is unambiguous (a URL's `@` belongs to its user part).
export function parseSourceSelector(
  arg: string,
  cwd: string,
  options: SourceArgumentOptions = {},
): SourceSelector {
  if (arg === "") throw usage("a source is required: @owner/repo, a git URL, or a local directory");
  const remote = parseRemote(arg);
  if (remote !== null) return { from: fromRemote(arg, remote, options), memory: null };
  if (URL_SCHEME.test(arg) || SCP_LIKE.test(arg)) {
    throw usage(
      `${arg} is not a usable git URL; https, http, ssh, git and git@host:path are accepted`,
    );
  }
  if (arg.startsWith("@")) {
    const shorthand = /^@([^@\s]+)(?:@([^@\s]+))?$/.exec(arg);
    if (shorthand === null) throw usage(`${arg} is not @owner/repo or @owner/repo@memory-name`);
    const [, repo = "", suffix] = shorthand;
    const memory = suffix === undefined ? null : parseMemoryName(suffix);
    if (suffix !== undefined && memory === null) {
      throw usage(`${arg}: "${suffix}" is not a kebab-case memory name`);
    }
    return { from: github(repo, arg, enterpriseHost(options)), memory };
  }
  if (GITHUB_REPO_PATTERN.test(arg)) {
    return { from: github(arg, arg, enterpriseHost(options)), memory: null };
  }
  if (arg.startsWith("~")) throw usage(`cannot expand "~" in ${arg}; give the full path`);
  const path = resolve(cwd, arg);
  return {
    from: arg === "." ? { type: "local", path, live: true } : { type: "local", path },
    memory: null,
  };
}

const GITHUB_TREE_SEGMENT = 2;

// The advice for a GitHub URL whose tail says more than a ref, keyed by the segment GitHub puts
// there. It names the flags that say the same thing and never an `@owner/repo` shorthand, which an
// enterprise shell would re-host under GH_HOST.
const TAIL_ADVICE = {
  tree: 'a tree URL with a path cannot tell a branch containing "/" from the path; drop the /tree/<ref>/... tail and pass --pin <ref> --from <path>',
  blob: "a blob URL names one file, and a source is a folder; drop the /blob/<ref>/<file> tail and pass --pin <ref> --from <folder> --memory <name>",
} as const;

// A GitHub URL is judged by its owner/repo grammar alone; the segment after `tree` is a ref, not
// a directory, so the store-path usability check does not apply to it, and whether it is storable
// is judged only once `add` knows whether a `--pin` replaces it.
function fromRemote(arg: string, remote: GitRemote, options: SourceArgumentOptions): SourceFrom {
  const remoteHost = normalizeGithubHost(remote.host);
  const isGithubCom = remoteHost === DEFAULT_GH_HOST;
  const ghHost = options.ghHost === undefined ? undefined : normalizeGithubHost(options.ghHost);
  if (!isGithubCom && remoteHost !== ghHost) {
    if (!isUsableRemote(arg)) throw usage(`${arg} has no usable repository path`);
    return { type: "git", url: arg, ref: DEFAULT_GIT_REF };
  }
  const host = isGithubCom ? undefined : enterpriseHost(options);
  const [owner, repoName, kind, ...rest] = remote.segments;
  const repo = `${owner ?? ""}/${stripGitSuffix(repoName ?? "")}`;
  const isTreeUrl = kind === "tree" && rest.length >= 1;
  const isBlobUrl = kind === "blob" && rest.length >= 2;
  if (
    !GITHUB_REPO_PATTERN.test(repo) ||
    (remote.segments.length > GITHUB_TREE_SEGMENT && !isTreeUrl && !isBlobUrl)
  ) {
    throw usage(`${arg} is not a GitHub owner/repo URL`);
  }
  if (isBlobUrl) throw usage(`${arg}: ${TAIL_ADVICE.blob}`);
  if (rest.length > 1) throw usage(`${arg}: ${TAIL_ADVICE.tree}`);
  const ref = isTreeUrl ? (rest[0] ?? DEFAULT_GIT_REF) : DEFAULT_GIT_REF;
  return github(repo, arg, host, ref);
}

// A field the state file stores is parsed by its own state schema at the door that mints its
// final value and refused as usage; written unchecked, it would be quarantined on the next read.
// The refused spelling is echoed escaped because the refused characters are the invisible ones.
// The grammar above judges neither field it mints: a local path is judged after it is resolved to
// its real path, where a symlink's own name no longer matters, and a `/tree/<ref>` ref once `add`
// knows whether a `--pin` replaces it.
export function storable<T>(schema: z.ZodType<T>, value: string, arg: string): T {
  const parsed = schema.safeParse(value);
  if (parsed.success) return parsed.data;
  throw usage(`${JSON.stringify(arg)}: ${flattenIssues(parsed.error.issues).join("; ")}`);
}

// github.com is the default and carries no host field, so `GH_HOST=github.com` is the same as
// leaving it unset and a source recorded on one machine reads the same on another.
function enterpriseHost(options: SourceArgumentOptions): string | undefined {
  if (options.ghHost === undefined) return undefined;
  const ghHost = normalizeGithubHost(options.ghHost);
  if (ghHost === DEFAULT_GH_HOST) return undefined;
  if (!HOSTNAME.test(ghHost)) throw usage(`GH_HOST "${ghHost}" is not a hostname`);
  return ghHost;
}

function github(
  repo: string,
  original: string,
  host: string | undefined,
  ref: string = DEFAULT_GIT_REF,
): SourceFrom {
  if (!GITHUB_REPO_PATTERN.test(repo)) throw usage(`${original} is not a valid @owner/repo source`);
  return host === undefined ? { type: "github", repo, ref } : { type: "github", repo, ref, host };
}
