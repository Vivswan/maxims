import { isAbsolute } from "node:path";
import { z } from "zod";
import {
  HARNESS_ID_PATTERN,
  type HarnessId,
  isBuiltInHarnessId,
  parseUserHarnessId,
  type UserHarnessId,
} from "../contracts/harness-id.ts";
import type { ExpansionSyntax, Markers } from "../rulefile/types.ts";
import { flattenIssues } from "../util/zod-issues.ts";
import type { ByteBudget, ConfigFormat, HookStdout } from "./contract.ts";

// The data half of a harness definition: everything `HarnessDefinition` holds that is a path, a
// name, a flag or a template, with the paths RELATIVE to the scope root (the project root, or the
// global root that `globalRoot` resolves); from-spec.ts joins them under that root whenever a
// path is resolved. Every object is strict, so a misspelled key is refused with its path rather
// than silently ignored.

const ENV_NAME = /^[A-Z_][A-Z0-9_]*$/;

// Values a template may splice in. A string value that is exactly one placeholder takes the
// placeholder's own JSON type (`"{{async}}"` becomes a boolean, `"{{timeoutMs}}"` a number);
// anywhere else the placeholder's text is spliced in, with `argv` as a JSON array.
export const HOOK_PLACEHOLDERS = [
  "command",
  "argv",
  "async",
  "timeoutSeconds",
  "timeoutMs",
] as const;
export type HookPlaceholder = (typeof HOOK_PLACEHOLDERS)[number];
const SLUG_PLACEHOLDER = "{{slug}}";

// `satisfies readonly T[]` refuses a stranger in the list but not a variant missing from it, and
// a missing variant makes the schema refuse a value the contract accepts. The rest parameter has
// a member only while a variant is missing, so the call then fails to compile.
function completeEnum<T extends string>() {
  return <const L extends readonly [T, ...T[]]>(
    list: L,
    ..._missing: [Exclude<T, L[number]>] extends [never] ? [] : [Exclude<T, L[number]>]
  ) => z.enum(list);
}

const MarkersEnum = completeEnum<Markers>()(["stripped", "counted"]);
const ExpansionEnum = completeEnum<ExpansionSyntax>()(["at-import", "none"]);
const ConfigFormatEnum = completeEnum<ConfigFormat>()(["json", "toml"]);
const HookStdoutEnum = completeEnum<HookStdout>()([
  "plain",
  "json:additionalContext",
  "json:hookSpecificOutput.additionalContext",
  "json:contextModification",
  "json:additional_context",
  "none",
]);

// Anything between double braces is a placeholder, so a misspelling like `{{timeout_ms}}` is
// refused as unknown rather than passed through into the written hook.
export function placeholderPattern(): RegExp {
  return /\{\{([^{}]*)\}\}/g;
}

export function placeholdersIn(text: string): string[] {
  return [...text.matchAll(placeholderPattern())].map((match) => match[1] ?? "");
}

function isHookPlaceholder(name: string): name is HookPlaceholder {
  return HOOK_PLACEHOLDERS.some((known) => known === name);
}

function unknownPlaceholders(text: string): string[] {
  return placeholdersIn(text).filter((name) => !isHookPlaceholder(name));
}

function stringsIn(value: unknown): string[] {
  if (typeof value === "string") return [value];
  if (Array.isArray(value)) return value.flatMap(stringsIn);
  if (typeof value === "object" && value !== null) return Object.values(value).flatMap(stringsIn);
  return [];
}

// Every path in a spec is joined under a root the strategies assert against, so a path that is
// absolute, climbs out, or carries a NUL is refused here with the other shape errors instead of
// failing at write time. `.` names the root itself.
const RelPath = z
  .string()
  .min(1, { error: "expected a relative path" })
  .refine((value) => !isAbsolute(value) && !value.startsWith("~"), {
    error: "expected a path relative to the scope root",
  })
  .refine((value) => !value.includes("\0"), { error: "a path cannot contain NUL" })
  .refine((value) => !value.split(/[\\/]/).includes(".."), { error: "a path cannot contain .." });

// The global root may also be spelled with a leading `~/`; it is relative to HOME either way.
const HomePath = z
  .string()
  .refine(
    (value) => RelPath.safeParse(value.startsWith("~/") ? value.slice("~/".length) : value).success,
    { error: "expected a path relative to HOME, with or without a leading ~/" },
  );

const EnvName = z.string().regex(ENV_NAME, { error: "expected an environment variable name" });
const FixtureName = z
  .string()
  .regex(/^[A-Za-z0-9._-]+$/, { error: "expected a file name inside fixtures/" });

const HarnessIdField = z.custom<HarnessId>(
  (value) => typeof value === "string" && HARNESS_ID_PATTERN.test(value),
  { error: "expected a kebab-case harness id" },
);

function perScope<T extends z.ZodType>(inner: T) {
  return z.strictObject({ project: inner, global: inner });
}

const Fields = z.record(z.string(), z.json());

// A path-scoped install puts the globs under `pathsKey`, as a YAML list or one comma-joined
// string, beside `fields`; a harness with no scoped form declares none and refuses `--paths`.
// Naming `pathsKey` inside `fields` with `null` fixes where the globs land among the other keys
// (Cursor lists `globs` before `alwaysApply`); left out, they land last.
const ScopedFrontmatter = z
  .strictObject({
    fields: Fields,
    pathsKey: z.string().min(1),
    pathsAs: z.enum(["list", "comma-list"]),
  })
  .check((ctx) => {
    const { fields, pathsKey } = ctx.value;
    if (Object.hasOwn(fields, pathsKey) && fields[pathsKey] !== null) {
      ctx.issues.push({
        code: "custom",
        input: fields[pathsKey],
        path: ["fields", pathsKey],
        message: "the paths key holds null where the paths go, or is left out",
      });
    }
  });

const Frontmatter = z.strictObject({
  always: Fields,
  scoped: ScopedFrontmatter.optional(),
});

const RulesDirTarget = z.strictObject({
  kind: z.literal("rules-dir"),
  dir: RelPath,
  fileName: z
    .string()
    .refine((value) => value.includes(SLUG_PLACEHOLDER), {
      error: `expected the file name to contain ${SLUG_PLACEHOLDER}`,
    })
    .refine((value) => placeholdersIn(value).every((name) => name === "slug"), {
      error: `a file name may only use ${SLUG_PLACEHOLDER}`,
    })
    .refine((value) => !value.includes("/") && !value.includes("\\"), {
      error: "a file name cannot contain a path separator",
    })
    .refine((value) => !value.includes("\0"), { error: "a file name cannot contain NUL" }),
  frontmatter: Frontmatter.optional(),
});

const SharedBlockTarget = z
  .strictObject({
    kind: z.literal("shared-block"),
    file: RelPath,
    precedence: z.array(RelPath).min(1).optional(),
    skipsEmpty: z.literal(true).optional(),
  })
  .check((ctx) => {
    const { file, precedence, skipsEmpty } = ctx.value;
    if (precedence !== undefined && !precedence.includes(file)) {
      ctx.issues.push({
        code: "custom",
        input: precedence,
        path: ["precedence"],
        message: `must include the default file ${file}`,
      });
    }
    if (skipsEmpty !== undefined && precedence === undefined) {
      ctx.issues.push({
        code: "custom",
        input: skipsEmpty,
        path: ["skipsEmpty"],
        message: "only a precedence list has empty files to skip",
      });
    }
  });

const Target = z.discriminatedUnion("kind", [RulesDirTarget, SharedBlockTarget]);

const GlobalRoot = z.strictObject({
  default: HomePath,
  env: z.strictObject({ name: EnvName, subdir: RelPath.optional() }).optional(),
});

// `dirs` are relative to the global root, `.` being the root itself.
const Detect = z
  .strictObject({
    dirs: z.array(RelPath),
    env: z.array(EnvName).optional(),
  })
  .check((ctx) => {
    if (ctx.value.dirs.length === 0 && (ctx.value.env ?? []).length === 0) {
      ctx.issues.push({
        code: "custom",
        input: ctx.value,
        path: ["dirs"],
        message: "detection needs at least one directory or environment variable",
      });
    }
  });

const TierCheck = z.strictObject({
  path: perScope(RelPath),
  format: ConfigFormatEnum,
  key: z.string().min(1),
  demotesWhen: z.json(),
});

function refuseUnknownPlaceholders(
  ctx: { issues: z.core.$ZodRawIssue[] },
  text: string,
  path: PropertyKey[],
): void {
  for (const name of unknownPlaceholders(text)) {
    ctx.issues.push({
      code: "custom",
      input: text,
      path,
      message: `unknown placeholder {{${name}}}; known: ${HOOK_PLACEHOLDERS.join(", ")}`,
    });
  }
}

const RegistryHook = z
  .strictObject({
    kind: z.literal("registry"),
    path: perScope(RelPath),
    format: z.literal("json", {
      error: "a registry hook is json; toml is read for tierCheck and never written",
    }),
    eventPath: z.array(z.string().min(1)).min(1),
    grouped: z.boolean(),
    wrapper: Fields.optional(),
    handlerTemplate: Fields,
    commandKey: z.string().min(1),
    stdout: HookStdoutEnum,
    async: z.boolean(),
    debounceMs: z.number().int().positive().optional(),
    tierCheck: TierCheck.optional(),
  })
  .check((ctx) => {
    const { handlerTemplate, commandKey } = ctx.value;
    const command = handlerTemplate[commandKey];
    // The writer finds and prunes its own handlers by the command's prefix, so a template that
    // puts a shell word before the placeholder would register a handler it can never see again.
    if (typeof command !== "string" || !command.startsWith("{{command}}")) {
      ctx.issues.push({
        code: "custom",
        input: command,
        path: ["handlerTemplate", commandKey],
        message: "the command key must hold a string starting with {{command}}",
      });
    }
    for (const text of stringsIn(handlerTemplate)) {
      refuseUnknownPlaceholders(ctx, text, ["handlerTemplate"]);
    }
  });

const FileHook = z
  .strictObject({
    kind: z.literal("file"),
    path: perScope(RelPath),
    contentTemplate: z.string().min(1),
    executable: z.boolean(),
    stdout: HookStdoutEnum,
  })
  .check((ctx) => {
    const text = ctx.value.contentTemplate;
    const names = placeholdersIn(text);
    if (!names.includes("command") && !names.includes("argv")) {
      ctx.issues.push({
        code: "custom",
        input: text,
        path: ["contentTemplate"],
        message: "the file must run the hook: use {{command}} or {{argv}}",
      });
    }
    refuseUnknownPlaceholders(ctx, text, ["contentTemplate"]);
  });

const Hook = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("none") }),
  RegistryHook,
  FileHook,
]);

const ByteCount = z.number().int().positive();

// A per-scope budget that names neither scope would parse as "no cap anywhere" and hide a typo;
// the spread re-types the scope each branch has just found present.
const PerScopeBudget = z
  .strictObject({ project: ByteCount.optional(), global: ByteCount.optional() })
  .transform((budget, ctx): Exclude<ByteBudget, number> => {
    if (budget.project !== undefined) return { ...budget, project: budget.project };
    if (budget.global !== undefined) return { ...budget, global: budget.global };
    ctx.addIssue({ code: "custom", message: "a per-scope budget names at least one scope" });
    return z.NEVER;
  });
const ByteBudgetField = z.union([ByteCount, PerScopeBudget]);

const Mcp = z.strictObject({
  path: perScope(RelPath.nullable()),
  serversPath: z.array(z.string().min(1)).min(1),
});

// A tuple with a rest element is non-empty by type, so a definition carries a first source, claim
// or pointer with no cast. An empty list is refused as a missing first element at index 0.
function nonEmpty<T extends z.ZodType>(inner: T) {
  return z.tuple([inner], inner);
}

// What the nightly drift check re-reads, so each entry is tested the way it is matched: a claim
// is matched after its whitespace runs collapse on both sides, so an edge space on a claim is
// noise an author would never see fail; a pointer without its leading slash would name nothing.
const Claim = z
  .string()
  .min(1, { error: "a claim is a non-empty phrase" })
  .refine((value) => value.trim() === value, {
    error: "a claim has no leading or trailing whitespace",
  });
const Claims = nonEmpty(Claim);
// RFC 6901: empty for the root, else `/`-led tokens whose only escapes are `~0` and `~1`. The
// token class excludes `/` so the two repetitions never overlap and the match stays linear.
const JsonPointer = z.string().regex(/^(?:\/(?:[^~/]|~[01])*)*$/, {
  error: "expected an RFC 6901 JSON pointer",
});
// A bare pointer must resolve; one paired with `equals` must resolve to that value. The value is
// a JSON primitive, compared with `!==`: jsonc-parser builds the document's objects with a null
// prototype, so a structural comparison against an object literal would never hold.
const JsonPrimitive = z.union([z.string(), z.number(), z.boolean(), z.null()]);
const PointerCheck = z.union([
  JsonPointer,
  z.strictObject({ pointer: JsonPointer, equals: JsonPrimitive }),
]);
// The repo, ref and path are spliced into a raw.githubusercontent.com URL, so a `#`, `?` or `%`
// in any of them would fetch a different file than the one named, and a `.` or `..` segment
// would be normalized away into another file's URL.
const URL_SAFE = /^[A-Za-z0-9._/-]+$/;
const plainSegments = (value: string): boolean =>
  value.split("/").every((segment) => !["", ".", ".."].includes(segment));
const Repo = z
  .string()
  .regex(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/, { error: "expected a GitHub owner/name" })
  .refine(plainSegments, { error: "a repo has no . or .. segment" });
const Ref = z
  .string()
  .regex(URL_SAFE, { error: "expected a branch, tag, or commit" })
  .refine(plainSegments, { error: "a ref has no empty, . or .. segment" });
const FilePath = RelPath.refine((value) => URL_SAFE.test(value), {
  error: "a repository path carries only letters, digits, and ._/-",
}).refine(plainSegments, { error: "a repository path has no empty or . segment" });
const Note = z.string().min(1).optional();

const VerifiedSourceField = z.discriminatedUnion("kind", [
  z.strictObject({
    kind: z.literal("schema"),
    url: z.url(),
    paths: nonEmpty(PointerCheck),
    note: Note,
  }),
  z.strictObject({
    kind: z.literal("file"),
    repo: Repo,
    ref: Ref,
    path: FilePath,
    claims: Claims,
    note: Note,
  }),
  z.strictObject({
    kind: z.literal("page"),
    url: z.url(),
    claims: Claims,
    why: z.string().refine((value) => value.trim() !== "", {
      error: "a page is the last resort: say what programmatic source was looked for",
    }),
    note: Note,
  }),
]);

const SPEC_SHAPE = {
  id: HarnessIdField,
  displayName: z.string().min(1),
  tier: z.literal([1, 2]),
  verifiedAgainst: z.strictObject({
    date: z.iso.date(),
    sources: nonEmpty(VerifiedSourceField),
  }),
  globalRoot: GlobalRoot.optional(),
  targets: perScope(Target.nullable()),
  bodiesDir: perScope(RelPath.nullable()),
  markers: MarkersEnum,
  expands: z.array(ExpansionEnum),
  byteBudget: ByteBudgetField.optional(),
  detect: Detect,
  hook: Hook,
  scopeFrontmatter: ScopedFrontmatter.optional(),
  mcp: Mcp.optional(),
};

// A harness with no target anywhere has nothing to install; the schema refuses it rather than
// letting a definition exist that every command skips.
function requireATarget(ctx: {
  value: { targets: { project: unknown; global: unknown } };
  issues: z.core.$ZodRawIssue[];
}): void {
  if (ctx.value.targets.project === null && ctx.value.targets.global === null) {
    ctx.issues.push({
      code: "custom",
      input: ctx.value.targets,
      path: ["targets"],
      message: "at least one scope needs a target",
    });
  }
}

// Fixtures name files under the built-in folder, so only a shipped spec may declare them.
export const HarnessSpecSchema = z
  .strictObject({
    ...SPEC_SHAPE,
    fixtures: z
      .strictObject({ config: FixtureName.optional(), hookStdin: FixtureName.optional() })
      .optional(),
  })
  .check(requireATarget);

// A user-defined id is minted by `parseUserHarnessId`, so a spec that parses cannot name a
// built-in harness; the message says which refusal it was, since both fail the same predicate.
const UserHarnessIdField = z.custom<UserHarnessId>(
  (value) => typeof value === "string" && parseUserHarnessId(value) !== null,
  {
    error: (issue) =>
      typeof issue.input === "string" && isBuiltInHarnessId(issue.input)
        ? `"${issue.input}" is a built-in harness id; pick another, built-in harnesses cannot be redefined`
        : "expected a kebab-case harness id",
  },
);
export const UserHarnessSpecSchema = z
  .strictObject({ ...SPEC_SHAPE, id: UserHarnessIdField })
  .check(requireATarget);

export type HarnessSpec = z.infer<typeof HarnessSpecSchema>;
export type UserHarnessSpec = z.infer<typeof UserHarnessSpecSchema>;
export type ScopedFrontmatterSpec = z.infer<typeof ScopedFrontmatter>;
export type FrontmatterSpec = z.infer<typeof Frontmatter>;
export type GlobalRootSpec = z.infer<typeof GlobalRoot>;
export type TargetSpec = z.infer<typeof Target>;
export type HookSpecData = z.infer<typeof Hook>;

export type ParsedHarnessSpec<Spec extends HarnessSpec = HarnessSpec> =
  | { ok: true; spec: Spec }
  | { ok: false; issues: string[] };

export function parseHarnessSpec(json: unknown): ParsedHarnessSpec;
export function parseHarnessSpec(
  json: unknown,
  schema: typeof UserHarnessSpecSchema,
): ParsedHarnessSpec<UserHarnessSpec>;
export function parseHarnessSpec(
  json: unknown,
  schema: typeof HarnessSpecSchema | typeof UserHarnessSpecSchema = HarnessSpecSchema,
): ParsedHarnessSpec {
  const result = schema.safeParse(json);
  if (result.success) return { ok: true, spec: result.data };
  return { ok: false, issues: flattenIssues(result.error.issues) };
}
