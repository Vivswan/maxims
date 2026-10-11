import { basename } from "node:path";
import type { Console } from "../../console/contract.ts";
import {
  firstSourceFrom,
  memories,
  privacyWarning,
  replacedSelection,
  STRINGS,
} from "../../console/strings.ts";
import type { HarnessId } from "../../contracts/harness-id.ts";
import {
  DEFAULT_GIT_REF,
  parseRemote,
  type SourceFrom,
  stripGitSuffix,
} from "../../contracts/source.ts";
import { harnessContext } from "../../engine/context.ts";
import { disabledNames } from "../../engine/select.ts";
import { sourceSlug } from "../../engine/slug.ts";
import type { CliIo } from "../../engine/types.ts";
import { type Memory, type MemoryName, renamed } from "../../memory/contract.ts";
import { DEFAULT_GH_HOST } from "../../sources/github/host.ts";
import type { RenameMap, Select, State } from "../../state/schema.ts";
import { compareCodeUnits } from "../../util/order.ts";
import { targetPath, tildify } from "../frame/lookup.ts";
import type { CommandContext } from "../frame/options.ts";
import {
  type MemoryRiskWarning,
  refuseRisky,
  riskWarningsFor,
  showRiskWarnings,
} from "../frame/risk.ts";
import { chooseHarnesses, type HarnessChoice } from "./harnesses.ts";
import type { AddRequest } from "./request.ts";
import { describeSource, type FetchedFiles, type StagedAdd } from "./stage.ts";
import { validate } from "./validate.ts";

export type PreparedAdd = {
  request: AddRequest;
  tree: FetchedFiles;
  recorded: Memory[];
  chosen: Memory[];
  staged: State;
  rename: RenameMap;
  harnesses: HarnessChoice;
  names: MemoryName[];
  warnings: MemoryRiskWarning[];
};

export type PrepareOutcome =
  | { kind: "listed" }
  | { kind: "store-empty" }
  | { kind: "cancelled" }
  | { kind: "prepared"; prepared: PreparedAdd };

// No intent and no destination is written here, so a failure (exit 3, 6, 7, 8) leaves the machine
// as it was, apart from a corrupt state file a real run's locking read has already moved aside.
//   --list     stops before validation: a preview exists so the user can see and narrow a source
//              whose install would be refused
//   siblings   the other sources staged in the same run, treated as if they were already recorded
//   warnings   sit above the plan, so the one-liners are judged with the shapes named; `--strict`
//              turns them into the refusal, and a memory disabled at the destination is not judged
export async function planAdd(
  staged: StagedAdd,
  ctx: CommandContext,
  console: Console,
  siblings: readonly StagedAdd[],
): Promise<PrepareOutcome> {
  const { io } = ctx;
  const { request, tree, chosen } = staged;
  const existing = staged.state.sources[request.key];
  if (request.list) {
    console.gap();
    console.note("", STRINGS.availableMemories);
    for (const memory of sorted(chosen, request.rename)) {
      console.name(renamed(request.rename, memory.name));
    }
    console.gap();
    console.outro(STRINGS.runWithoutList);
    return { kind: "listed" };
  }
  const rename = await validate(request, chosen, staged.state, siblings, ctx, console);
  const harnesses = await chooseHarnesses(request, ctx, console);
  if (harnesses === null) {
    console.step(STRINGS.installationCancelled);
    return { kind: "cancelled" };
  }
  console.gap();
  if (existing !== undefined && !sameSelect(existing.intent.select, request.select)) {
    console.step(replacedSelection(showSelect(existing.intent.select), showSelect(request.select)));
  }
  const disabled = new Set([
    ...disabledNames(staged.state, request.destination.scope, io.projectRoot),
    ...staged.disabledByManifest,
  ]);
  const warnings = riskWarningsFor(
    chosen.filter((memory) => !disabled.has(renamed(rename, memory.name))),
  );
  showRiskWarnings(console, warnings);
  if (request.strict) refuseRisky(warnings);
  console.note(planBody(request, harnesses.ids, io), STRINGS.memoriesToInstall);
  if (
    request.from.type === "local" &&
    request.destination.scope === "project" &&
    io.projectRoot !== null
  ) {
    console.warn(privacyWarning(io.projectRoot));
  }
  for (const warning of harnesses.warnings) console.warn(warning);
  console.gap();
  showItems(console, chosen, rename, request.verbose);
  const proceed = await console.confirm(STRINGS.proceed, true);
  if (!proceed) {
    console.step(STRINGS.installationCancelled);
    return { kind: "cancelled" };
  }
  return {
    kind: "prepared",
    prepared: {
      request,
      tree,
      recorded: staged.recorded,
      chosen,
      staged: staged.state,
      rename,
      harnesses,
      names: chosen.map((memory) => renamed(rename, memory.name)).sort(),
      warnings,
    },
  };
}

// Shown once, on the first install from an owner this machine holds nothing else from: the review
// gate for a source is the plan, and a plan from a stranger deserves the repository, the commit and
// the size named beside it.
export type Provenance = {
  owner: string;
  url: string;
  sha: string;
  memories: number;
  pinned: string | null;
};

// The GitHub account under its host, or a git host and the first path segment
// (`git.example.com/team`), both lower-cased so a GitHub Enterprise repository spelled as a URL and
// as a shorthand is one owner (GitHub names are case-insensitive).
export function sourceOwner(from: SourceFrom): string | null {
  if (from.type === "github") {
    const [owner = ""] = from.repo.toLowerCase().split("/", 1);
    return `${from.host ?? DEFAULT_GH_HOST}/${owner}`;
  }
  if (from.type === "local") return null;
  const remote = parseRemote(from.url);
  const [first] = remote?.segments ?? [];
  if (remote === null || first === undefined) return from.url;
  return `${remote.host}/${first.toLowerCase()}`;
}

// A re-add of a recorded source is not a first install, so the recorded entry counts as known.
export function provenanceFor(staged: StagedAdd): Provenance | null {
  const { request, tree, memories, state } = staged;
  const owner = sourceOwner(request.from);
  if (owner === null || request.from.type === "local") return null;
  const known = Object.values(state.sources).some(
    (entry) => sourceOwner(entry.intent.from) === owner,
  );
  if (known) return null;
  return {
    owner,
    url: describeSource(request.from),
    sha: tree.sha,
    memories: memories.length,
    pinned: request.from.ref === DEFAULT_GIT_REF ? null : request.from.ref,
  };
}

export function showProvenance(console: Console, provenance: Provenance): void {
  const pin =
    provenance.pinned === null
      ? `not pinned (tracks ${DEFAULT_GIT_REF})`
      : `pinned to ${provenance.pinned}`;
  console.note(
    [
      provenance.url,
      `commit ${provenance.sha.slice(0, 7)}, ${pin}`,
      memories(provenance.memories),
    ].join("\n"),
    firstSourceFrom(provenance.owner),
  );
}

// One line per destination: two harnesses reading one file or folder are one place the memories go.
function planBody(request: AddRequest, ids: readonly HarnessId[], io: CliIo): string {
  const ctx = harnessContext(io);
  const slug = sourceSlug(request.from);
  const lines = ids.map((id) => {
    const def = io.harnesses.find((candidate) => candidate.id === id);
    if (def === undefined) return id;
    const destination = request.destination;
    const path =
      destination.scope === "out"
        ? destination.path
        : request.rule
          ? targetPath(def, destination, ctx, slug)
          : (def.bodiesDir(destination.scope, ctx) ?? targetPath(def, destination, ctx, slug));
    return `${sourceTitle(request.from)} -> ${tildify(path ?? "(no target)", io.userHome)}`;
  });
  return [...new Set(lines)].join("\n");
}

// `Octocat/rules` reads as `Octocat Rules` on the plan screen, as `skills` titles a source. A git
// remote titles by its repository segment, read the way the store path and the owner read it.
export function sourceTitle(from: SourceFrom): string {
  const raw =
    from.type === "github"
      ? from.repo.split("/")
      : from.type === "git"
        ? [stripGitSuffix(parseRemote(from.url)?.segments.at(-1) ?? from.url)]
        : [basename(from.path)];
  return raw
    .flatMap((part) => part.split(/[-_]+/))
    .filter((word) => word !== "")
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(" ");
}

// The plan screen lists EVERY incoming one-liner in plain mode and under --verbose: it is the
// review gate for what will sit in the agent's context, so a fold is allowed only on a TTY where
// the user can rerun with --verbose. `--list` prints the names alone, every one, and never folds.
function showItems(
  console: Console,
  chosen: readonly Memory[],
  rename: RenameMap,
  verbose: boolean,
): void {
  const items = sorted(chosen, rename);
  const fold = console.mode.tty && !verbose && items.length > 1;
  const shown = fold ? items.slice(0, 1) : items;
  for (const memory of shown) console.item(renamed(rename, memory.name), memory.description);
  if (fold) console.more(items.length - shown.length);
}

function sorted(chosen: readonly Memory[], rename: RenameMap): Memory[] {
  return [...chosen].sort((a, b) =>
    compareCodeUnits(renamed(rename, a.name), renamed(rename, b.name)),
  );
}

function sameSelect(a: Select, b: Select): boolean {
  if (a === "*" || b === "*") return a === b;
  return a.length === b.length && a.every((name, index) => name === b[index]);
}

function showSelect(select: Select): string {
  return select === "*" ? "*" : select.join(", ");
}
