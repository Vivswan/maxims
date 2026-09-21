import { resolve } from "node:path";
import { z } from "zod";
import { HarnessIdSchema } from "../contracts/harness-id.ts";
import { IsoTimestamp, LastErrorSchema } from "../contracts/last-error.ts";
import {
  AbsolutePathSchema,
  CopiedLocalFrom,
  DEFAULT_GIT_REF,
  GITHUB_REPO_PATTERN,
  type GitRemote,
  HOSTNAME,
  isUsableRemote,
  LiveLocalFrom,
  parseRemote,
  RemoteFrom,
  SCP_LIKE,
  type SourceFrom,
  stripGitSuffix,
  URL_SCHEME,
} from "../contracts/source.ts";
import {
  type ContentHash,
  type MemoryName,
  parseContentHash,
  parseMemoryName,
} from "../memory/contract.ts";
import { ExitCode, MaximsError } from "../util/exit-codes.ts";
import { flattenIssues } from "../util/zod-issues.ts";

export const CURRENT_STATE_VERSION = 1;

export const MemoryNameSchema = z.custom<MemoryName>(
  (value) => typeof value === "string" && parseMemoryName(value) !== null,
  { error: "expected a kebab-case memory name" },
);

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

// A project destination carries the real path of the project root the source was added in, so an
// entry says which project it belongs to and a run acts only on the entries of the project it runs
// in. State holds one entry per source, so a source recorded for one project is refused elsewhere
// until it is removed there.
export const DestinationSchema = z.discriminatedUnion("scope", [
  z.strictObject({ scope: z.literal("global") }),
  z.strictObject({ scope: z.literal("project"), root: AbsolutePathSchema }),
  z.strictObject({ scope: z.literal("out"), path: AbsolutePathSchema }),
]);
/** @public */
export type Destination = z.infer<typeof DestinationSchema>;

export const SelectSchema = z.union([z.literal("*"), z.array(MemoryNameSchema)]);
/** @public */
export type Select = z.infer<typeof SelectSchema>;

export const RenameMapSchema = z.record(MemoryNameSchema, MemoryNameSchema);
/** @public */
export type RenameMap = z.infer<typeof RenameMapSchema>;

// A per-scope list is sorted and unique so the same intent always serializes to the same bytes;
// the writer sorts, and a hand edit that does not is refused whole like any other shape error.
function sortedUniqueList<T extends z.ZodType<string>>(item: T) {
  return z.array(item).check((ctx) => {
    const values: string[] = ctx.value;
    for (let index = 1; index < values.length; index += 1) {
      const previous = values[index - 1] ?? "";
      const current = values[index] ?? "";
      if (current > previous) continue;
      ctx.issues.push({
        code: "custom",
        input: current,
        path: [index],
        message: current === previous ? "listed twice" : `must be sorted after ${previous}`,
      });
    }
  });
}

// One list for the user scope and one per project root, the shape `disabled` and `hooks` share.
function scopedLists<L extends z.ZodType>(list: L) {
  return z.strictObject({
    global: list.optional(),
    project: z.record(AbsolutePathSchema, list).optional(),
  });
}

// Names the user has switched off.
export const DisabledNamesSchema = sortedUniqueList(MemoryNameSchema);

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
  // Set by `add --allow-hidden`; absent means the hidden-character check applies on every refresh.
  allowHidden: z.boolean().optional(),
  // Set by `add --share`, `share` and `install` on a project-scope entry: the project lock carries
  // the entry for teammates. Absent means private to this machine.
  shared: z.literal(true).optional(),
  // Set by `add --review` or `maxims review`: a refresh is fetched into `pending` and applied by
  // `maxims accept`. Absent means a refresh applies at once.
  review: z.literal(true).optional(),
};

// Sharing is a project-scope notion: a user-scope or `-o` entry has no lock to appear in, so the
// field is refused there rather than carried as dead weight.
function sharedOnlyAtProject(ctx: {
  value: { shared?: true; destination: { scope: string } };
  issues: z.core.$ZodRawIssue[];
}): void {
  if (ctx.value.shared === true && ctx.value.destination.scope !== "project") {
    ctx.issues.push({
      code: "custom",
      input: ctx.value.shared,
      path: ["shared"],
      message: "shared applies to a project destination",
    });
  }
}
const RemoteIntent = z
  .strictObject({ from: RemoteFrom, ...IntentFields })
  .check(sharedOnlyAtProject);
const CopiedLocalIntent = z
  .strictObject({ from: CopiedLocalFrom, ...IntentFields })
  .check(sharedOnlyAtProject);
const LiveIntent = z
  .strictObject({ from: LiveLocalFrom, ...IntentFields })
  .check(sharedOnlyAtProject);
export const SourceIntentSchema = z.union([RemoteIntent, CopiedLocalIntent, LiveIntent]);
/** @public */
export type SourceIntent = z.infer<typeof SourceIntentSchema>;

const ContentHashSchema = z.custom<ContentHash>(
  (value) => typeof value === "string" && parseContentHash(value) !== null,
  { error: "expected sha256:<hex>" },
);

function fetchedSchema<S extends z.ZodType<string>>(sha: S) {
  return z.strictObject({
    at: IsoTimestamp,
    sha,
    memoryPath: z.string().min(1),
    memories: z.record(
      MemoryNameSchema,
      z.strictObject({ content: ContentHashSchema, description: ContentHashSchema }),
    ),
    lastError: LastErrorSchema.nullable(),
  });
}
const RemoteFetched = fetchedSchema(GitShaSchema);
const CopiedLocalFetched = fetchedSchema(ContentHashSchema);
/** @public */
export type Fetched = z.infer<typeof RemoteFetched> | z.infer<typeof CopiedLocalFetched>;

// A reviewed source's refresh that is fetched and not yet applied: its files sit under the
// pending root, and `summary` is the memory diff against the last-good `fetched.memories`, so it
// is a fact about the source and not a copy of anything on disk. A live source has no fetch to
// hold, so its variant carries no `pending`.
function pendingSchema<S extends z.ZodType<string>>(sha: S) {
  return z.strictObject({ sha, at: IsoTimestamp, summary: z.array(z.string()) });
}
const RemotePending = pendingSchema(GitShaSchema);
const CopiedLocalPending = pendingSchema(ContentHashSchema);
/** @public */
export type Pending = z.infer<typeof RemotePending> | z.infer<typeof CopiedLocalPending>;

// A hold is what `review` makes of a refresh, parked behind the installed revision until `accept`
// lands it: without the mark no verb would ever apply it, without an installed revision there is
// nothing to keep behind, and at the installed sha there is nothing to land.
function pendingIsHeld(ctx: {
  value: { intent: { review?: true }; fetched?: { sha: string }; pending?: { sha: string } };
  issues: z.core.$ZodRawIssue[];
}): void {
  const { intent, fetched, pending } = ctx.value;
  if (pending === undefined) return;
  const refuse = (path: string[], message: string): void => {
    ctx.issues.push({ code: "custom", input: pending, path, message });
  };
  if (intent.review !== true)
    refuse(["pending"], "a held revision needs the source marked for review");
  if (fetched === undefined) {
    refuse(["pending"], "a held revision needs an installed revision behind it");
  } else if (pending.sha === fetched.sha) {
    refuse(["pending", "sha"], "the held revision is the installed one");
  }
}

export const SourceEntrySchema = z.union([
  z
    .strictObject({
      intent: RemoteIntent,
      fetched: RemoteFetched.optional(),
      pending: RemotePending.optional(),
      addedAt: IsoTimestamp,
    })
    .check(pendingIsHeld),
  z
    .strictObject({
      intent: CopiedLocalIntent,
      fetched: CopiedLocalFetched.optional(),
      pending: CopiedLocalPending.optional(),
      addedAt: IsoTimestamp,
    })
    .check(pendingIsHeld),
  z.strictObject({ intent: LiveIntent, addedAt: IsoTimestamp }),
]);
/** @public */
export type SourceEntry = z.infer<typeof SourceEntrySchema>;

// State owns the disabled names of BOTH scopes: the global list, and one list per project keyed
// by its root. A project's lock file carries a committed copy of its list for `install` to read,
// never the answer itself, so there is one place to change and nothing to reconcile.
const DisabledSchema = scopedLists(DisabledNamesSchema);
/** @public */
export type Disabled = z.infer<typeof DisabledSchema>;

// The harnesses whose session hook the user asked for, per scope: a project's `--add-hook` says
// nothing about the user scope and the other way round, so a project add without the flag can
// never inherit a hook from a global one.
const HooksSchema = scopedLists(sortedUniqueList(HarnessIdSchema));
/** @public */
export type Hooks = z.infer<typeof HooksSchema>;

export const StateSchema = z
  .strictObject({
    version: z.literal(CURRENT_STATE_VERSION),
    writtenBy: z.string().min(1),
    hooks: HooksSchema.optional(),
    overrides: z.record(z.string(), z.unknown()).optional(),
    sources: z.record(z.string(), SourceEntrySchema),
    disabled: DisabledSchema.optional(),
  })
  .check((ctx) => {
    ctx.issues.push(
      ...sourceKeyIssues(
        Object.entries(ctx.value.sources).map(([key, entry]) => [key, entry.intent.from]),
      ),
    );
  });
export type State = z.infer<typeof StateSchema>;

// Shared by every file that keys sources (state, project lock): a key must be the source's
// canonical key, and GitHub owner and repo names are case-insensitive and folded by the store, so
// two keys that differ only in case would be one repository fetched twice into one directory;
// the key keeps the case as typed, and the second spelling is refused like a mismatched key.
export function sourceKeyIssues(sources: [key: string, from: SourceFrom][]): z.core.$ZodRawIssue[] {
  const issues: z.core.$ZodRawIssue[] = [];
  const seenFolded = new Map<string, string>();
  for (const [key, from] of sources) {
    const expected = canonicalSourceKey(from);
    if (key !== expected) {
      issues.push({
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
      issues.push({
        code: "custom",
        input: key,
        path: ["sources", key],
        message: `names the same GitHub repository as ${twin}`,
      });
    }
    seenFolded.set(folded, key);
  }
  return issues;
}

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
  return { ok: "corrupt", issues: flattenIssues(result.error.issues) };
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
// a directory, so the store-path usability check does not apply to it, and whether it is storable
// is judged only once `add` knows whether a `--pin` replaces it.
function fromRemote(arg: string, remote: GitRemote, options: SourceArgumentOptions): SourceFrom {
  const remoteHost = normalizeGithubHost(remote.host);
  const isGithubCom = remoteHost === GITHUB_COM;
  const ghHost = options.ghHost === undefined ? undefined : normalizeGithubHost(options.ghHost);
  if (!isGithubCom && remoteHost !== ghHost) {
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
      `${arg}: a tree URL with a path cannot tell a branch containing "/" from the path; drop the /tree/<ref>/... tail and pass --pin <ref> --from <path>`,
    );
  }
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
  if (ghHost === GITHUB_COM) return undefined;
  if (!HOSTNAME.test(ghHost)) throw usage(`GH_HOST "${ghHost}" is not a hostname`);
  return ghHost;
}

const GITHUB_COM = "github.com";
const GITHUB_LOCALHOST = "github.localhost";
const TENANCY_SUFFIX = ".ghe.com";

// go-gh's NormalizeHostname, so a GH_HOST means to maxims what it means to gh. The recorded host
// is what the fetch ladder builds its API URL and picks its token from, so an alias must fold
// before it is recorded: `api.github.com` kept verbatim would offer the enterprise token and
// request `https://api.github.com/api/v3/...`; `api.octo.ghe.com` kept verbatim would request
// `api.api.octo.ghe.com`. A tenancy host keeps only its last label before the suffix.
function normalizeGithubHost(host: string): string {
  const hostname = host.toLowerCase();
  if (hostname.endsWith(`.${GITHUB_COM}`)) return GITHUB_COM;
  if (hostname.endsWith(`.${GITHUB_LOCALHOST}`)) return GITHUB_LOCALHOST;
  if (hostname.endsWith(TENANCY_SUFFIX)) {
    const before = hostname.slice(0, -TENANCY_SUFFIX.length);
    return `${before.slice(before.lastIndexOf(".") + 1)}${TENANCY_SUFFIX}`;
  }
  return hostname;
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

function usage(message: string): MaximsError {
  return new MaximsError(ExitCode.Usage, message);
}

export function emptyState(writtenBy: string): State {
  return { version: CURRENT_STATE_VERSION, writtenBy, sources: {} };
}
