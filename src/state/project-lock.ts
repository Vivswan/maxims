import { join, win32 } from "node:path";
import { z } from "zod";
import { flattenIssues } from "../util/zod-issues.ts";
import {
  canonicalSourceKey,
  DEFAULT_GIT_REF,
  DisabledNamesSchema,
  GithubRepoSchema,
  GitRefSchema,
  GitUrlSchema,
  HarnessIdSchema,
  HostnameSchema,
  markerSafe,
  RenameMapSchema,
  SelectSchema,
  type SourceFrom,
  sourceKeyIssues,
} from "./schema.ts";

export const PROJECT_LOCK_VERSION = 1;
/** @public */
export const PROJECT_LOCK_RELATIVE_PATH = join(".agents", "maxims.lock");

// The lock is committed with the project and read on every machine that checks it out, so a local
// source is named relative to the project root. The win32 grammar is the stricter judge and
// covers the posix one: a leading `/`, a drive (`C:/memories` and drive-relative `C:memories`)
// or a UNC share is one machine's path even when the machine writing the lock runs Linux.
const RelativePath = markerSafe(
  z
    .string()
    .min(1)
    .refine((value) => win32.parse(value).root === "", {
      message: "expected a path relative to the project",
    })
    .refine((value) => !value.includes("\0"), { message: "a path cannot contain NUL" }),
  "a path",
);

// The repository identity without a ref: the ref is the entry's `pin`, absent when the source
// tracks the default branch, so a tracking entry and a pinned one differ in exactly one field.
const LockGithubFrom = z.strictObject({
  type: z.literal("github"),
  repo: GithubRepoSchema,
  host: HostnameSchema.optional(),
});
const LockGitFrom = z.strictObject({ type: z.literal("git"), url: GitUrlSchema });
const LockLocalFrom = z.strictObject({
  type: z.literal("local"),
  path: RelativePath,
  live: z.literal(true).optional(),
});

// Intent only, and only what a project shares: no destination (always the project), no fetch
// facts and no timestamps, which belong to the machine that fetched.
const LockIntentFields = {
  select: SelectSchema,
  rename: RenameMapSchema.optional(),
  rule: z.boolean(),
  harnesses: z.array(HarnessIdSchema),
  paths: z.array(z.string().min(1)).optional(),
  auth: z.boolean().optional(),
  allowHidden: z.boolean().optional(),
};
// A local directory has no ref: its variant admits no `pin` value, in the type as in the parser.
const RemoteLockSource = z.strictObject({
  from: z.union([LockGithubFrom, LockGitFrom]),
  pin: GitRefSchema.optional(),
  ...LockIntentFields,
});
const LocalLockSource = z.strictObject({
  from: LockLocalFrom,
  pin: z.never().optional(),
  ...LockIntentFields,
});
export const LockSourceSchema = z.union([RemoteLockSource, LocalLockSource]);
export type LockSource = z.infer<typeof LockSourceSchema>;
type RemoteLockSource = z.infer<typeof RemoteLockSource>;

// The variants share every field but `pin`, so `from.type` is the one discriminant.
function isRemote(source: LockSource): source is RemoteLockSource {
  return source.from.type !== "local";
}

export const ProjectLockSchema = z
  .strictObject({
    version: z.literal(PROJECT_LOCK_VERSION),
    sources: z.record(z.string(), LockSourceSchema),
    // A committed copy of this project's list from state, for `install` on a fresh checkout; the
    // CLI writes it from state and never reads it back as the answer.
    disabled: DisabledNamesSchema.optional(),
  })
  .check((ctx) => {
    ctx.issues.push(
      ...sourceKeyIssues(
        Object.entries(ctx.value.sources).map(([key, source]) => [key, stateFrom(source)]),
      ),
    );
  });
export type ProjectLock = z.infer<typeof ProjectLockSchema>;

export type ParsedProjectLock =
  | { ok: "parsed"; lock: ProjectLock }
  | { ok: "corrupt"; issues: string[] };

export function parseProjectLock(text: string): ParsedProjectLock {
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch (error) {
    return { ok: "corrupt", issues: [error instanceof Error ? error.message : String(error)] };
  }
  const result = ProjectLockSchema.safeParse(json);
  if (result.success) return { ok: "parsed", lock: result.data };
  return { ok: "corrupt", issues: flattenIssues(result.error.issues) };
}

// The same key the state file uses for the source, so a lock entry and its state entry are found
// by one string; a local path stays relative here where the state's is absolute.
/** @public */
export function lockSourceKey(source: LockSource): string {
  return canonicalSourceKey(stateFrom(source));
}

function stateFrom(source: LockSource): SourceFrom {
  if (isRemote(source)) return { ...source.from, ref: source.pin ?? DEFAULT_GIT_REF };
  return { type: "local", path: source.from.path };
}

// Every level is rebuilt in one fixed field order with sorted keys, so the bytes depend only on
// the intent and a lock written by two machines from the same intent diffs empty.
export function serializeProjectLock(lock: ProjectLock): string {
  const sources: Record<string, unknown> = {};
  for (const key of Object.keys(lock.sources).sort()) {
    sources[key] = canonicalSource(lock.sources[key]);
  }
  const canonical: Record<string, unknown> = { version: lock.version, sources };
  if (lock.disabled !== undefined) canonical.disabled = lock.disabled;
  return `${JSON.stringify(canonical, null, 2)}\n`;
}

function canonicalSource(source: LockSource): Record<string, unknown> {
  const out: Record<string, unknown> = { from: canonicalFrom(source.from) };
  if (source.pin !== undefined) out.pin = source.pin;
  out.select = source.select;
  if (source.rename !== undefined) out.rename = sortedRecord(source.rename);
  out.rule = source.rule;
  out.harnesses = source.harnesses;
  if (source.paths !== undefined) out.paths = source.paths;
  if (source.auth !== undefined) out.auth = source.auth;
  if (source.allowHidden !== undefined) out.allowHidden = source.allowHidden;
  return out;
}

function canonicalFrom(from: LockSource["from"]): Record<string, unknown> {
  switch (from.type) {
    case "github":
      return from.host === undefined
        ? { type: from.type, repo: from.repo }
        : { type: from.type, repo: from.repo, host: from.host };
    case "git":
      return { type: from.type, url: from.url };
    case "local":
      return from.live === undefined
        ? { type: from.type, path: from.path }
        : { type: from.type, path: from.path, live: from.live };
  }
}

function sortedRecord(record: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const key of Object.keys(record).sort()) {
    out[key] = record[key];
  }
  return out;
}
