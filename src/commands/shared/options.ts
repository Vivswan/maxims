import { resolve } from "node:path";
import { type ParseArgsConfig, parseArgs } from "node:util";
import type { Console } from "../../console/contract.ts";
import { invalidAgents, STRINGS } from "../../console/strings.ts";
import type { HarnessId } from "../../harnesses/contract.ts";
import { type MemoryName, parseMemoryName } from "../../memory/contract.ts";
import type { UserConfig } from "../../state/config.ts";
import type { Destination, RenameMap, Select } from "../../state/schema.ts";
import { ExitCode, MaximsError } from "../../util/exit-codes.ts";
import type { CliIo, CommonOptions, Engine, HarnessFilter } from "../types.ts";

export type FlagSpec = {
  name: string;
  short?: string;
  kind: "boolean" | "value" | "list";
  placeholder?: string;
  summary: string;
};

export type GlobalFlags = {
  quiet: boolean;
  dryRun: boolean;
  json: boolean;
  verbose: boolean;
};

// Flags every verb accepts. `--help` and `--version` are not here: they are recognized on the raw
// argv before any verb loads, so they need no table.
export const GLOBAL_FLAGS: readonly FlagSpec[] = [
  { name: "quiet", kind: "boolean", summary: "one line of output and fail-soft (the hook's mode)" },
  { name: "dry-run", kind: "boolean", summary: "print the plan and write nothing" },
  { name: "json", kind: "boolean", summary: "emit one JSON document instead of the frame" },
  { name: "verbose", kind: "boolean", summary: "add fetch details to the output" },
];

export const FLAGS = {
  global: { name: "global", short: "g", kind: "boolean", summary: "the user scope" },
  project: { name: "project", short: "p", kind: "boolean", summary: "the project scope" },
  out: {
    name: "out",
    short: "o",
    kind: "value",
    placeholder: "<dir>",
    summary: "an explicit output folder instead of a scope",
  },
  memory: {
    name: "memory",
    short: "m",
    kind: "list",
    placeholder: "<names>",
    summary: "only these memories (comma list, repeatable, * for all)",
  },
  agent: {
    name: "agent",
    short: "a",
    kind: "list",
    placeholder: "<ids>",
    summary: "target harnesses (comma list, repeatable, * for all)",
  },
  list: { name: "list", short: "l", kind: "boolean", summary: "preview the source, write nothing" },
  yes: { name: "yes", short: "y", kind: "boolean", summary: "skip the confirmation prompt" },
  all: { name: "all", kind: "boolean", summary: "every memory, every harness, no prompt" },
  rule: { name: "rule", kind: "boolean", summary: "publish one-liners into the rule file" },
  addHook: { name: "add-hook", kind: "boolean", summary: "register the harness's sync hook" },
  copy: { name: "copy", kind: "boolean", summary: "copy bodies instead of linking them" },
  from: {
    name: "from",
    kind: "value",
    placeholder: "<path>",
    summary: "the folder in the source holding memories",
  },
  fullDepth: { name: "full-depth", kind: "boolean", summary: "scan the whole source" },
  link: {
    name: "link",
    kind: "boolean",
    summary: "local sources: link the store to the directory",
  },
  share: {
    name: "share",
    kind: "boolean",
    summary: "project scope: also record the source in .agents/maxims.lock for teammates",
  },
  pin: { name: "pin", kind: "value", placeholder: "<sha or tag>", summary: "track this ref" },
  paths: {
    name: "paths",
    kind: "list",
    placeholder: "<glob>",
    summary: "scope the rules to matching files (repeatable)",
  },
  auth: { name: "auth", kind: "boolean", summary: "fetch with your gh login" },
  rename: {
    name: "rename",
    kind: "list",
    placeholder: "<upstream>=<local>",
    summary: "resolve a name collision (repeatable)",
  },
  allowHidden: {
    name: "allow-hidden",
    kind: "boolean",
    summary: "accept descriptions carrying hidden characters",
  },
  review: { name: "review", kind: "boolean", summary: "hold upstream changes until maxims accept" },
  cooldown: {
    name: "cooldown",
    kind: "value",
    placeholder: "<days>",
    summary: "days between refreshes, saved to config.json",
  },
  cap: {
    name: "cap",
    kind: "value",
    placeholder: "<n>",
    summary: "most rule lines per source, saved to config.json",
  },
  noFetch: { name: "no-fetch", kind: "boolean", summary: "never touch the network" },
  strict: {
    name: "strict",
    kind: "boolean",
    summary: "refuse a source whose descriptions carry a risky shape",
  },
  expect: {
    name: "expect",
    kind: "list",
    placeholder: "<name or @owner/repo/name>",
    summary: "assert this memory has a rule line (repeatable)",
  },
} as const satisfies Record<string, FlagSpec>;

// What `add` records for a source when no flag says otherwise; the project manifest omits an
// intent field that equals its default, and `install` fills it back in.
export const INTENT_DEFAULTS = { memoryPath: "memories", fullDepth: false, copy: false } as const;

export type Args = {
  positionals: string[];
  flag(spec: FlagSpec): boolean;
  value(spec: FlagSpec): string | undefined;
  list(spec: FlagSpec): string[];
};

export type OpenConsole = (yes: boolean) => Promise<Console>;

export type CommandContext = {
  io: CliIo;
  engine: Engine;
  global: GlobalFlags;
  config: UserConfig;
  openConsole: OpenConsole;
};

// A verb's body; its name, aliases and visibility live in the dispatch table that loads it.
export type Command = {
  summary: string;
  usage: string;
  flags: readonly FlagSpec[];
  // The most positional words the verb reads; one more is a usage error, never a silent drop.
  arity: number;
  run(args: Args, ctx: CommandContext): Promise<number>;
};

// One parse per invocation, strict: an option the verb's table does not name is a usage error,
// as it is for `skills`. Comma lists and repetition compose, and `--flag=value` equals
// `--flag value`, both handled by `parseArgs` rather than here.
export function parseVerbArgs(argv: readonly string[], flags: readonly FlagSpec[]): Args {
  const options: NonNullable<ParseArgsConfig["options"]> = {};
  for (const spec of [...GLOBAL_FLAGS, ...flags]) {
    options[spec.name] = {
      type: spec.kind === "boolean" ? "boolean" : "string",
      multiple: spec.kind === "list",
      ...(spec.short === undefined ? {} : { short: spec.short }),
    };
  }
  let parsed: ReturnType<typeof parseArgs>;
  try {
    parsed = parseArgs({ args: [...argv], options, strict: true, allowPositionals: true });
  } catch (error) {
    throw usage(parseArgsMessage(error));
  }
  const values = parsed.values as Record<string, string | boolean | string[] | undefined>;
  const listOf = (name: string): string[] => {
    const value = values[name];
    if (!Array.isArray(value)) return [];
    return value
      .flatMap((item) => item.split(","))
      .map((item) => item.trim())
      .filter((item) => item !== "");
  };
  // A value that was typed but holds nothing (`--from ''`, `-m ' , '`) is refused here rather than
  // read as "not given", which would silently widen a selection or blank a path.
  for (const spec of flags) {
    const value = values[spec.name];
    if (value === undefined) continue;
    const empty = spec.kind === "list" ? listOf(spec.name).length === 0 : value === "";
    if (empty) throw usage(`option --${spec.name} needs a value`);
  }
  return {
    positionals: parsed.positionals,
    flag: (spec) => values[spec.name] === true,
    value: (spec) => {
      const value = values[spec.name];
      return typeof value === "string" ? value : undefined;
    },
    list: (spec) => listOf(spec.name),
  };
}

function parseArgsMessage(error: unknown): string {
  const code = (error as { code?: string }).code;
  const message = error instanceof Error ? error.message : String(error);
  if (code === "ERR_PARSE_ARGS_UNKNOWN_OPTION") {
    const match = /Unknown option '([^']+)'/.exec(message);
    return `unknown option: ${match?.[1] ?? message}`;
  }
  if (code === "ERR_PARSE_ARGS_INVALID_OPTION_VALUE") {
    const match = /Option '([^']+)' argument missing/.exec(message);
    if (match !== null) return `option ${match[1]} needs a value`;
  }
  return message;
}

// The engine's options never carry `--verbose`: it shapes the frame, not the work.
export function commonOptions(global: GlobalFlags): CommonOptions {
  return { quiet: global.quiet, dryRun: global.dryRun, json: global.json };
}

export function globalFlags(args: Args): GlobalFlags {
  const [quiet, dryRun, json, verbose] = GLOBAL_FLAGS;
  return {
    quiet: quiet !== undefined && args.flag(quiet),
    dryRun: dryRun !== undefined && args.flag(dryRun),
    json: json !== undefined && args.flag(json),
    verbose: verbose !== undefined && args.flag(verbose),
  };
}

// `-g`, `-p` and `-o` parse into ONE destination; two of them is a usage error here, once, and no
// downstream type can hold the conflict. Null means "auto": the verb decides from the source and
// the project root. An `-o` path is resolved against the cwd here, so every consumer holds the
// absolute path the state schema requires, and `-p` carries the project root it names, so it is
// refused here, once, when there is none.
export function parseDestination(
  args: Args,
  cwd: string,
  projectRoot: string | null,
): Destination | null {
  const out = args.value(FLAGS.out);
  const named = [args.flag(FLAGS.global), args.flag(FLAGS.project), out !== undefined].filter(
    (given) => given,
  );
  if (named.length > 1) throw usage(STRINGS.twoDestinations);
  if (args.flag(FLAGS.global)) return { scope: "global" };
  if (args.flag(FLAGS.project)) return projectDestination(projectRoot);
  if (out !== undefined) return { scope: "out", path: resolve(cwd, out) };
  return null;
}

export function projectDestination(projectRoot: string | null): Destination {
  if (projectRoot === null) {
    throw usage("a project-scoped change needs a project root", {
      hint: "run inside a git checkout, or pass -g for the user scope",
    });
  }
  return { scope: "project", root: projectRoot };
}

// `*` is the whole source; a list is parsed into memory names so a name that is not one fails
// here rather than at the source. `--all` with a list of names is refused, as `skills` refuses it.
export function parseSelect(args: Args): Select | null {
  const names = args.list(FLAGS.memory);
  const all = args.flag(FLAGS.all);
  if (names.length === 0) return all ? "*" : null;
  if (names.includes("*")) {
    if (all || names.length > 1) throw usage(STRINGS.allWithNames);
    return "*";
  }
  if (all) throw usage(STRINGS.allWithNames);
  return [...new Set(names)].map(memoryNameOrUsage);
}

export function memoryNameOrUsage(candidate: string): MemoryName {
  const name = parseMemoryName(candidate);
  if (name === null) throw usage(`"${candidate}" is not a kebab-case memory name`);
  return name;
}

export type AgentSelection = { kind: "all" } | { kind: "ids"; ids: HarnessId[] } | { kind: "auto" };

// `known` is the registry loaded for this run: the built-in ids plus any the user declared, so a
// declared harness is a valid `-a` value and an undeclared one gets the did-you-mean.
export function parseAgents(args: Args, known: readonly HarnessId[]): AgentSelection {
  const raw = args.list(FLAGS.agent);
  if (args.flag(FLAGS.all) && raw.length === 0) return { kind: "all" };
  if (raw.length === 0) return { kind: "auto" };
  if (raw.includes("*")) return { kind: "all" };
  return { kind: "ids", ids: harnessIdsOrUsage(raw, known) };
}

// The one constructor of a sync restriction: an empty list becomes "no restriction", and the
// caller spreads the result so an absent filter is an absent key, not `agents: undefined`.
export function agentsFilter(ids: readonly HarnessId[]): { agents?: HarnessFilter } {
  const [first, ...rest] = ids;
  return first === undefined ? {} : { agents: [first, ...rest] };
}

export function harnessIdsOrUsage<Id extends string>(
  raw: readonly string[],
  known: readonly Id[],
): Id[] {
  const ids: Id[] = [];
  const invalid: string[] = [];
  for (const candidate of raw) {
    const id = known.find((k) => k === candidate);
    if (id === undefined) invalid.push(candidate);
    else if (!ids.includes(id)) ids.push(id);
  }
  if (invalid.length > 0) {
    const closest = closestHarnessId(invalid[0] ?? "", known);
    throw usage(invalidAgents(invalid, known, closest));
  }
  return ids;
}

// Did-you-mean over the harness ids: the closest by edit distance, offered only when it is close
// enough to be a typo rather than a different word.
export function closestHarnessId<Id extends string>(
  candidate: string,
  known: readonly Id[],
): Id | null {
  let best: { id: Id; distance: number } | null = null;
  for (const id of known) {
    const distance = editDistance(candidate.toLowerCase(), id);
    if (best === null || distance < best.distance) best = { id, distance };
  }
  if (best === null || best.distance > Math.max(2, Math.floor(candidate.length / 3))) return null;
  return best.id;
}

function editDistance(a: string, b: string): number {
  let previous = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const current = [i];
    for (let j = 1; j <= b.length; j++) {
      const substitution = (previous[j - 1] ?? 0) + (a[i - 1] === b[j - 1] ? 0 : 1);
      current[j] = Math.min((previous[j] ?? 0) + 1, (current[j - 1] ?? 0) + 1, substitution);
    }
    previous = current;
  }
  return previous[b.length] ?? 0;
}

export function parseRenames(args: Args): RenameMap {
  const rename: RenameMap = {};
  for (const pair of args.list(FLAGS.rename)) {
    const separator = pair.indexOf("=");
    if (separator <= 0 || separator === pair.length - 1) {
      throw usage(`--rename expects <upstream>=<local>, got "${pair}"`);
    }
    const upstream = memoryNameOrUsage(pair.slice(0, separator));
    const local = memoryNameOrUsage(pair.slice(separator + 1));
    rename[upstream] = local;
  }
  return rename;
}

// The two bounds config.json holds, shared by the flags and `config set` so the two spellings of
// one key agree: a cooldown of 0 refetches every sync, while a cap of 0 would refuse every source.
export const INTEGER = {
  positive: { pattern: /^[1-9][0-9]*$/, expects: "a positive integer" },
  nonNegative: { pattern: /^(0|[1-9][0-9]*)$/, expects: "a non-negative integer" },
} as const;
export type IntegerBound = (typeof INTEGER)[keyof typeof INTEGER];

// `what` names the spelling in the refusal: `--cooldown` or `cooldownDays`.
export function integerOrUsage(raw: string, bound: IntegerBound, what: string): number {
  if (!bound.pattern.test(raw) || !Number.isSafeInteger(Number(raw))) {
    throw usage(`${what} expects ${bound.expects}, got "${raw}"`);
  }
  return Number(raw);
}

export function parseInteger(spec: FlagSpec, bound: IntegerBound, args: Args): number | undefined {
  const raw = args.value(spec);
  return raw === undefined ? undefined : integerOrUsage(raw, bound, `--${spec.name}`);
}

export function parsePositiveInt(spec: FlagSpec, args: Args): number | undefined {
  return parseInteger(spec, INTEGER.positive, args);
}

export function usage(message: string, options: { hint?: string } = {}): MaximsError {
  return new MaximsError(ExitCode.Usage, message, options);
}
