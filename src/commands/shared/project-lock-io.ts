import { readFile } from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { z } from "zod";
import { HARNESS_IDS } from "../../harnesses/contract.ts";
import {
  canonicalSourceKey,
  DEFAULT_GIT_REF,
  MemoryNameSchema,
  RenameMapSchema,
  SelectSchema,
  type SourceFrom,
  type SourceIntent,
  type State,
} from "../../state/schema.ts";
import type { Change } from "../../util/change.ts";
import { assertInsideRoot } from "../../util/fs.ts";

export const PROJECT_LOCK_VERSION = 1;
export const PROJECT_LOCK_RELATIVE_PATH = join(".agents", "maxims.lock");

// The committed projection of a project's intent: the repository identity without a ref (the ref
// is `pin`, absent when tracking the default branch), the selection, renames, rule flag,
// harnesses and paths, and never a destination, a timestamp or a fetch fact. A local source is
// named relative to the project root because the file is read on every machine that clones it.
const LockGithubFrom = z.strictObject({
  type: z.literal("github"),
  repo: z.string().min(1),
  host: z.string().min(1).optional(),
});
const LockGitFrom = z.strictObject({ type: z.literal("git"), url: z.string().min(1) });
const LockLocalFrom = z.strictObject({
  type: z.literal("local"),
  path: z
    .string()
    .min(1)
    .refine((value) => !isAbsolute(value), {
      message: "expected a path relative to the project",
    }),
  live: z.literal(true).optional(),
});
const LockIntentFields = {
  select: SelectSchema,
  rename: RenameMapSchema.optional(),
  rule: z.boolean(),
  harnesses: z.array(z.enum(HARNESS_IDS)),
  paths: z.array(z.string().min(1)).optional(),
  auth: z.boolean().optional(),
  memoryPath: z.string().min(1).optional(),
  fullDepth: z.boolean().optional(),
  copy: z.boolean().optional(),
};
const LockSourceSchema = z.union([
  z.strictObject({
    from: z.union([LockGithubFrom, LockGitFrom]),
    pin: z.string().min(1).optional(),
    ...LockIntentFields,
  }),
  z.strictObject({ from: LockLocalFrom, pin: z.never().optional(), ...LockIntentFields }),
]);
export type LockSource = z.infer<typeof LockSourceSchema>;

export const ProjectLockSchema = z.strictObject({
  version: z.literal(PROJECT_LOCK_VERSION),
  sources: z.record(z.string(), LockSourceSchema),
  disabled: z.array(MemoryNameSchema).optional(),
});
export type ProjectLock = z.infer<typeof ProjectLockSchema>;

export type LoadedProjectLock =
  | { kind: "absent" }
  | { kind: "parsed"; lock: ProjectLock; keys: string[] }
  | { kind: "corrupt"; path: string; issues: string[] };

export function projectLockPath(projectRoot: string): string {
  return join(projectRoot, PROJECT_LOCK_RELATIVE_PATH);
}

// `keys` are the state keys the entries stand for, so a lock entry and its state entry are found
// by one string: a local path, relative in the lock, is made absolute against the project root.
export async function readProjectLock(projectRoot: string): Promise<LoadedProjectLock> {
  const path = projectLockPath(projectRoot);
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT")
      return { kind: "absent" };
    throw error;
  }
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    return { kind: "corrupt", path, issues: [`not valid JSON: ${detail}`] };
  }
  const result = ProjectLockSchema.safeParse(json);
  if (!result.success) {
    return {
      kind: "corrupt",
      path,
      issues: result.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`),
    };
  }
  const keys = Object.values(result.data.sources).map((source) =>
    canonicalSourceKey(stateFrom(source, projectRoot)),
  );
  return { kind: "parsed", lock: result.data, keys };
}

function stateFrom(source: LockSource, projectRoot: string): SourceFrom {
  if (source.from.type === "local") {
    const path = resolve(projectRoot, source.from.path);
    return source.from.live === true
      ? { type: "local", path, live: true }
      : { type: "local", path };
  }
  return { ...source.from, ref: source.pin ?? DEFAULT_GIT_REF };
}

// The projection of every project-scope source in state, or a deletion when none remains. A
// local source is keyed by its project-relative path, like its `from`, so two checkouts of the
// project write the same bytes.
export function projectLockChange(projectRoot: string, state: State): Change {
  const path = assertInsideRoot(projectRoot, projectLockPath(projectRoot));
  const sources: Record<string, LockSource> = {};
  for (const key of Object.keys(state.sources).sort()) {
    const entry = state.sources[key];
    if (entry === undefined || entry.intent.destination.scope !== "project") continue;
    const source = lockSource(entry.intent, projectRoot);
    const lockKey = source.from.type === "local" ? source.from.path : key;
    sources[lockKey] = source;
  }
  if (Object.keys(sources).length === 0) return { kind: "delete", path };
  return {
    kind: "write",
    path,
    content: serializeProjectLock({ version: PROJECT_LOCK_VERSION, sources }),
  };
}

function lockSource(intent: SourceIntent, projectRoot: string): LockSource {
  const fields = {
    select: intent.select,
    ...(Object.keys(intent.rename).length === 0 ? {} : { rename: sortedRecord(intent.rename) }),
    rule: intent.rule,
    harnesses: intent.harnesses,
    ...(intent.paths === undefined ? {} : { paths: intent.paths }),
    ...(intent.auth ? { auth: true } : {}),
    ...(intent.memoryPath === "memories" ? {} : { memoryPath: intent.memoryPath }),
    ...(intent.fullDepth ? { fullDepth: true } : {}),
    ...(intent.copy ? { copy: true } : {}),
  };
  const from = intent.from;
  if (from.type === "local") {
    const path = relativeToProject(projectRoot, from.path);
    return {
      from: from.live === true ? { type: "local", path, live: true } : { type: "local", path },
      ...fields,
    };
  }
  const pin = from.ref === DEFAULT_GIT_REF ? {} : { pin: from.ref };
  if (from.type === "github") {
    return {
      from:
        from.host === undefined
          ? { type: "github", repo: from.repo }
          : { type: "github", repo: from.repo, host: from.host },
      ...pin,
      ...fields,
    };
  }
  return { from: { type: "git", url: from.url }, ...pin, ...fields };
}

// A local source is spelled relative to the project, always starting with `./` or `../`, so its
// key cannot read like a GitHub key (`@owner/repo`) or a URL whatever the directory is called. A
// source outside the project has no spelling a clone could follow; the closest honest record is
// the relative path git would compute, which `install` resolves back.
function relativeToProject(projectRoot: string, path: string): string {
  const rel = relative(projectRoot, resolve(path)).split(sep).join("/");
  if (rel === "") return ".";
  return rel.startsWith("../") || rel === ".." ? rel : `./${rel}`;
}

function sortedRecord<T>(record: Record<string, T>): Record<string, T> {
  return Object.fromEntries(
    Object.entries(record).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)),
  );
}

// Fixed field order and sorted keys, so two machines writing the same intent diff empty.
export function serializeProjectLock(lock: ProjectLock): string {
  const canonical: Record<string, unknown> = {
    version: lock.version,
    sources: sortedRecord(lock.sources),
  };
  if (lock.disabled !== undefined) canonical.disabled = lock.disabled;
  return `${JSON.stringify(canonical, null, 2)}\n`;
}
