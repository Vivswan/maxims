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
const GITHUB_REPO_PATTERN =
  /^[A-Za-z0-9](?:[A-Za-z0-9]|-(?=[A-Za-z0-9])){0,38}\/(?!\.{1,2}$)[A-Za-z0-9._-]+$/;

export const MemoryNameSchema = z.custom<MemoryName>(
  (value) => typeof value === "string" && parseMemoryName(value) !== null,
  { error: "expected a kebab-case memory name" },
);

const AbsolutePath = z.string().refine((value) => isAbsolute(value), {
  message: "expected an absolute path",
});

const IsoTimestamp = z.iso.datetime();

// Every object is strict: a hand-edited state file with a misspelled or foreign key is quarantined
// rather than half-obeyed, and a `-g` destination carrying an `-o` path has no way to parse.
const GithubFrom = z.strictObject({
  type: z.literal("github"),
  repo: z.string().regex(GITHUB_REPO_PATTERN, "expected owner/repo"),
  ref: z.string().min(1),
});
// Any non-GitHub git remote (GitLab, Gitea, a mirror, an air-gapped proxy). The URL is stored as
// the user gave it and never rewritten, so a proxy path or an ssh alias survives round trips.
const GitFrom = z.strictObject({
  type: z.literal("git"),
  url: z.string().refine(isUsableRemote, { error: "expected a git remote URL" }),
  ref: z.string().min(1),
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
// union in which the live variant has no `fetched` member at all; nothing has to check for it.
const FetchedFrom = z.union([GithubFrom, GitFrom, CopiedLocalFrom]);
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
const FetchedIntent = z.strictObject({ from: FetchedFrom, ...IntentFields });
const LiveIntent = z.strictObject({ from: LiveLocalFrom, ...IntentFields });
export const SourceIntentSchema = z.union([FetchedIntent, LiveIntent]);
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

export const FetchedSchema = z.strictObject({
  at: IsoTimestamp,
  sha: z.string().min(1),
  memoryPath: z.string().min(1),
  memories: z.record(MemoryNameSchema, z.strictObject({ content: Sha256, description: Sha256 })),
  lastError: LastErrorSchema.nullable(),
});
/** @public */
export type Fetched = z.infer<typeof FetchedSchema>;

export const SourceEntrySchema = z.union([
  z.strictObject({
    intent: FetchedIntent,
    fetched: FetchedSchema.optional(),
    addedAt: IsoTimestamp,
  }),
  z.strictObject({ intent: LiveIntent, addedAt: IsoTimestamp }),
]);
/** @public */
export type SourceEntry = z.infer<typeof SourceEntrySchema>;

export const StateConfigSchema = z.strictObject({
  cooldownDays: z.number().int().positive().optional(),
  ruleCap: z.number().int().positive().optional(),
});

export const StateSchema = z
  .strictObject({
    version: z.literal(CURRENT_STATE_VERSION),
    writtenBy: z.string().min(1),
    hooks: z.array(HarnessIdSchema),
    config: StateConfigSchema.optional(),
    overrides: z.record(z.string(), z.unknown()).optional(),
    sources: z.record(z.string(), SourceEntrySchema),
  })
  .check((ctx) => {
    for (const [key, entry] of Object.entries(ctx.value.sources)) {
      const expected = canonicalSourceKey(entry.intent.from);
      if (key !== expected) {
        ctx.issues.push({
          code: "custom",
          input: key,
          path: ["sources", key],
          message: `source key must be ${expected}`,
        });
      }
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

export function canonicalSourceKey(from: SourceFrom): string {
  switch (from.type) {
    case "github":
      return `@${from.repo}`;
    case "git":
      return from.url;
    case "local":
      return from.path;
  }
}

const URL_SCHEME = /^([a-z][a-z0-9+.-]*):\/\//i;
const GIT_SCHEMES = new Set(["https", "http", "ssh", "git"]);
// scp-like `git@host:path`, which has no scheme; git also accepts an absolute path after the colon.
const SCP_LIKE = /^[\w.-]+@([\w.-]+):(.+)$/;

export type SourceArgumentOptions = {
  ghHost?: string;
};

// `owner/repo` with exactly one slash and no path prefix is a GitHub source, mirroring `skills`; a
// relative directory that happens to look like one is spelled `./owner/repo`. A URL is GitHub
// only when its HOST is github.com (or `GH_HOST`): a mirror carrying "github.com" in its path
// stays a plain git source, stored verbatim.
export function parseSourceArgument(
  arg: string,
  cwd: string,
  options: SourceArgumentOptions = {},
): SourceFrom {
  if (arg === "") throw usage("a source is required: @owner/repo, a git URL, or a local directory");
  const remote = parseRemote(arg);
  if (remote !== null) {
    const ghHost = (options.ghHost ?? "github.com").toLowerCase();
    if (!isUsableRemote(arg)) throw usage(`${arg} has no usable repository path`);
    if (remote.host === ghHost) {
      const repo = remote.segments.join("/");
      if (remote.segments.length !== 2 || !GITHUB_REPO_PATTERN.test(repo)) {
        throw usage(`${arg} is not a GitHub owner/repo URL`);
      }
      return { type: "github", repo, ref: DEFAULT_GIT_REF };
    }
    return { type: "git", url: arg, ref: DEFAULT_GIT_REF };
  }
  if (URL_SCHEME.test(arg) || SCP_LIKE.test(arg)) {
    throw usage(
      `${arg} is not a usable git URL; https, http, ssh, git and git@host:path are accepted`,
    );
  }
  if (arg.startsWith("@")) return github(arg.slice(1), arg);
  const looksLocal = /^(\.{1,2}(\/|\\|$)|\/|\\|~|[A-Za-z]:[\\/])/.test(arg);
  if (!looksLocal && GITHUB_REPO_PATTERN.test(arg)) return github(arg, arg);
  if (arg.startsWith("~")) throw usage(`cannot expand "~" in ${arg}; give the full path`);
  const path = resolve(cwd, arg);
  return arg === "." ? { type: "local", path, live: true } : { type: "local", path };
}

export type GitRemote = {
  host: string;
  segments: string[];
};

// The host is lower-cased and stripped of user and port. The path is kept as SEGMENTS, each
// decoded on its own with the trailing `.git` removed, so an encoded slash stays inside its
// segment where the usability check rejects it instead of splitting into two directories.
// `parseSourceArgument` and the store-path derivation both read a remote this way.
export function parseRemote(url: string): GitRemote | null {
  const scp = SCP_LIKE.exec(url);
  if (scp !== null && !URL_SCHEME.test(url)) {
    return { host: (scp[1] ?? "").toLowerCase(), segments: toSegments((scp[2] ?? "").split("/")) };
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
  return { host: parsed.hostname.toLowerCase(), segments };
}

function toSegments(raw: string[]): string[] {
  const segments = [...raw];
  while (segments.length > 0 && segments[0] === "") segments.shift();
  while (segments.length > 0 && segments[segments.length - 1] === "") segments.pop();
  const last = segments.length - 1;
  if (last >= 0) segments[last] = (segments[last] ?? "").replace(/\.git$/i, "");
  return segments;
}

// The store derives `_git/<host>/<path>` from a remote, so a remote is usable only when the host
// and every path segment are real directory names: no dot segments, no control characters, no
// separators. This is checked once here, at the source boundary.
const HOSTNAME = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*$/;
const SEGMENT_SEPARATORS = new Set(["/", "\\"]);

function isUnsafeSegment(segment: string): boolean {
  for (const char of segment) {
    const code = char.charCodeAt(0);
    if (code < 0x20 || code === 0x7f || SEGMENT_SEPARATORS.has(char)) return true;
  }
  return false;
}

export function isUsableRemote(url: string): boolean {
  const remote = parseRemote(url);
  if (remote === null || !HOSTNAME.test(remote.host) || remote.segments.length === 0) return false;
  return remote.segments.every(
    (segment) => segment !== "" && segment !== "." && segment !== ".." && !isUnsafeSegment(segment),
  );
}

function github(repo: string, original: string): SourceFrom {
  if (!GITHUB_REPO_PATTERN.test(repo)) throw usage(`${original} is not a valid @owner/repo source`);
  return { type: "github", repo, ref: DEFAULT_GIT_REF };
}

function usage(message: string): MaximsError {
  return new MaximsError(ExitCode.Usage, message);
}

export function emptyState(writtenBy: string): State {
  return { version: CURRENT_STATE_VERSION, writtenBy, hooks: [], sources: {} };
}
