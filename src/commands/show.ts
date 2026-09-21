import { join } from "node:path";
import { STRINGS } from "../console/strings.ts";
import type { Scope } from "../harnesses/contract.ts";
import type { MemoryName } from "../memory/contract.ts";
import { renderRuleLine } from "../rulefile/block.ts";
import { shortHash } from "../rulefile/dedupe.ts";
import type { SourceEntry, State } from "../state/schema.ts";
import { ExitCode, MaximsError } from "../util/exit-codes.ts";
import { storePathFor } from "../util/home.ts";
import { peekIntent } from "./shared/cli-context.ts";
import { actsHere } from "./shared/context.ts";
import { isFetchedEntry, readInstalledTree, shortSha } from "./shared/engine.ts";
import { ReportedMaximsError } from "./shared/errors.ts";
import {
  type Args,
  type Command,
  closestName,
  FLAGS,
  type FlagSpec,
  memoryNameOrUsage,
  projectDestination,
  usage,
} from "./shared/options.ts";
import { errorDocument } from "./shared/report.ts";
import { disabledNames, type SelectedMemory, selectMemories } from "./shared/select.ts";
import { findInstalledSource } from "./shared/sources.ts";
import type { CliIo } from "./types.ts";

const SHOW_FLAGS: readonly FlagSpec[] = [FLAGS.global, FLAGS.project, FLAGS.source];

export type ShownMemory = {
  name: MemoryName;
  upstreamName: MemoryName;
  source: string;
  sha: string | null;
  disabled: boolean;
  held: boolean;
  ruleLine: string | null;
  body: string;
};

export type ShowRequest = {
  name: MemoryName;
  source: string | null;
  scope: Scope | null;
};

// `notices` are the sources whose copy could not be read, so a name they may provide is neither
// found nor offered as a suggestion; `names` are the local names every readable source installs.
export type ShowLookup = { notices: string[] } & (
  | { kind: "found"; memory: ShownMemory }
  | { kind: "absent"; names: Set<MemoryName> }
  | { kind: "ambiguous"; keys: string[] }
);

// Read-only: the facts come from state and the body from the store copy, never from a harness's
// destination, so what prints is what the next sync would install. It never takes the lock and
// never settles the state file.
export const show: Command = {
  summary: "print one installed memory in full: its facts, then its file",
  usage: "show <memory>",
  arity: 1,
  flags: SHOW_FLAGS,
  async run(args, ctx) {
    const { io } = ctx;
    const positional = args.positionals[0];
    if (positional === undefined) {
      throw usage("show needs a memory name", { hint: "maxims show <memory>" });
    }
    const name = memoryNameOrUsage(positional);
    const scope = scopeFlag(args, io.projectRoot);
    const { state, notices } = await peekIntent(io.home);
    const [unusable] = notices;
    if (unusable !== undefined) throw usage(unusable);
    const request: ShowRequest = {
      name,
      source: args.value(FLAGS.source) ?? null,
      scope,
    };
    const lookup = await lookupMemory(state, io, request);
    const console = await ctx.openConsole(true);
    for (const line of lookup.notices) console.warn(line);
    if (lookup.kind !== "found") {
      const failure = lookupFailure(lookup, request);
      if (!ctx.global.json) throw failure;
      // The `--json` document is the one place the store warnings can reach a caller, and a name
      // "not installed" beside an unreadable source is a different fact from one nobody provides.
      io.stdout.write(errorDocument(failure, { notices: lookup.notices }));
      throw new ReportedMaximsError(failure.code, failure.message, { hint: failure.hint });
    }
    const { memory } = lookup;
    if (ctx.global.json) {
      const body = { ok: true, ...memory, notices: lookup.notices };
      io.stdout.write(`${JSON.stringify(body, null, 2)}\n`);
      return ExitCode.Ok;
    }
    if (ctx.global.quiet) return ExitCode.Ok;
    console.intro();
    console.note(factLines(memory).join("\n"), memory.name);
    console.gap();
    io.stdout.write(memory.body);
    return ExitCode.Ok;
  },
};

// `-g` and `-p` narrow the sources judged; `show` has no `-o`, since an out folder is a rule
// file and not a place a memory is read from. `-p` outside a project gets the refusal every
// project-scoped flag gets.
function scopeFlag(args: Args, projectRoot: string | null): Scope | null {
  const global = args.flag(FLAGS.global);
  const project = args.flag(FLAGS.project);
  if (global && project) throw usage(STRINGS.twoDestinations);
  if (project) {
    projectDestination(projectRoot);
    return "project";
  }
  return global ? "global" : null;
}

function factLines(memory: ShownMemory): string[] {
  const upstream =
    memory.upstreamName === memory.name ? "" : ` (upstream name ${memory.upstreamName})`;
  return [
    `source: ${memory.source}${upstream}`,
    `revision: ${memory.sha === null ? "-" : shortSha(memory.sha)}`,
    `disabled: ${memory.disabled ? "yes" : "no"}`,
    `held: ${memory.held ? `yes (run maxims accept ${memory.source})` : "no"}`,
    `rule: ${memory.ruleLine ?? "none (the source publishes no rule lines)"}`,
  ];
}

function lookupFailure(
  lookup: Extract<ShowLookup, { kind: "absent" | "ambiguous" }>,
  request: ShowRequest,
): MaximsError {
  if (lookup.kind === "ambiguous") {
    return new MaximsError(
      ExitCode.Usage,
      `${request.name} is provided by ${lookup.keys.length} sources: ${lookup.keys.join(", ")}`,
      { hint: `maxims show ${request.name} --source <key>` },
    );
  }
  const closest = closestName(request.name, lookup.names);
  const message =
    request.source === null
      ? `${request.name} is not installed`
      : `${request.source} does not provide ${request.name}`;
  return new MaximsError(ExitCode.Usage, message, {
    ...(closest === null ? {} : { hint: `did you mean ${closest}?` }),
  });
}

type Candidate = {
  key: string;
  entry: SourceEntry;
  sha: string | null;
  selected: SelectedMemory;
  disabled: boolean;
};

// The sources judged are the ones a run here acts on, narrowed by the scope flag and by
// `--source`; the name is matched after the selection and the rename map, as the sync installs
// it, so a memory hidden by `-m` or renamed is found under the name the user sees.
export async function lookupMemory(
  state: State,
  io: CliIo,
  request: ShowRequest,
): Promise<ShowLookup> {
  const only = request.source === null ? null : findInstalledSource(state, request.source, io);
  const notices: string[] = [];
  const names = new Set<MemoryName>();
  const candidates: Candidate[] = [];
  for (const key of Object.keys(state.sources).sort()) {
    const entry = state.sources[key];
    if (entry === undefined || !actsHere(entry, io)) continue;
    const { destination } = entry.intent;
    if (request.scope !== null && destination.scope !== request.scope) continue;
    if (only !== null && key !== only) continue;
    const storeEntry = storePathFor(io.home, entry.intent.from);
    const tree = await readInstalledTree(entry, storeEntry, (line) =>
      notices.push(`maxims: ${key}: ${line}`),
    );
    if (tree.kind !== "tree") {
      notices.push(`maxims: ${key}: ${tree.reason}`);
      continue;
    }
    const disabled = disabledNames(
      state,
      destination.scope,
      destination.scope === "project" ? destination.root : null,
    );
    const selection = selectMemories({
      memories: tree.tree.memories,
      intent: entry.intent,
      installInternal: io.env.MAXIMS_INSTALL_INTERNAL === "1",
      disabled: new Set(),
      detailPath: () => "",
    });
    const fetched = isFetchedEntry(entry) ? entry.fetched : undefined;
    for (const selected of selection.selected) {
      names.add(selected.localName);
      if (selected.localName !== request.name) continue;
      candidates.push({
        key,
        entry,
        selected,
        sha: fetched?.sha ?? tree.tree.sha,
        disabled: disabled.has(selected.localName),
      });
    }
  }
  const [candidate, ...rest] = candidates;
  if (candidate === undefined) return { kind: "absent", names, notices };
  if (rest.length > 0) {
    return { kind: "ambiguous", keys: candidates.map((each) => each.key), notices };
  }
  return { kind: "found", memory: shown(candidate, io), notices };
}

function shown(candidate: Candidate, io: Pick<CliIo, "home">): ShownMemory {
  const { entry, selected } = candidate;
  const held = isFetchedEntry(entry) && entry.pending !== undefined;
  return {
    name: selected.localName,
    upstreamName: selected.upstreamName,
    source: candidate.key,
    sha: candidate.sha,
    disabled: candidate.disabled,
    held,
    ruleLine: entry.intent.rule ? ruleLineOf(candidate, io) : null,
    body: selected.memory.text,
  };
}

// The line as a harness that expands no reference syntax reads it. Its detail path is the store
// copy `show` read, which is what a user-scope rule line carries; a project rule file carries its
// own bodies path instead.
function ruleLineOf(candidate: Candidate, io: Pick<CliIo, "home">): string {
  const { memory } = candidate.selected;
  const storeEntry = storePathFor(io.home, candidate.entry.intent.from);
  return renderRuleLine(
    {
      name: candidate.selected.localName,
      description: memory.memory.description,
      detailPath: join(storeEntry, ...memory.relPath.split("/")),
      shortHash: shortHash(memory.memory.contentHash),
    },
    ["none"],
  );
}
