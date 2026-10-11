import { isAbsolute, posix } from "node:path";
import { z } from "zod";
import {
  HARNESS_ID_PATTERN,
  type HarnessId,
  isBuiltInHarnessId,
  parseUserHarnessId,
  type UserHarnessId,
} from "../contracts/harness-id.ts";
import type { ExpansionSyntax, Markers } from "../rulefile/types.ts";
import type { JsonDialect } from "../util/jsonc.ts";
import { flattenIssues } from "../util/zod-issues.ts";
import type { ByteBudget, HookStdout, Scope, UnreadableLayer } from "./contract.ts";

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
const JsonDialectEnum = completeEnum<JsonDialect>()(["json", "json-with-comments", "jsonc"]);
const UnreadableLayerEnum = completeEnum<UnreadableLayer>()(["skips-the-file", "refuses-to-start"]);
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

// Every path in a spec is joined under a root the strategies assert against, and compared with
// other spec paths as text, so one spelling is admitted: segments joined by `/`, none empty, `.`
// or `..`. `hooks.json/` and `hooks.json` name one file, and the first spelling slipped past
// `refuseTomlLayerOnRegistry` to let the writer edit as JSON what the probe read as TOML. `.`
// alone names the root itself.
function relPathIssue(value: string): string | undefined {
  if (value === "") return "expected a relative path";
  if (isAbsolute(value) || value.startsWith("~"))
    return "expected a path relative to the scope root";
  if (value.includes("\0")) return "a path cannot contain NUL";
  if (value.includes("\\")) return "a path is spelled with / separators, never \\";
  if (value.split("/").includes("..")) return "a path cannot contain ..";
  const spelled = posix.join(value, ".");
  if (spelled !== value)
    return `a path has no leading, trailing or doubled / and no . segment; write ${spelled}`;
  return undefined;
}

const RelPath = z.string().check((ctx) => {
  const message = relPathIssue(ctx.value);
  if (message !== undefined) ctx.issues.push({ code: "custom", input: ctx.value, message });
});

// The global root may also be spelled with a leading `~/`; it is relative to HOME either way.
export function homeRelative(value: string): string {
  return value.startsWith("~/") ? value.slice("~/".length) : value;
}

const HomePath = z.string().refine((value) => RelPath.safeParse(homeRelative(value)).success, {
  error: "expected a path relative to HOME, with or without a leading ~/",
});

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

// `platforms` names where the vendor reads the variable, as `process.platform` spells them; left
// out, the variable is read everywhere.
const PlatformEnum = completeEnum<NodeJS.Platform>()([
  "aix",
  "android",
  "cygwin",
  "darwin",
  "freebsd",
  "haiku",
  "linux",
  "netbsd",
  "openbsd",
  "sunos",
  "win32",
]);

// `absoluteOnly` says the vendor's loader drops a relative value, as the XDG Base Directory spec
// requires of its variables, where a shell would resolve it against the working directory.
const RootVariable = z.strictObject({
  name: EnvName,
  absoluteOnly: z.literal(true).optional(),
});

// Variables the vendor tries in this order, the first one set (and absolute, where it says so)
// winning: Zed under Flatpak reads `FLATPAK_XDG_CONFIG_HOME` ahead of `XDG_CONFIG_HOME`.
const RootVariables = nonEmpty(RootVariable).check((ctx) => {
  const seen = new Set<string>();
  ctx.value.forEach((variable, index) => {
    if (seen.has(variable.name)) {
      ctx.issues.push({
        code: "custom",
        input: variable.name,
        path: [index, "name"],
        message: `${variable.name} is already listed`,
      });
    }
    seen.add(variable.name);
  });
});

// The list branch spells out `absoluteOnly` as never-present: a union's excess-property check lets
// an object literal carry any key some member declares, so without it a flag beside the list
// would compile and then be refused at parse time.
function rootEnv<P extends z.ZodType>(platforms: P) {
  const reading = { subdir: RelPath.optional(), platforms };
  return z.union([
    z.strictObject({ ...RootVariable.shape, ...reading }),
    z.strictObject({ name: RootVariables, absoluteOnly: z.never().optional(), ...reading }),
  ]);
}

const RootEnv = rootEnv(nonEmpty(PlatformEnum).optional());

export function rootVariables(entry: RootEnvSpec): readonly RootVariableSpec[] {
  if (Array.isArray(entry.name)) return entry.name;
  const absolute = "absoluteOnly" in entry && entry.absoluteOnly === true;
  return [{ name: entry.name, ...(absolute ? { absoluteOnly: true } : {}) }];
}

// No platform is read through two entries, so which entry a platform compiles to is never a
// matter of order.
const RootEnvList = nonEmpty(rootEnv(nonEmpty(PlatformEnum))).check((ctx) => {
  const readThrough = new Map<string, string>();
  ctx.value.forEach((entry, index) => {
    const names = rootVariables(entry)
      .map((variable) => variable.name)
      .join(", ");
    for (const platform of entry.platforms) {
      const earlier = readThrough.get(platform);
      if (earlier === undefined) {
        readThrough.set(platform, names);
        continue;
      }
      ctx.issues.push({
        code: "custom",
        input: entry.platforms,
        path: [index, "platforms"],
        message: `${platform} is already read through ${earlier}`,
      });
    }
  });
});

const GlobalRoot = z.strictObject({
  default: HomePath,
  env: z.union([RootEnv, RootEnvList]).optional(),
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

// zod drops a `__proto__` key from what it parses, so a check on that segment could never read it.
const KeyPath = z
  .string()
  .min(1)
  .refine((value) => !value.split(".").includes("__proto__"), {
    error: "a key segment cannot be __proto__",
  });
// A walked layer is the file as read in every directory from the session's up to the project root.
const WalkLayer = z.strictObject({ kind: z.literal("root-to-cwd"), file: RelPath });
const TierCheck = z.strictObject({
  // Per scope, in the harness's own precedence order; the walk takes project, then global.
  layers: z.strictObject({
    project: z.array(z.union([RelPath, WalkLayer])).min(1),
    global: z.array(RelPath).min(1),
  }),
  // Only a TOML layer names its dialect, a JSON layer reads in `hook.format`;
  // `refuseTomlLayerOnRegistry` keeps a TOML layer off the registry file.
  format: z
    .literal("toml", {
      error:
        "a tier check in a JSON dialect reads as hook.format and declares no format; remove tierCheck.format, or write toml for a TOML config",
    })
    .optional(),
  key: KeyPath,
  demotesWhen: z.json(),
  // The vendor's own behavior on a broken layer, which no file states.
  unreadable: UnreadableLayerEnum,
  // The user-layer table that marks a directory, the mark that trusts it and every mark the vendor
  // accepts, for a harness that applies a project layer only when trusted.
  projectTrust: z
    .strictObject({
      table: KeyPath,
      key: KeyPath,
      trusted: z.string().min(1),
      accepted: z.array(z.string().min(1)).min(1),
    })
    .refine((trust) => trust.accepted.includes(trust.trusted), {
      error: "the trusted mark is one of the accepted marks",
      path: ["trusted"],
    })
    .optional(),
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

type TierCheckSpec = z.infer<typeof TierCheck>;

const RegistryHook = z
  .strictObject({
    kind: z.literal("registry"),
    path: perScope(RelPath),
    // The dialect the vendor's parser takes: a construct outside it is refused, never written.
    format: z.enum(JsonDialectEnum.options, {
      error:
        "a registry hook is json, json-with-comments or jsonc, as the vendor's parser takes; toml is read for tierCheck and never written",
    }),
    eventPath: z.array(z.string().min(1)).min(1),
    grouped: z.boolean(),
    wrapper: Fields.optional(),
    handlerTemplate: Fields,
    commandKey: z.string().min(1),
    stdout: HookStdoutEnum,
    async: z.boolean(),
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
    refuseTomlLayerOnRegistry(ctx, ctx.value);
  });

// A TOML tier check is the one way a layer is parsed in another dialect than the registry, so the
// registry file itself is refused as a layer: the writer would edit it as JSON while the probe read
// the same bytes as TOML and called them unreadable. A walked layer is read in every directory up
// to the project root, so it reaches the registry whenever the registry path ends with its file.
// The comparison is textual because `RelPath` admits one spelling per path.
function refuseTomlLayerOnRegistry(
  ctx: { issues: z.core.$ZodRawIssue[] },
  hook: { path: { project: string; global: string }; format: string; tierCheck?: TierCheckSpec },
): void {
  if (hook.tierCheck?.format !== "toml") return;
  for (const scope of ["project", "global"] as const) {
    const registry = hook.path[scope];
    hook.tierCheck.layers[scope].forEach((layer, index) => {
      const reaches =
        typeof layer === "string"
          ? layer === registry
          : registry === layer.file || registry.endsWith(`/${layer.file}`);
      if (!reaches) return;
      ctx.issues.push({
        code: "custom",
        input: layer,
        path: ["tierCheck", "layers", scope, index],
        message: `a TOML tier check cannot read hook.path.${scope} (${hook.path[scope]}), the registry the writer edits as ${hook.format}; name the vendor's TOML config instead`,
      });
    });
  }
}

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
  // The dialect the vendor's parser takes, as for a registry hook: a servers file holding a
  // construct outside it is refused by name, never edited into a file the vendor would skip.
  format: z.enum(JsonDialectEnum.options, {
    error:
      "a servers file is json, json-with-comments or jsonc, as the vendor's parser takes; declare the dialect the vendor documents, or jsonc where it documents none",
  }),
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
// The root check runs before `RelPath` so a path that collapses to the root (`./`) is told it needs
// a file rather than told to write `.`.
const FilePath = z
  .string()
  .refine((value) => value.split("/").some((segment) => segment !== "" && segment !== "."), {
    error: "a repository path names a file, not the root",
  })
  .pipe(RelPath)
  .refine((value) => URL_SAFE.test(value), {
    error: "a repository path carries only letters, digits, and ._/-",
  });
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

type DeclaredFiles = {
  targets: Record<Scope, z.infer<typeof Target> | null>;
  hook: HookSpecData;
  mcp?: z.infer<typeof Mcp>;
};

// One owner per file at a scope: a shared rule file is edited as markdown, a registry and a
// servers file as JSON, so a path declared for two of them is a file two planners write over each
// other (the servers map replaced a rule file's block in one plan). The rule file is any the block
// may land in, the default or a precedence fallback that exists first. Compared as text because
// `RelPath` admits one spelling per path.
function requireOneOwnerPerFile(ctx: {
  value: DeclaredFiles;
  issues: z.core.$ZodRawIssue[];
}): void {
  const { targets, hook, mcp } = ctx.value;
  const refuse = (path: PropertyKey[], input: unknown, message: string) =>
    ctx.issues.push({ code: "custom", input, path, message });
  for (const scope of ["project", "global"] as const) {
    const target = targets[scope];
    const ruleFiles =
      target?.kind === "shared-block" ? [target.file, ...(target.precedence ?? [])] : [];
    const hookFile = hook.kind === "none" ? null : hook.path[scope];
    const servers = mcp?.path[scope] ?? null;
    if (hookFile !== null && ruleFiles.includes(hookFile)) {
      refuse(
        ["hook", "path", scope],
        hookFile,
        `${hookFile} is the rule file targets.${scope} writes a block into; declare the hook apart from it`,
      );
    }
    if (servers !== null && ruleFiles.includes(servers)) {
      refuse(
        ["mcp", "path", scope],
        servers,
        `${servers} is the rule file targets.${scope} writes a block into; declare the servers file apart from it`,
      );
    }
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
  .check(requireATarget)
  .check(requireOneOwnerPerFile);

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
  .check(requireATarget)
  .check(requireOneOwnerPerFile);

export type HarnessSpec = z.infer<typeof HarnessSpecSchema>;
export type UserHarnessSpec = z.infer<typeof UserHarnessSpecSchema>;
export type ScopedFrontmatterSpec = z.infer<typeof ScopedFrontmatter>;
export type FrontmatterSpec = z.infer<typeof Frontmatter>;
export type GlobalRootSpec = z.infer<typeof GlobalRoot>;
export type RootEnvSpec = z.infer<typeof RootEnv>;
export type RootVariableSpec = z.infer<typeof RootVariable>;
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
