import { isAbsolute, resolve } from "node:path";
import { z } from "zod";
import { HARNESS_IDS } from "../harnesses/contract.ts";
import { type MemoryName, parseMemoryName } from "../memory/contract.ts";
import { ExitCode, MaximsError } from "../util/exit-codes.ts";

export const CURRENT_STATE_VERSION = 1;

// "HEAD" asks the source resolver for the default branch's head; `--pin` replaces it with a tag or
// sha. The default branch NAME is never stored because a repo can rename it without notice.
export const DEFAULT_GITHUB_REF = "HEAD";

const GITHUB_REPO_PATTERN = /^[A-Za-z0-9](?:[A-Za-z0-9]|-(?=[A-Za-z0-9])){0,38}\/[A-Za-z0-9._-]+$/;

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
export const SourceFromSchema = z.discriminatedUnion("type", [
  z.strictObject({
    type: z.literal("github"),
    repo: z.string().regex(GITHUB_REPO_PATTERN, "expected owner/repo"),
    ref: z.string().min(1),
  }),
  z.strictObject({
    type: z.literal("local"),
    path: AbsolutePath,
    live: z.boolean().optional(),
  }),
]);
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

export const SourceIntentSchema = z.strictObject({
  from: SourceFromSchema,
  select: SelectSchema,
  rename: RenameMapSchema,
  rule: z.boolean(),
  destination: DestinationSchema,
  copy: z.boolean(),
  harnesses: z.array(HarnessIdSchema),
  memoryPath: z.string().min(1).default("memories"),
  fullDepth: z.boolean().default(false),
  paths: z.array(z.string().min(1)).optional(),
});
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

// A live local source has no fetch, so a `fetched` block on one is a shape error, not a stale
// cache to tolerate: the tree is its record.
export const SourceEntrySchema = z
  .strictObject({
    intent: SourceIntentSchema,
    fetched: FetchedSchema.optional(),
    addedAt: IsoTimestamp,
  })
  .check((ctx) => {
    const { from } = ctx.value.intent;
    if (from.type === "local" && from.live === true && ctx.value.fetched !== undefined) {
      ctx.issues.push({
        code: "custom",
        input: ctx.value,
        path: ["fetched"],
        message: "a live local source carries no fetched block",
      });
    }
  });
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
    if (typeof version === "number" && version > CURRENT_STATE_VERSION)
      return { ok: "newer", version };
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
    if (issue.code === "invalid_union") {
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
  return from.type === "github" ? `@${from.repo}` : from.path;
}

const GITHUB_URL = /^https:\/\/github\.com\/([^/\s]+)\/([^/\s]+?)(?:\.git)?\/?$/i;

// `owner/repo` with exactly one slash and no path prefix is a GitHub source, mirroring `skills`; a
// relative directory that happens to look like one is spelled `./owner/repo`.
export function parseSourceArgument(arg: string, cwd: string): SourceFrom {
  const trimmed = arg.trim();
  if (trimmed === "") throw usage("a source is required: @owner/repo or a local directory");
  const url = GITHUB_URL.exec(trimmed);
  if (url !== null) return github(`${url[1]}/${url[2]}`, trimmed);
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed)) {
    throw usage(
      `${trimmed} is not a github.com URL; only https://github.com/owner/repo is accepted`,
    );
  }
  if (trimmed.startsWith("@")) return github(trimmed.slice(1), trimmed);
  const looksLocal = /^(\.{1,2}(\/|\\|$)|\/|\\|~|[A-Za-z]:[\\/])/.test(trimmed);
  if (!looksLocal && GITHUB_REPO_PATTERN.test(trimmed)) return github(trimmed, trimmed);
  if (trimmed.startsWith("~")) throw usage(`cannot expand "~" in ${trimmed}; give the full path`);
  const path = resolve(cwd, trimmed);
  return trimmed === "." ? { type: "local", path, live: true } : { type: "local", path };
}

function github(repo: string, original: string): SourceFrom {
  if (!GITHUB_REPO_PATTERN.test(repo)) throw usage(`${original} is not a valid @owner/repo source`);
  return { type: "github", repo, ref: DEFAULT_GITHUB_REF };
}

function usage(message: string): MaximsError {
  return new MaximsError(ExitCode.Usage, message);
}

export function emptyState(writtenBy: string): State {
  return { version: CURRENT_STATE_VERSION, writtenBy, hooks: [], sources: {} };
}
