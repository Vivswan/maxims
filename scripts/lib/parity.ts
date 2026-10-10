// The parity decisions between maxims and `npx skills`, and the upstream page they are judged
// against: tests/fixtures/golden/skills-help.txt, captured from skills@1.7.2. tests/parity.test.ts
// pins the maxims flags against the fixture by these decisions, and render_docs_tables.ts renders
// the flag table on docs/parity.md from them, so the test and the page cannot disagree.
import { readFileSync } from "node:fs";
import { FLAGS, type FlagSpec, GLOBAL_FLAGS } from "../../src/commands/frame/options.ts";
import { FIXTURE_PATH } from "../nightly/parity_drift.ts";

export const FIXTURE = readFileSync(FIXTURE_PATH, "utf8");

type Kind = FlagSpec["kind"];
export type UpstreamFlag = {
  long: string;
  short: string | null;
  kind: Kind;
  placeholder: string | null;
};
export type UpstreamVerb = { verb: string; aliases: string[] };

// A flag row is two spaces, the flag in either order (`-g, --global` or `--help, -h`), an optional
// `<placeholder>`, then at least two spaces before its summary. A verb row is two spaces and a
// lower-case word; continuation lines are indented deeper and example lines start with `$ skills`.
const FLAG_LINE = /^ {2}(?:-([a-zA-Z]), )?--([a-z][a-z-]*)(?:, -([a-zA-Z]))?(?: (<[^>]+>))? {2,}\S/;
const VERB_LINE = /^ {2}([a-z][a-z_]*)(?:, ([a-z]+))?(?: |$)(.*)$/;
const ALIAS_NOTE = /\(alias: ([a-z]+)\)/;
const EXAMPLE_LINE = /^ {2}\$ skills ([a-z_]+)/;

// The page marks a list-valued flag only by a plural placeholder (`<agents>`, `<skills>`); a
// scalar one is singular (`<json>`, `<owner>`). `use` takes one skill and one agent where `add`
// takes lists, so a flag repeated across verbs keeps the widest shape the page documents.
function kindOf(placeholder: string | undefined): Kind {
  if (placeholder === undefined) return "boolean";
  return placeholder.endsWith("s>") ? "list" : "value";
}

const KIND_WIDTH: Record<Kind, number> = { boolean: 0, value: 1, list: 2 };

export type Upstream = {
  flags: Map<string, UpstreamFlag>;
  verbs: Map<string, UpstreamVerb>;
  exampleWords: Set<string>;
};

export function parseUpstream(page: string): Upstream {
  const flags = new Map<string, UpstreamFlag>();
  const verbs = new Map<string, UpstreamVerb>();
  const exampleWords = new Set<string>();
  for (const line of page.split("\n")) {
    const flag = FLAG_LINE.exec(line);
    if (flag !== null) {
      const [, shortBefore, long = "", shortAfter, placeholder] = flag;
      const row = {
        long,
        short: shortBefore ?? shortAfter ?? null,
        kind: kindOf(placeholder),
        placeholder: placeholder ?? null,
      };
      const seen = flags.get(long);
      if (seen === undefined) flags.set(long, row);
      else if (seen.short !== row.short || (seen.kind === "boolean") !== (row.kind === "boolean")) {
        throw new Error(`--${long} is documented two ways in the fixture`);
      } else if (KIND_WIDTH[row.kind] > KIND_WIDTH[seen.kind]) flags.set(long, row);
      continue;
    }
    const example = EXAMPLE_LINE.exec(line);
    if (example !== null) {
      exampleWords.add(example[1] ?? "");
      continue;
    }
    const verb = VERB_LINE.exec(line);
    if (verb === null) continue;
    const [, name = "", inlineAlias, rest = ""] = verb;
    if (verbs.has(name)) throw new Error(`${name} is documented twice in the fixture`);
    const noted = ALIAS_NOTE.exec(rest)?.[1];
    const aliases = [inlineAlias, noted].filter((alias): alias is string => alias !== undefined);
    verbs.set(name, { verb: name, aliases });
  }
  return { flags, verbs, exampleWords };
}

export const UPSTREAM = parseUpstream(FIXTURE);

export function upstreamFlag(long: string): UpstreamFlag {
  const row = UPSTREAM.flags.get(long);
  if (row === undefined) throw new Error(`the fixture documents no --${long}`);
  return row;
}

export function upstreamVerb(name: string): UpstreamVerb {
  const row = UPSTREAM.verbs.get(name);
  if (row === undefined) throw new Error(`the fixture documents no ${name} verb`);
  return row;
}

export const MAXIMS_FLAGS: readonly FlagSpec[] = [...GLOBAL_FLAGS, ...Object.values(FLAGS)];

export function maximsFlag(long: string): FlagSpec {
  const flag = MAXIMS_FLAGS.find((candidate) => candidate.name === long);
  if (flag === undefined) throw new Error(`maxims has no --${long}`);
  return flag;
}

// One row of the flag table, in page order. `same` names the one long form both tools spell;
// `analog` pairs an upstream long form with the maxims flag that stands for it; `diverge` lists
// upstream flags maxims lacks; `maxims-only` lists maxims flags with no upstream concept. Every
// upstream flag outside SCAN_FLAGS belongs to exactly one row, and so does every maxims flag.
export type FlagRow =
  | { parity: "same"; flag: string; why: string }
  | { parity: "analog"; upstream: string; maxims: string; why: string }
  | { parity: "diverge"; upstream: readonly string[]; why: string }
  | { parity: "maxims-only"; maxims: readonly string[]; why: string };

export const FLAG_ROWS: readonly FlagRow[] = [
  { parity: "same", flag: "global", why: "" },
  {
    parity: "same",
    flag: "project",
    why: "`skills` carries it on `update` only; maxims offers it on `add` and `remove` too",
  },
  {
    parity: "analog",
    upstream: "skill",
    maxims: "memory",
    why: "only the noun differs; the value shape is copied exactly",
  },
  { parity: "same", flag: "agent", why: "" },
  { parity: "same", flag: "list", why: "" },
  { parity: "same", flag: "yes", why: "" },
  { parity: "same", flag: "all", why: "same shorthand on both verbs" },
  { parity: "same", flag: "copy", why: "materialize instead of link" },
  {
    parity: "same",
    flag: "dry-run",
    why: "`skills` carries it on `experimental_sync` only; maxims accepts it on every verb",
  },
  {
    parity: "diverge",
    upstream: ["no-cleanup"],
    why: "a dropped memory leaves on the next sync; an emptied source keeps its [last block](guarantees.md#failure-paths)",
  },
  {
    parity: "diverge",
    upstream: ["no-remote"],
    why: "every maxims source is a store entry; `sync --no-fetch` applies them without the network",
  },
  {
    parity: "diverge",
    upstream: ["recursive"],
    why: "a workspace's package dependencies have no maxims concept; state lists every source itself",
  },
  {
    parity: "diverge",
    upstream: ["include", "exclude"],
    why: "`sync` writes every memory in state; `disable <memory>` withholds one, `-m` narrows an `add`",
  },
  {
    parity: "same",
    flag: "full-depth",
    why: "`skills` searches past a root `SKILL.md`; maxims past `memories/`",
  },
  {
    parity: "same",
    flag: "json",
    why: "`skills` carries it on `add` and `list`; maxims emits one document from every verb",
  },
  {
    parity: "diverge",
    upstream: ["metadata"],
    why: "install telemetry; maxims ships none, see [security](security.md)",
  },
  {
    parity: "diverge",
    upstream: ["subagent"],
    why: "a rule file has no subagent scope to target",
  },
  { parity: "diverge", upstream: ["owner"], why: "belongs to `find`, which maxims lacks" },
  {
    parity: "maxims-only",
    maxims: ["out"],
    why: "a team's rule file lives in a repo path, not a scope",
  },
  {
    parity: "maxims-only",
    maxims: ["rule", "add-hook", "quiet"],
    why: "skills have no always-loaded layer and no hook that runs unattended",
  },
  {
    parity: "maxims-only",
    maxims: ["link"],
    why: "a symlinked store entry for a local source; an open skills request (vercel-labs/skills#748)",
  },
  {
    parity: "maxims-only",
    maxims: ["cooldown", "cap"],
    why: "the refresh window and the rule budget have no skills concept",
  },
  {
    parity: "maxims-only",
    maxims: ["auth", "rename", "allow-hidden"],
    why: "anonymous fetch, scripted collision resolution, and the hidden-character gate have no skills concept",
  },
  {
    parity: "maxims-only",
    maxims: ["share"],
    why: "which sources a project commits is a choice per source; skills have no analog",
  },
  {
    parity: "maxims-only",
    maxims: ["verbose"],
    why: "unfolds the `add` and `install` plan to every one-liner; `skills` never folds its summary",
  },
  {
    parity: "maxims-only",
    maxims: ["from"],
    why: "names the memories folder; `skills` searches for `SKILL.md`, maxims never autodetects",
  },
  {
    parity: "maxims-only",
    maxims: ["pin"],
    why: "tracks one ref; the captured `skills` page documents none",
  },
  {
    parity: "maxims-only",
    maxims: ["paths"],
    why: "narrows an always-on rule to matching files; a skill already loads [on demand](why.md#the-npx-skills-analogy)",
  },
  {
    parity: "maxims-only",
    maxims: ["review"],
    why: "holds an upstream change until `accept`; a skills update applies at once",
  },
  {
    parity: "maxims-only",
    maxims: ["strict"],
    why: "the description gate has no skills concept; see [risky shapes](security.md#risky-shapes-in-descriptions)",
  },
  {
    parity: "maxims-only",
    maxims: ["no-fetch"],
    why: "`sync` without the network; the nearest skills idea is `--no-remote` above",
  },
  {
    parity: "maxims-only",
    maxims: ["expect", "source"],
    why: "belong to `doctor` and `show`, which skills lack",
  },
];

// `--help` and `--version` have no row: the page documents decisions, and those two are standard.
export const SCAN_FLAGS = ["help", "version"];

const rowsOf = <P extends FlagRow["parity"]>(parity: P) =>
  FLAG_ROWS.filter((row): row is Extract<FlagRow, { parity: P }> => row.parity === parity);

export const SAME_FLAGS = rowsOf("same").map((row) => row.flag);
export const ANALOG_FLAGS: Record<string, FlagSpec> = Object.fromEntries(
  rowsOf("analog").map((row) => [row.upstream, maximsFlag(row.maxims)]),
);
export const DIVERGE_FLAGS = rowsOf("diverge").flatMap((row) => row.upstream);

// Every flag a row claims, upstream and maxims, each exactly once: a flag claimed twice renders
// two rows, and a maxims flag no row claims leaves the table silently behind the registry. Refused
// here, in the owner, so the table and the registry cannot drift apart.
function upstreamClaimedBy(row: FlagRow): string[] {
  switch (row.parity) {
    case "same":
      return [row.flag];
    case "analog":
      return [row.upstream];
    case "diverge":
      return [...row.upstream];
    case "maxims-only":
      return [];
  }
}

function maximsClaimedBy(row: FlagRow): string[] {
  switch (row.parity) {
    case "same":
      return [row.flag];
    case "analog":
      return [row.maxims];
    case "diverge":
      return [];
    case "maxims-only":
      return [...row.maxims];
  }
}

const twice = (names: readonly string[]): string[] =>
  names.filter((name, index) => names.indexOf(name) !== index);

export function claimedFlags(): { upstream: string[]; maxims: string[] } {
  const upstream = FLAG_ROWS.flatMap(upstreamClaimedBy);
  const maxims = FLAG_ROWS.flatMap(maximsClaimedBy);
  const ours = MAXIMS_FLAGS.map((flag) => flag.name);
  const faults = {
    upstreamTwice: twice(upstream),
    maximsTwice: twice(maxims),
    maximsUnclaimed: ours.filter((name) => !maxims.includes(name)),
    notMaxims: maxims.filter((name) => !ours.includes(name)),
  };
  if (Object.values(faults).some((names) => names.length > 0)) {
    throw new Error(`parity rows: ${JSON.stringify(faults)}`);
  }
  return { upstream, maxims };
}

export const SAME_VERBS = ["add", "remove", "list", "update"];
export const DIVERGE_VERBS = ["use", "find"];
export const UNCLAIMED_VERBS = ["experimental_install", "experimental_sync", "init"];
