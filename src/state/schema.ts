import { z } from "zod";
import { type GitSha, parseGitSha } from "../contracts/git-sha.ts";
import { HarnessIdSchema } from "../contracts/harness-id.ts";
import { IsoTimestamp, LastErrorSchema } from "../contracts/last-error.ts";
import {
  AbsolutePathSchema,
  CopiedLocalFrom,
  DEFAULT_GIT_REF,
  LiveLocalFrom,
  RemoteFrom,
  type SourceFrom,
} from "../contracts/source.ts";
import {
  type ContentHash,
  type MemoryName,
  parseContentHash,
  parseMemoryName,
} from "../memory/contract.ts";
import { flattenIssues } from "../util/zod-issues.ts";

export const CURRENT_STATE_VERSION = 1;

export const MemoryNameSchema = z.custom<MemoryName>(
  (value) => typeof value === "string" && parseMemoryName(value) !== null,
  { error: "expected a kebab-case memory name" },
);

// State holds a sha in the minted form only: a hand edit in upper case is refused whole like an
// unsorted list below, never folded on the way in.
const GitShaSchema = z.custom<GitSha>(
  (value) => typeof value === "string" && parseGitSha(value) === value,
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
  auth: z.boolean(),
  harnesses: z.array(HarnessIdSchema),
  memoryPath: z.string().min(1),
  fullDepth: z.boolean(),
  paths: z.array(z.string().min(1)).optional(),
  // Set by `add --allow-hidden`, or by `install` replaying a lock entry carrying it. Absent means
  // `add` refuses a description with a hidden character. The check runs at `add` time only, never
  // on a refresh.
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

// The version is read before any shape judgment: the migration runner routes an older document
// by it and `parseState` refuses a newer one by it, so neither ever parses a shape it cannot know.
export function versionOf(json: unknown): number | null {
  if (typeof json !== "object" || json === null || !("version" in json)) return null;
  return typeof json.version === "number" && Number.isInteger(json.version) ? json.version : null;
}

// A version above the current one is a clean stop, never a parse attempt: an older binary cannot
// see the fields a newer one wrote, so a rewrite would destroy them. A version below the current
// one reaches here only if the migration runner did not intercept it, which is corruption.
export function parseState(json: unknown): ParsedState {
  const version = versionOf(json);
  if (version !== null && version > CURRENT_STATE_VERSION) return { ok: "newer", version };
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

export function emptyState(writtenBy: string): State {
  return { version: CURRENT_STATE_VERSION, writtenBy, sources: {} };
}
