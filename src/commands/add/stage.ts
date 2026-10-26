import { basename } from "node:path";
import type { Console } from "../../console/contract.ts";
import { found, notAMemory, STRINGS, selected } from "../../console/strings.ts";
import type { SourceFrom } from "../../contracts/source.ts";
import { isHiddenInternal } from "../../engine/select.ts";
import { findSourceKey, storeTree } from "../../engine/source-key.ts";
import type { CliIo } from "../../engine/types.ts";
import { type Memory, type MemoryName, parseMemory } from "../../memory/contract.ts";
import { DEFAULT_GH_HOST } from "../../sources/github/host.ts";
import type { TreeFile } from "../../sources/tree.ts";
import type { Select, State } from "../../state/schema.ts";
import { ExitCode, MaximsError } from "../../util/exit-codes.ts";
import { storePathFor } from "../../util/home.ts";
import { compareCodeUnits } from "../../util/order.ts";
import { withScratchDir } from "../../util/scratch.ts";
import { loadIntentFor, peekIntent } from "../frame/cli-context.ts";
import { installedAtOtherScope, installedElsewhere } from "../frame/lookup.ts";
import type { CommandContext } from "../frame/options.ts";
import type { AddRequest } from "./request.ts";

export type FetchedFiles = { sha: string; memoryPath: string; files: TreeFile[] };
type FetchedTree = FetchedFiles | { kind: "store-empty" };

// `install` stages every manifest entry before planning any, so the entries validate against each
// other.
//   recorded             holds the hidden internal memories too: the fetch record is a fact about
//                        the source, and a refresh writes it that way
//   disabledByManifest   the local names the commit switches off at the project beside the ones
//                        state already holds: the manifest's `disabled` list on a replay, nothing
//                        on a plain add
export type StagedAdd = {
  request: AddRequest;
  tree: FetchedFiles;
  memories: Memory[];
  recorded: Memory[];
  chosen: Memory[];
  state: State;
  disabledByManifest: readonly MemoryName[];
};

export type StageOutcome = { kind: "store-empty" } | { kind: "staged"; staged: StagedAdd };

export async function stageAdd(
  requested: AddRequest,
  ctx: CommandContext,
  console: Console,
): Promise<StageOutcome> {
  const { io } = ctx;
  console.step(`Source: ${describeSource(requested.from)}`);
  const tree = await fetchTree(requested, io, console);
  if ("kind" in tree) return { kind: "store-empty" };
  const intent = requested.list
    ? await peekIntent(io.home)
    : await loadIntentFor(io.home, ctx.global.dryRun);
  for (const notice of intent.notices) console.warn(notice);
  const request = adoptRecordedKey(requested, intent.state, io);
  const scan = scanMemories(request, tree.files, io.installInternal, console);
  console.step(found(scan.memories.length, scan.internalHidden));
  const chosen = filterSelection(request.select, scan.memories);
  if (chosen.length === 0) {
    throw new MaximsError(
      ExitCode.NothingResolved,
      "No valid memories found. Memories require frontmatter with name and description.",
    );
  }
  if (request.select !== "*") console.step(selected(chosen.map((memory) => memory.name)));
  return {
    kind: "staged",
    staged: {
      request,
      tree,
      memories: scan.memories,
      recorded: scan.recorded,
      chosen,
      state: intent.state,
      disabledByManifest: [],
    },
  };
}

// GitHub names are case-insensitive and the state file refuses two spellings of one repository, so
// a re-add typed in another case continues the recorded entry under its recorded key. State holds
// one entry per source, so a re-add cannot take another project's entry over or move one between
// scopes; both are refused with the way out named.
//   another `-o` folder   a move within the scope; the sync that follows sweeps the retired folder
//   `--list`              takes nothing over and previews the source wherever it is recorded
function adoptRecordedKey(request: AddRequest, state: State, io: CliIo): AddRequest {
  const recorded = findSourceKey(state, request.key);
  if (recorded === null) return request;
  const entry = state.sources[recorded];
  if (entry === undefined) return request;
  const { destination } = entry.intent;
  if (!request.list && destination.scope === "project" && destination.root !== io.projectRoot) {
    throw installedElsewhere(recorded, destination.root);
  }
  if (!request.list && destination.scope !== request.destination.scope) {
    throw installedAtOtherScope(recorded, destination, request.destination);
  }
  if (recorded === request.key) return request;
  return { ...request, key: recorded, from: entry.intent.from };
}

export function describeSource(from: SourceFrom): string {
  switch (from.type) {
    case "github":
      return `https://${from.host ?? DEFAULT_GH_HOST}/${from.repo}.git`;
    case "git":
      return from.url;
    case "local":
      return from.path;
  }
}

// A fetch lands in a temp directory removed on every path; a `--list --no-fetch` walks the store
// copy instead, the way the fetch walked the source, and never opens a socket, which is what keeps
// the benchmark's preview offline.
async function fetchTree(request: AddRequest, io: CliIo, console: Console): Promise<FetchedTree> {
  if (request.noFetch) {
    const tree = await storeTree(storePathFor(io.home, request.from), request);
    if (tree === null) return { kind: "store-empty" };
    return { sha: "store", memoryPath: request.memoryPath, files: tree.files };
  }
  const local = request.from.type === "local";
  return withScratchDir("maxims-add-", async (tempDir) => {
    const spinner = console.spinner(local ? STRINGS.readingDirectory : STRINGS.cloning);
    try {
      const resolver = io.resolvers(request.from);
      const result = await resolver.fetch(request.from, {
        memoryPath: request.memoryPath,
        fullDepth: request.fullDepth,
        tempDir,
        auth: request.auth,
      });
      spinner.stop(local ? STRINGS.directoryRead : STRINGS.cloned);
      return { sha: result.sha, memoryPath: result.memoryPath, files: result.files };
    } catch (error) {
      spinner.fail(local ? STRINGS.directoryUnreadable : STRINGS.cloneFailed);
      if (error instanceof MaximsError) throw error;
      const detail = error instanceof Error ? error.message : String(error);
      throw new MaximsError(
        ExitCode.SourceUnresolvable,
        `cannot fetch ${describeSource(request.from)}: ${detail}`,
        {
          cause: error,
        },
      );
    }
  });
}

type Scan = { memories: Memory[]; recorded: Memory[]; internalHidden: number };

// A hidden internal memory still enters the fetch record, which lists what the source ships.
function scanMemories(
  request: AddRequest,
  files: readonly TreeFile[],
  installInternal: boolean,
  console: Console,
): Scan {
  const memories: Memory[] = [];
  const recorded: Memory[] = [];
  let internalHidden = 0;
  for (const file of files) {
    if (!file.relPath.endsWith(".md")) continue;
    const parsed = parseMemory(file.relPath, file.text);
    if (!parsed.ok) {
      console.warn(notAMemory(basename(file.relPath), parsed.reason));
      continue;
    }
    if (parsed.warning !== undefined) console.warn(`${parsed.memory.name}: ${parsed.warning}`);
    recorded.push(parsed.memory);
    if (isHiddenInternal(parsed.memory, request.select, installInternal)) {
      internalHidden += 1;
      continue;
    }
    memories.push(parsed.memory);
  }
  const byName = (a: Memory, b: Memory) => compareCodeUnits(a.name, b.name);
  return { memories: memories.sort(byName), recorded: recorded.sort(byName), internalHidden };
}

function filterSelection(select: Select, memories: readonly Memory[]): Memory[] {
  if (select === "*") return [...memories];
  const byName = new Map(memories.map((memory) => [memory.name, memory] as const));
  const missing = select.filter((name) => !byName.has(name));
  if (missing.length > 0) {
    const available = memories.map((memory) => `  - ${memory.name}`).join("\n");
    throw new MaximsError(
      ExitCode.NothingResolved,
      `No matching memories found for: ${missing.join(", ")}\nAvailable memories:\n${available}`,
    );
  }
  return select.flatMap((name) => {
    const memory = byName.get(name);
    return memory === undefined ? [] : [memory];
  });
}
