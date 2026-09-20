import { isAbsolute, resolve } from "node:path";
import { z } from "zod";
import { HARNESS_IDS } from "../harnesses/contract.ts";
import { type MemoryName, parseMemoryName } from "../memory/contract.ts";
import { ExitCode, MaximsError } from "../util/exit-codes.ts";

export const CURRENT_STATE_VERSION = 1;

// "HEAD" asks the source resolver for the remote's default branch head; `--pin` replaces it with a
// tag or sha. The default branch NAME is never stored because a repo can rename it without notice.
export const DEFAULT_GIT_REF = "HEAD";

// A repo segment of only dots would collapse the derived store path onto the store root itself.
const HOSTNAME = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*$/;
const GITHUB_REPO_PATTERN =
  /^[A-Za-z0-9](?:[A-Za-z0-9]|-(?=[A-Za-z0-9])){0,38}\/(?!\.{1,2}$)[A-Za-z0-9._-]+$/;

export const MemoryNameSchema = z.custom<MemoryName>(
  (value) => typeof value === "string" && parseMemoryName(value) !== null,
  { error: "expected a kebab-case memory name" },
);

// The rule-file renderer stamps a source's key and sha into a one-line HTML comment marker and
// treats "no terminator, no line break, no padding" as an invariant; the state boundary is where
// that invariant is made true, so every string that can reach a marker is refused here.
const MARKER_RULES: [(value: string) => boolean, string][] = [
  [(value) => !value.includes("-->"), "cannot contain -->"],
  [(value) => !/[\r\n]/.test(value), "cannot contain a line break"],
  [(value) => value === value.trim(), "cannot start or end with whitespace"],
];

function markerSafe<T extends z.ZodString>(schema: T, noun: string): T {
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
const AbsolutePath = markerSafe(
  z
    .string()
    .refine((value) => isAbsolute(value), { message: "expected an absolute path" })
    .refine((value) => !value.includes("\0"), { message: "a path cannot contain NUL" }),
  "a path",
);

const GitRef = markerSafe(z.string().min(1), "a ref");

declare const gitShaBrand: unique symbol;

// What a git remote reports as a commit id; a copied local source has no commit and records a
// content hash instead, so the two fetched shapes are split by source variant below and the two
// hash types are distinct brands, never one `string`.
export type GitSha = string & { readonly [gitShaBrand]: true };
const GIT_SHA_PATTERN = /^[0-9a-f]{40}$/;

// The one place a resolver's answer becomes a `GitSha`: what a remote reported is parsed here
// before it is written into state, so the state file never has to be read back to learn it.
export function parseGitSha(candidate: string): GitSha | null {
  return GIT_SHA_PATTERN.test(candidate) ? (candidate as GitSha) : null;
}

const GitShaSchema = z.custom<GitSha>(
  (value) => typeof value === "string" && parseGitSha(value) !== null,
  { error: "expected a 40-character lower-case hex sha" },
);

const IsoTimestamp = z.iso.datetime();

// Every object is strict: a hand-edited state file with a misspelled or foreign key is quarantined
// rather than half-obeyed, and a `-g` destination carrying an `-o` path has no way to parse.
// `host` is absent for github.com and set from `GH_HOST` otherwise, so a source recorded under an
// enterprise host is never re-expanded against github.com at sync time.
const GithubFrom = z.strictObject({
  type: z.literal("github"),
  repo: z.string().regex(GITHUB_REPO_PATTERN, "expected owner/repo"),
  ref: GitRef,
  host: z.string().regex(HOSTNAME, "expected a hostname").optional(),
});
// Any non-GitHub git remote (GitLab, Gitea, a mirror, an air-gapped proxy). The URL is stored as
// the user gave it and never rewritten, so a proxy path or an ssh alias survives round trips.
const GitFrom = z.strictObject({
  type: z.literal("git"),
  url: z.string().refine(isUsableRemote, { error: "expected a git remote URL" }),
  ref: GitRef,
});
const CopiedLocalFrom = z.strictObject({
  type: z.literal("local"),
  path: AbsolutePath,
  live: z.literal(false).optional(),
});
const LiveLocalFrom = z.strictObject({
  type: z.literal("local"),
  path: AbsolutePath,
  live: z.literal(true),
});
// A live source is split from the fetched sources at the schema level so that `SourceEntry` is a
// union in which the live variant has no `fetched` member at all; nothing has to check for it. The
// remote variants are split from the copied local one the same way, because only a remote has a
// commit sha to record.
const RemoteFrom = z.union([GithubFrom, GitFrom]);
export const SourceFromSchema = z.union([GithubFrom, GitFrom, CopiedLocalFrom, LiveLocalFrom]);
export type SourceFrom = z.infer<typeof SourceFromSchema>;

export const DestinationSchema = z.discriminatedUnion("scope", [
  z.strictObject({ scope: z.literal("global") }),
  z.strictObject({ scope: z.literal("project") }),
  z.strictObject({ scope: z.literal("out"), path: AbsolutePath }),
]);
/** @public */
export type Destination = z.infer<typeof DestinationSchema>;

export const SelectSchema = z.union([z.literal("*"), z.array(MemoryNameSchema)]);
/** @public */
export type Select = z.infer<typeof SelectSchema>;

export const RenameMapSchema = z.record(MemoryNameSchema, MemoryNameSchema);
/** @public */
export type RenameMap = z.infer<typeof RenameMapSchema>;

export const HarnessIdSchema = z.enum(HARNESS_IDS);

const IntentFields = {
  select: SelectSchema,
  rename: RenameMapSchema,
  rule: z.boolean(),
  destination: DestinationSchema,
  copy: z.boolean(),
  auth: z.boolean().default(false),
  harnesses: z.array(HarnessIdSchema),
  memoryPath: z.string().min(1).default("memories"),
  fullDepth: z.boolean().default(false),
  paths: z.array(z.string().min(1)).optional(),
};
const RemoteIntent = z.strictObject({ from: RemoteFrom, ...IntentFields });
const CopiedLocalIntent = z.strictObject({ from: CopiedLocalFrom, ...IntentFields });
const LiveIntent = z.strictObject({ from: LiveLocalFrom, ...IntentFields });
export const SourceIntentSchema = z.union([RemoteIntent, CopiedLocalIntent, LiveIntent]);
/** @public */
export type SourceIntent = z.infer<typeof SourceIntentSchema>;

export const LAST_ERROR_KINDS = ["network", "ratelimit", "missing", "auth", "invalid"] as const;

export const LastErrorSchema = z.strictObject({
  kind: z.enum(LAST_ERROR_KINDS),
  message: z.string(),
  retryAfter: IsoTimestamp.optional(),
  at: IsoTimestamp,
});
export type LastError = z.infer<typeof LastErrorSchema>;

const Sha256 = z.string().regex(/^sha256:[0-9a-f]{64}$/, "expected sha256:<hex>");

function fetchedSchema<S extends z.ZodType<string>>(sha: S) {
  return z.strictObject({
    at: IsoTimestamp,
    sha,
    memoryPath: z.string().min(1),
    memories: z.record(MemoryNameSchema, z.strictObject({ content: Sha256, description: Sha256 })),
    lastError: LastErrorSchema.nullable(),
  });
}
const RemoteFetched = fetchedSchema(GitShaSchema);
const CopiedLocalFetched = fetchedSchema(Sha256);
/** @public */
export type Fetched = z.infer<typeof RemoteFetched> | z.infer<typeof CopiedLocalFetched>;

export const SourceEntrySchema = z.union([
  z.strictObject({
    intent: RemoteIntent,
    fetched: RemoteFetched.optional(),
    addedAt: IsoTimestamp,
  }),
  z.strictObject({
    intent: CopiedLocalIntent,
    fetched: CopiedLocalFetched.optional(),
    addedAt: IsoTimestamp,
  }),
  z.strictObject({ intent: LiveIntent, addedAt: IsoTimestamp }),
]);
/** @public */
export type SourceEntry = z.infer<typeof SourceEntrySchema>;

export const StateSchema = z
  .strictObject({
    version: z.literal(CURRENT_STATE_VERSION),
    writtenBy: z.string().min(1),
    hooks: z.array(HarnessIdSchema),
    overrides: z.record(z.string(), z.unknown()).optional(),
    sources: z.record(z.string(), SourceEntrySchema),
  })
  // GitHub owner and repo names are case-insensitive and the store folds them, so two keys that
  // differ only in case would be one repository fetched twice into one directory; the key keeps
  // the case as typed, and the second spelling is refused like a mismatched key.
  .check((ctx) => {
    const seenFolded = new Map<string, string>();
    for (const [key, entry] of Object.entries(ctx.value.sources)) {
      const from = entry.intent.from;
      const expected = canonicalSourceKey(from);
      if (key !== expected) {
        ctx.issues.push({
          code: "custom",
          input: key,
          path: ["sources", key],
          message: `source key must be ${expected}`,
        });
      }
      if (from.type !== "github") continue;
      const folded = canonicalSourceKey({ ...from, repo: from.repo.toLowerCase() });
      const twin = seenFolded.get(folded);
      if (twin !== undefined) {
        ctx.issues.push({
          code: "custom",
          input: key,
          path: ["sources", key],
          message: `names the same GitHub repository as ${twin}`,
        });
      }
      seenFolded.set(folded, key);
    }
  });
export type State = z.infer<typeof StateSchema>;

export type ParsedState =
  | { ok: "parsed"; state: State }
  | { ok: "corrupt"; issues: string[] }
  | { ok: "newer"; version: number };

// A version above the current one is a clean stop, never a parse attempt: an older binary cannot
// see the fields a newer one wrote, so a rewrite would destroy them. A version below the current
// one reaches here only if the migration runner did not intercept it, which is corruption.
export function parseState(json: unknown): ParsedState {
  if (typeof json === "object" && json !== null && "version" in json) {
    const version = (json as { version: unknown }).version;
    if (
      typeof version === "number" &&
      Number.isInteger(version) &&
      version > CURRENT_STATE_VERSION
    ) {
      return { ok: "newer", version };
    }
  }
  const result = StateSchema.safeParse(json);
  if (result.success) return { ok: "parsed", state: result.data };
  return { ok: "corrupt", issues: flattenIssues(result.error.issues, []) };
}

// Union and record issues nest the branch that actually failed one level down; the flattened
// text names it so a quarantine notice can say which key was wrong rather than "invalid input".
function flattenIssues(issues: z.core.$ZodIssue[], prefix: PropertyKey[]): string[] {
  return issues.flatMap((issue) => {
    const path = [...prefix, ...issue.path];
    if (issue.code === "invalid_union" && issue.errors.length > 0) {
      return issue.errors.flatMap((branch) => flattenIssues(branch, path));
    }
    if (issue.code === "invalid_key" || issue.code === "invalid_element") {
      return flattenIssues(issue.issues, path);
    }
    const where = path.map(String).join(".");
    return [where === "" ? issue.message : `${where}: ${issue.message}`];
  });
}

// A pinned source is a different source from the tracking one: `@acme/rules` and `@acme/rules#v2`
// may both be installed, so the pin is part of the key. An enterprise host precedes the repo.
export function canonicalSourceKey(from: SourceFrom): string {
  switch (from.type) {
    case "github": {
      const base = from.host === undefined ? `@${from.repo}` : `@${from.host}/${from.repo}`;
      return withPin(base, from.ref);
    }
    case "git":
      return withPin(from.url, from.ref);
    case "local":
      return from.path;
  }
}

function withPin(base: string, ref: string): string {
  return ref === DEFAULT_GIT_REF ? base : `${base}#${ref}`;
}

const URL_SCHEME = /^([a-z][a-z0-9+.-]*):\/\//i;
const GIT_SCHEMES = new Set(["https", "http", "ssh", "git"]);
// scp-like `git@host:path`, which has no scheme; git also accepts an absolute path after the colon.
const SCP_LIKE = /^[\w.-]+@([\w.-]+):(.+)$/;

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
  const looksLocal = /^(\.{1,2}(\/|\\|$)|\/|\\|~|[A-Za-z]:[\\/])/.test(arg);
  if (!looksLocal && GITHUB_REPO_PATTERN.test(arg)) {
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

// A GitHub URL is judged by its owner/repo grammar alone; the segment after `tree` is a ref, not
// a directory, so the store-path usability check does not apply to it.
function fromRemote(arg: string, remote: GitRemote, options: SourceArgumentOptions): SourceFrom {
  const isGithubCom = remote.host === "github.com";
  if (!isGithubCom && remote.host !== options.ghHost?.toLowerCase()) {
    if (!isUsableRemote(arg)) throw usage(`${arg} has no usable repository path`);
    return { type: "git", url: arg, ref: DEFAULT_GIT_REF };
  }
  const host = isGithubCom ? undefined : enterpriseHost(options);
  const [owner, repoName, tree, ...rest] = remote.segments;
  const repo = `${owner ?? ""}/${stripGitSuffix(repoName ?? "")}`;
  const isTreeUrl = tree === "tree" && rest.length >= 1;
  if (
    !GITHUB_REPO_PATTERN.test(repo) ||
    (remote.segments.length > GITHUB_TREE_SEGMENT && !isTreeUrl)
  ) {
    throw usage(`${arg} is not a GitHub owner/repo URL`);
  }
  if (rest.length > 1) {
    throw usage(
      `${arg}: a tree URL with a path cannot tell a branch containing "/" from the path; use @${repo} with --pin and --from`,
    );
  }
  const ref = isTreeUrl ? (rest[0] ?? DEFAULT_GIT_REF) : DEFAULT_GIT_REF;
  return github(repo, arg, host, ref);
}

// github.com is the default and carries no host field, so `GH_HOST=github.com` is the same as
// leaving it unset and a source recorded on one machine reads the same on another.
function enterpriseHost(options: SourceArgumentOptions): string | undefined {
  const ghHost = options.ghHost?.toLowerCase();
  if (ghHost === undefined || ghHost === "github.com") return undefined;
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

function usage(message: string): MaximsError {
  return new MaximsError(ExitCode.Usage, message);
}

export function emptyState(writtenBy: string): State {
  return { version: CURRENT_STATE_VERSION, writtenBy, hooks: [], sources: {} };
}
