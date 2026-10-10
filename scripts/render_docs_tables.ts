#!/usr/bin/env bun
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import type { FlagSpec } from "../src/commands/frame/options.ts";
import { LAST_ERROR_KINDS } from "../src/contracts/last-error.ts";
import { DEFAULT_GIT_REF } from "../src/contracts/source.ts";
import { DEFAULT_COOLDOWN_DAYS } from "../src/engine/context.ts";
import { hookSpecFor } from "../src/harnesses/contract.ts";
import { placeholderValues } from "../src/harnesses/from-spec.ts";
import { HARNESSES } from "../src/harnesses/registry.ts";
import { HOOK_PLACEHOLDERS, type HookPlaceholder } from "../src/harnesses/spec.ts";
import {
  MEMORY_NAME_MAX_LENGTH,
  MEMORY_NAME_PATTERN,
  MEMORY_TYPES,
} from "../src/memory/contract.ts";
import { DEFAULT_RULE_CAP } from "../src/rulefile/budget.ts";
import { type UserConfig, UserConfigSchema } from "../src/state/config.ts";
import { SourceIntentSchema } from "../src/state/schema.ts";
import { ExitCode } from "../src/util/exit-codes.ts";
import { parseArgv, type Refuser, usageRefuser } from "./lib/argv.ts";
import { renderMatrix } from "./lib/harness_matrix.ts";
import { markdownTable } from "./lib/markdown_table.ts";
import {
  claimedFlags,
  FLAG_ROWS,
  type FlagRow,
  maximsFlag,
  type UpstreamFlag,
  upstreamFlag,
} from "./lib/parity.ts";
import { regionBounds } from "./lib/region.ts";

const REGENERATE = "bun run docs:tables";

const code = (text: string): string => `\`${text}\``;
const codeList = (items: readonly string[]): string[] => items.map(code);
const or = new Intl.ListFormat("en", { type: "disjunction" });

const EXIT_MEANINGS: Record<ExitCode, string> = {
  [ExitCode.Ok]: "success, or nothing to do",
  [ExitCode.Usage]: "usage error, or a failed check",
  [ExitCode.SourceUnresolvable]: "source unresolvable",
  [ExitCode.NothingResolved]: "nothing resolved to install",
  [ExitCode.DestinationWriteFailed]: "destination write failed",
  [ExitCode.StoreLocked]: "store locked",
  [ExitCode.NameCollision]: "name collision",
  [ExitCode.UnmetDependency]: "unmet dependency",
  [ExitCode.RuleCapExceeded]: "rule cap exceeded",
};

function renderExitCodes(): string {
  const codes = Object.values(ExitCode)
    .filter((value): value is ExitCode => typeof value === "number")
    .sort((a, b) => a - b);
  return markdownTable(
    ["code", "meaning"],
    codes.map((exit) => [String(exit), EXIT_MEANINGS[exit]]),
  );
}

// A flag as the user types it on the command line: the short form where one exists, the value
// placeholder after it.
const typed = (flag: FlagSpec): string =>
  `${flag.short === undefined ? `--${flag.name}` : `-${flag.short}`}${flag.placeholder === undefined ? "" : ` ${flag.placeholder}`}`;

const CONFIG_ROWS: Record<keyof UserConfig, { standsFor: string; unset: string }> = {
  agents: { standsFor: code(typed(maximsFlag("agent"))), unset: "the detected harnesses" },
  yes: { standsFor: code(typed(maximsFlag("yes"))), unset: "prompt when interactive" },
  addHook: { standsFor: code(typed(maximsFlag("add-hook"))), unset: "off" },
  rule: { standsFor: code(typed(maximsFlag("rule"))), unset: "off" },
  cooldownDays: {
    standsFor: code(typed(maximsFlag("cooldown"))),
    unset: String(DEFAULT_COOLDOWN_DAYS),
  },
  ruleCap: { standsFor: code(typed(maximsFlag("cap"))), unset: String(DEFAULT_RULE_CAP) },
  lastAgents: {
    standsFor: "no flag; the harnesses the last interactive `add` selected",
    unset: "the detected harnesses",
  },
};

function renderConfigKeys(): string {
  const keys = Object.keys(UserConfigSchema.shape) as (keyof UserConfig)[];
  return markdownTable(
    ["key", "stands in for", "default when unset"],
    keys.map((key) => [code(key), CONFIG_ROWS[key].standsFor, CONFIG_ROWS[key].unset]),
  );
}

// `async` depends on the harness, so its cell is prose; every other placeholder renders the value
// a hook of the shipped command and timeout receives.
const PLACEHOLDER_PROSE: Record<HookPlaceholder, string | null> = {
  command: null,
  argv: null,
  async: "the hook's `async` flag, `true` or `false`",
  timeoutSeconds: null,
  timeoutMs: null,
};

function renderPlaceholders(): string {
  const values = placeholderValues(hookSpecFor({ hook: { kind: "none" } }));
  const shown = (name: HookPlaceholder): string => {
    const prose = PLACEHOLDER_PROSE[name];
    if (prose !== null) return prose;
    const value = values[name];
    return code(Array.isArray(value) ? JSON.stringify(value) : String(value));
  };
  return markdownTable(
    ["Placeholder", "Renders as"],
    HOOK_PLACEHOLDERS.map((name) => [code(`{{${name}}}`), shown(name)]),
  );
}

function renderMemoryContract(): string {
  const grammar = MEMORY_NAME_PATTERN.source.replace(/^\^/, "").replace(/\$$/, "");
  return markdownTable(
    ["field", "required", "rule"],
    [
      [
        code("name"),
        "yes",
        `kebab-case, ${code(grammar)}, at most ${MEMORY_NAME_MAX_LENGTH} characters, equal to the filename stem`,
      ],
      [
        code("description"),
        "yes",
        "non-empty, one line after YAML unquoting; this is the one-liner that reaches the rule file",
      ],
      [code("metadata.node_type"), "no", "`memory` when present; absent is accepted"],
      [
        code("metadata.type"),
        "no",
        `${or.format(codeList(MEMORY_TYPES))}; an unknown value passes with a warning`,
      ],
      [
        code("metadata.internal"),
        "no",
        "`true` hides the memory unless `MAXIMS_INSTALL_INTERNAL=1` is set; absent or `false` is normal",
      ],
      [`${code("metadata.scope")}, any other key`, "no", "carried in the store, never interpreted"],
      [
        "body",
        "no",
        "may be empty; `[[links]]` are preserved and resolved as dependencies (below)",
      ],
    ],
  );
}

// `fields` are the intent schema keys a bullet documents, claimed once across the list; empty
// for a top-level state field or a bullet elaborating the one above it.
const STATE_BULLETS: readonly { lead: string; fields: readonly string[]; text: string }[] = [
  {
    lead: code("version"),
    fields: [],
    text: "is the integer schema version, bumped on any breaking shape change.",
  },
  {
    lead: code("writtenBy"),
    fields: [],
    text: "says which maxims wrote this, so a bug report is reproducible without asking.",
  },
  {
    lead: code("hooks"),
    fields: [],
    text:
      "lists the harnesses where the user wants a sync hook kept, per scope: `global` is one " +
      "sorted list for the user scope, `project` one sorted list per project root, so " +
      "`add --add-hook` in one project says nothing about the user scope or another project. " +
      "A harness leaves a list with its last source at that scope. Lists, not records: whether " +
      "the hook is registered is read from the harness.",
  },
  {
    lead: code("overrides"),
    fields: [],
    text:
      "is reserved for the one hook fact that is intent, a config path the user chose over the " +
      "harness definition; accepted as an open record, and nothing writes or reads it yet.",
  },
  {
    lead: code("intent.from"),
    fields: ["from"],
    text:
      "is `github` with `repo`, `ref`, and `host` only when `GH_HOST` named an enterprise " +
      "instance at `add` time, so the source is never re-expanded against `github.com` later; " +
      "`git` with the remote `url` as you typed it and `ref`; or `local` with `path` and " +
      "optional `live`. A pinned local directory or a live fetched source cannot be written down.",
  },
  {
    lead: `${code("ref")} is ${code(DEFAULT_GIT_REF)}`,
    fields: [],
    text:
      "for the default branch's head; the branch name is never stored because a repo can " +
      "rename it.",
  },
  {
    lead: code("intent.auth"),
    fields: ["auth"],
    text:
      "is whether refreshes of this source use your `gh` login; set by `--auth`, false by " +
      "default, so an anonymous install never turns authenticated on its own.",
  },
  {
    lead: code("intent.select"),
    fields: ["select"],
    text: "is `*` or an explicit list; applied every sync, so a refresh can never widen the selection.",
  },
  {
    lead: code("intent.rename"),
    fields: ["rename"],
    text:
      "maps upstream name to local name; why it exists is not stored, `list` re-derives whether " +
      "it still resolves a live collision.",
  },
  {
    lead: code("intent.rule"),
    fields: ["rule"],
    text: "is whether this source publishes one-liners; the field that separates `--rule` from `--add-hook`.",
  },
  {
    lead: code("intent.destination"),
    fields: ["destination"],
    text:
      "is `global`; `project` with `root`, the realpath of the project, so `sync` and `list` " +
      "find a project's sources from state alone and a moved folder shows as a root that no " +
      "longer exists; or `out` with a `path`. A project entry without `root` is corrupt, and " +
      "`-g` with `-o` has no representation.",
  },
  {
    lead: codeList(["intent.copy", "intent.memoryPath", "intent.fullDepth", "intent.paths"]).join(
      ", ",
    ),
    fields: ["copy", "memoryPath", "fullDepth", "paths"],
    text: "record `--copy`, `--from`, `--full-depth`, `--paths` per source.",
  },
  {
    lead: code("intent.allowHidden"),
    fields: ["allowHidden"],
    text:
      "is `true` when `add --allow-hidden` was given, or when `install` replays a lock entry " +
      "carrying it, and otherwise absent. It is standing permission for descriptions with " +
      "[hidden characters](write-memories.md#hidden-characters-are-refused), which `add` " +
      `otherwise refuses with exit ${ExitCode.NothingResolved}; the check runs at \`add\` time only.`,
  },
  {
    lead: code("intent.harnesses"),
    fields: ["harnesses"],
    text: "is which harnesses this source writes to.",
  },
  {
    lead: code("intent.review"),
    fields: ["review"],
    text:
      "is `true` or absent, never `false`: set by `add --review` or `review`, so refreshes wait " +
      "for `accept` instead of applying. The " +
      "[review hold](keep-fresh.md#hold-changes-for-review) owns the verbs.",
  },
  {
    lead: code("intent.shared"),
    fields: ["shared"],
    text:
      "is `true` or absent: `true` marks a project source as projected into " +
      "`.agents/maxims.lock`, set by `add --share`, `share`, and `install`; on a `global` or " +
      "`out` destination it is corrupt. The [sharing section](share.md#sharing-a-source) owns " +
      "the verbs.",
  },
  {
    lead: `${code("fetched.at")} and ${code("fetched.sha")}`,
    fields: [],
    text:
      "drive the cooldown and staleness; the sha is what was fetched, where `ref` is what was " +
      "asked for. It is the 40-hex commit sha the remote reported for a GitHub or git source, " +
      "or a `sha256:<64 hex>` hash of the directory contents for a copied local source, spelled " +
      "like a memory hash. A live local source has no `fetched` block, because the tree is the " +
      "record.",
  },
  {
    lead: code("fetched.memories"),
    fields: [],
    text:
      "holds a content hash and a description hash per memory; a refresh diffs the content " +
      "hashes to report each memory added, removed, or changed.",
  },
  {
    lead: code("fetched.lastError"),
    fields: [],
    text:
      `is why the last fetch failed (${codeList(LAST_ERROR_KINDS).join(", ")}), so the ` +
      "staleness notice can say which.",
  },
  {
    lead: code("pending"),
    fields: [],
    text:
      "is the revision held for review: its `sha`, `at`, and `summary`, the diff against " +
      "`fetched.memories`. It is absent while nothing waits, and a live source never has one, " +
      "since its directory is read in place. A `pending` on a source without `intent.review`, " +
      "without a `fetched` block, or at the installed sha is corrupt.",
  },
  {
    lead: code("addedAt"),
    fields: [],
    text:
      "is provenance; there is no `updatedAt`. Every timestamp is ISO 8601 UTC in millisecond " +
      "form; a hand-edited spelling of another precision reads as the same instant in that form " +
      "and is written back so on the next write.",
  },
  {
    lead: code("disabled"),
    fields: [],
    text:
      "holds the memories `disable` withheld, by local name: `global` is one sorted list for " +
      "`-g`, `project` one sorted list per project root, so a memory disabled in one project " +
      "stays live everywhere else. The [project lock](share.md#the-project-manifest) carries a " +
      "copy of its own root's list.",
  },
];

function renderStateFields(): string {
  const schemaKeys = [
    ...new Set(SourceIntentSchema.options.flatMap((option) => Object.keys(option.shape))),
  ];
  const claimed = STATE_BULLETS.flatMap((bullet) => bullet.fields);
  const twice = claimed.filter((key, index) => claimed.indexOf(key) !== index);
  const missing = schemaKeys.filter((key) => !claimed.includes(key));
  const unknown = claimed.filter((key) => !schemaKeys.includes(key));
  if (twice.length + missing.length + unknown.length > 0) {
    throw new Error(
      `state bullets: claimed twice [${twice}], intent fields without a bullet [${missing}], not intent fields [${unknown}]`,
    );
  }
  return STATE_BULLETS.map((bullet) => `- **${bullet.lead}** ${bullet.text}`).join("\n");
}

// A flag as its help page spells it: `-g, --global`, `-m, --memory <names>`.
function spelled(short: string | null | undefined, long: string, placeholder?: string | null) {
  const forms = [...(short === null || short === undefined ? [] : [`-${short}`]), `--${long}`];
  return code(
    `${forms.join(", ")}${placeholder === null || placeholder === undefined ? "" : ` ${placeholder}`}`,
  );
}
const spellUpstream = (flag: UpstreamFlag) => spelled(flag.short, flag.long, flag.placeholder);
const spellMaxims = (flag: FlagSpec) => spelled(flag.short, flag.name, flag.placeholder);

function parityCells(row: FlagRow): string[] {
  switch (row.parity) {
    case "same":
      return [
        spellUpstream(upstreamFlag(row.flag)),
        spellMaxims(maximsFlag(row.flag)),
        row.parity,
        row.why,
      ];
    case "analog":
      return [
        spellUpstream(upstreamFlag(row.upstream)),
        spellMaxims(maximsFlag(row.maxims)),
        row.parity,
        row.why,
      ];
    case "diverge":
      return [
        row.upstream.map((long) => spellUpstream(upstreamFlag(long))).join(", "),
        "none",
        row.parity,
        row.why,
      ];
    case "maxims-only":
      return [
        "none",
        row.maxims.map((long) => spellMaxims(maximsFlag(long))).join(", "),
        row.parity,
        row.why,
      ];
  }
}

function renderParityFlags(): string {
  claimedFlags();
  return markdownTable(["npx skills", "maxims", "parity", "why"], FLAG_ROWS.map(parityCells));
}

type Region = { page: string; name: string; render: () => string };

export const REGIONS: readonly Region[] = [
  { page: "docs/harnesses.md", name: "harness-matrix", render: () => renderMatrix(HARNESSES) },
  { page: "docs/cli.md", name: "exit-codes", render: renderExitCodes },
  { page: "docs/files.md", name: "config-keys", render: renderConfigKeys },
  { page: "docs/adding-a-harness.md", name: "hook-placeholders", render: renderPlaceholders },
  { page: "docs/write-memories.md", name: "memory-contract", render: renderMemoryContract },
  { page: "docs/state.md", name: "state-fields", render: renderStateFields },
  { page: "docs/parity.md", name: "parity-flags", render: renderParityFlags },
];

// The region body is replaced whole, with a blank line on each side: a table glued to the marker
// comment renders as one HTML block, and the docs probe then no longer sees a generated region it
// should skip.
export function renderPage(text: string, regions: readonly Region[]): string {
  let page = text;
  for (const region of regions) {
    const body = region.render();
    const { bodyStart, bodyEnd } = regionBounds(page, region.name);
    page = `${page.slice(0, bodyStart)}\n\n${body}\n\n${page.slice(bodyEnd)}`;
  }
  return page;
}

const USAGE = "usage: bun scripts/render_docs_tables.ts [--check]";

function main(argv: readonly string[]): number {
  const refuse: Refuser = usageRefuser(USAGE);
  const { values } = parseArgv(
    { args: [...argv], options: { check: { type: "boolean", default: false } } },
    refuse,
  );
  const check = values.check;
  const pages = new Map<string, Region[]>();
  for (const region of REGIONS) pages.set(region.page, [...(pages.get(region.page) ?? []), region]);
  let stale = 0;
  for (const [page, regions] of pages) {
    const path = resolve(import.meta.dir, "..", page);
    const current = readFileSync(path, "utf8");
    const next = renderPage(current, regions);
    const names = regions.map((region) => region.name).join(", ");
    if (next === current) {
      process.stdout.write(`${page}: up to date (${names})\n`);
      continue;
    }
    if (check) {
      process.stderr.write(`${page}: differs from the code (${names}); run ${REGENERATE}\n`);
      stale += 1;
      continue;
    }
    writeFileSync(path, next);
    process.stdout.write(`${page}: rewritten (${names})\n`);
  }
  return stale === 0 ? 0 : 1;
}

if (import.meta.main) {
  try {
    process.exit(main(process.argv.slice(2)));
  } catch (error) {
    process.stderr.write(
      `render-docs-tables: ${error instanceof Error ? error.message : String(error)}\n`,
    );
    process.exit(2);
  }
}
