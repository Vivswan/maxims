import { isAbsolute } from "node:path";
import { z } from "zod";

// "HEAD" asks the source resolver for the remote's default branch head; `--pin` replaces it with a
// tag or sha. The default branch NAME is never stored because a repo can rename it without notice.
export const DEFAULT_GIT_REF = "HEAD";

// A repo segment of only dots would collapse the derived store path onto the store root itself.
export const HOSTNAME = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*$/;
export const GITHUB_REPO_PATTERN =
  /^[A-Za-z0-9](?:[A-Za-z0-9]|-(?=[A-Za-z0-9])){0,38}\/(?!\.{1,2}$)[A-Za-z0-9._-]+$/;

// The rule-file renderer stamps a source's key and sha into a one-line HTML comment marker and
// treats "no terminator, no line break, no padding" as an invariant; the state boundary is where
// that invariant is made true, so every string that can reach a marker is refused here.
const MARKER_RULES: [(value: string) => boolean, string][] = [
  [(value) => !value.includes("-->"), "cannot contain -->"],
  [(value) => !/[\r\n]/.test(value), "cannot contain a line break"],
  [(value) => value === value.trim(), "cannot start or end with whitespace"],
];

export function markerSafe<T extends z.ZodString>(schema: T, noun: string): T {
  return MARKER_RULES.reduce(
    (current, [holds, message]) => current.refine(holds, { message: `${noun} ${message}` }),
    schema,
  );
}

function isMarkerSafe(value: string): boolean {
  return MARKER_RULES.every(([holds]) => holds(value));
}

// A NUL would reach the filesystem calls as ERR_INVALID_ARG_VALUE long after parsing, so the state
// boundary refuses it here with the other shape errors.
export const AbsolutePathSchema = markerSafe(
  z
    .string()
    .refine((value) => isAbsolute(value), { message: "expected an absolute path" })
    .refine((value) => !value.includes("\0"), { message: "a path cannot contain NUL" }),
  "a path",
);

export const GitRefSchema = markerSafe(z.string().min(1), "a ref");
export const GithubRepoSchema = z.string().regex(GITHUB_REPO_PATTERN, "expected owner/repo");
export const HostnameSchema = z.string().regex(HOSTNAME, "expected a hostname");
export const GitUrlSchema = z
  .string()
  .refine(isUsableRemote, { error: "expected a git remote URL" });

// Every object is strict: a hand-edited state file with a misspelled or foreign key is quarantined
// rather than half-obeyed, and a `-g` destination carrying an `-o` path has no way to parse.
// `host` is absent for github.com and set from `GH_HOST` otherwise, so a source recorded under an
// enterprise host is never re-expanded against github.com at sync time.
const GithubFrom = z.strictObject({
  type: z.literal("github"),
  repo: GithubRepoSchema,
  ref: GitRefSchema,
  host: HostnameSchema.optional(),
});
// Any non-GitHub git remote (GitLab, Gitea, a mirror, an air-gapped proxy). The URL is stored as
// the user gave it and never rewritten, so a proxy path or an ssh alias survives round trips.
const GitFrom = z.strictObject({
  type: z.literal("git"),
  url: GitUrlSchema,
  ref: GitRefSchema,
});
export const CopiedLocalFrom = z.strictObject({
  type: z.literal("local"),
  path: AbsolutePathSchema,
  live: z.literal(false).optional(),
});
export const LiveLocalFrom = z.strictObject({
  type: z.literal("local"),
  path: AbsolutePathSchema,
  live: z.literal(true),
});
// A live source is split from the fetched sources at the schema level so that `SourceEntry` is a
// union in which the live variant has no `fetched` member at all; nothing has to check for it. The
// remote variants are split from the copied local one the same way, because only a remote has a
// commit sha to record.
export const RemoteFrom = z.union([GithubFrom, GitFrom]);
export const SourceFromSchema = z.union([GithubFrom, GitFrom, CopiedLocalFrom, LiveLocalFrom]);
export type SourceFrom = z.infer<typeof SourceFromSchema>;

export const URL_SCHEME = /^([a-z][a-z0-9+.-]*):\/\//i;
const GIT_SCHEMES = new Set(["https", "http", "ssh", "git"]);
// scp-like `git@host:path`, which has no scheme; git also accepts an absolute path after the colon.
export const SCP_LIKE = /^[\w.-]+@([\w.-]+):(.+)$/;

export type GitRemote = {
  host: string;
  // The explicit port, or null when the URL names none; the URL parser already drops a default
  // http(s) port, and the scp-like form has no port syntax at all.
  port: string | null;
  segments: string[];
};

// The host is lower-cased and stripped of its user part. The path is kept as SEGMENTS, each
// decoded on its own and otherwise verbatim (`.git` included), so an encoded slash stays inside
// its segment where the usability check rejects it instead of splitting into two directories.
// `parseSourceArgument` and the store-path derivation both read a remote this way.
export function parseRemote(url: string): GitRemote | null {
  if (url.includes("#")) return null;
  const scp = SCP_LIKE.exec(url);
  if (scp !== null && !URL_SCHEME.test(url)) {
    return {
      host: (scp[1] ?? "").toLowerCase(),
      port: null,
      segments: toSegments((scp[2] ?? "").split("/")),
    };
  }
  const scheme = URL_SCHEME.exec(url)?.[1]?.toLowerCase();
  if (scheme === undefined || !GIT_SCHEMES.has(scheme)) return null;
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  let segments: string[];
  try {
    segments = toSegments(parsed.pathname.split("/").map(decodeURIComponent));
  } catch {
    return null;
  }
  if (parsed.hostname === "" || segments.length === 0) return null;
  return {
    host: parsed.hostname.toLowerCase(),
    port: parsed.port === "" ? null : parsed.port,
    segments,
  };
}

function toSegments(raw: string[]): string[] {
  const segments = [...raw];
  while (segments.length > 0 && segments[0] === "") segments.shift();
  while (segments.length > 0 && segments[segments.length - 1] === "") segments.pop();
  return segments;
}

// `.git` is stripped from the REPOSITORY segment only, never from a ref: `/tree/release.git` names
// a branch called release.git.
export function stripGitSuffix(segment: string): string {
  return segment.replace(/\.git$/i, "");
}

// The store derives `_git/<host>/<path>` from a remote, so a remote is usable only when the host
// and every path segment are real directory names: no dot segments, no control characters, no
// separators, and the repository segment must survive `.git` stripping. A `#` anywhere makes the
// URL unusable: a fragment means nothing to git, and the canonical key relies on the first `#`
// separating the URL from a pin. The URL is also the source key a rule-file marker carries, so it
// is held to the marker rule too; `new URL` would silently trim surrounding whitespace that the
// key would then keep. This is checked once here, at the source boundary.
// `/` and `\\` would split a segment; `@` and `#` are what the store suffix and the canonical
// key add for a pin, so a repository name may not carry them or a tracking source could forge a
// pinned one's identity.
const SEGMENT_SEPARATORS = new Set(["/", "\\", "@", "#"]);

function isUnsafeSegment(segment: string): boolean {
  for (const char of segment) {
    const code = char.charCodeAt(0);
    if (code < 0x20 || code === 0x7f || SEGMENT_SEPARATORS.has(char)) return true;
  }
  return false;
}

export function isUsableRemote(url: string): boolean {
  if (!isMarkerSafe(url)) return false;
  const remote = parseRemote(url);
  if (remote === null || !HOSTNAME.test(remote.host) || remote.segments.length === 0) return false;
  const last = remote.segments.length - 1;
  return remote.segments.every((segment, index) => {
    const bare = index === last ? stripGitSuffix(segment) : segment;
    return bare !== "" && bare !== "." && bare !== ".." && !isUnsafeSegment(segment);
  });
}
