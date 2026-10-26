import type { Console } from "../../console/contract.ts";
import { promptRenames, type RenameAnswer } from "../../console/rename.ts";
import { hiddenCharacter, linksTo, ownedBy, renameHint } from "../../console/strings.ts";
import { DEFAULT_GIT_REF, type SourceFrom } from "../../contracts/source.ts";
import { sourceSlug } from "../../engine/slug.ts";
import { sourceIdentity } from "../../engine/source-key.ts";
import type { CliIo } from "../../engine/types.ts";
import {
  hiddenCharacterLabel,
  hiddenCharacters,
  type Memory,
  renamed,
} from "../../memory/contract.ts";
import { resolveWikilinks } from "../../memory/wikilinks.ts";
import type { IndexedSource } from "../../rulefile/dedupe.ts";
import { canonicalSourceKey, type RenameMap, type State } from "../../state/schema.ts";
import { ExitCode, MaximsError } from "../../util/exit-codes.ts";
import {
  effectiveNames,
  installedAtOtherRef,
  installedSources,
  resolveIncoming,
  ruleCapRefusal,
  sourcesHere,
} from "../frame/lookup.ts";
import type { CommandContext } from "../frame/options.ts";
import type { AddRequest } from "./request.ts";
import type { StagedAdd } from "./stage.ts";

// Every colliding name owned by one repository recorded under another ref is a repin: two source
// keys, one repository, and a rename prompt would only obscure the order that repins it. A name
// the incoming source collides with itself on, or with any other source, keeps the rename path.
function repinRefusal(from: SourceFrom, owners: string[], state: State): MaximsError | null {
  if (from.type === "local") return null;
  const base = { ...from, ref: DEFAULT_GIT_REF };
  let repinned: { key: string; ref: string } | null = null;
  for (const owner of owners) {
    const recorded = state.sources[owner]?.intent.from;
    if (recorded === undefined || recorded.type === "local" || recorded.ref === from.ref) {
      return null;
    }
    if (sourceIdentity({ ...recorded, ref: DEFAULT_GIT_REF }) !== sourceIdentity(base)) return null;
    repinned ??= { key: owner, ref: recorded.ref };
  }
  if (repinned === null) return null;
  return installedAtOtherRef(canonicalSourceKey(base), repinned.key, repinned.ref, from.ref);
}

function assertNoHiddenCharacters(chosen: readonly Memory[]): void {
  for (const memory of chosen) {
    const first = hiddenCharacters(memory.description)[0];
    if (first === undefined) continue;
    throw new MaximsError(
      ExitCode.NothingResolved,
      hiddenCharacter(memory.name, hiddenCharacterLabel(first), first.index + 1),
      { hint: "pass --allow-hidden to install it anyway" },
    );
  }
}

// The local names installed here apart from this source's own and the siblings' recorded entries,
// plus what the siblings in this add will install: what a wikilink can resolve to.
async function installedLocalNames(
  request: AddRequest,
  siblings: readonly StagedAdd[],
  state: State,
  io: CliIo,
): Promise<Set<string>> {
  const names = new Set<string>();
  for (const [key, entry] of sourcesHere(state, io)) {
    if (key === request.key || siblings.some((sibling) => sibling.request.key === key)) continue;
    for (const name of await effectiveNames(entry, io)) names.add(name);
  }
  for (const sibling of siblings) {
    for (const memory of sibling.chosen) names.add(renamed(sibling.request.rename, memory.name));
  }
  return names;
}

function assertRenamesKnown(rename: RenameMap, chosen: readonly Memory[]): void {
  const unknown = Object.keys(rename).filter(
    (name) => !chosen.some((memory) => memory.name === name),
  );
  if (unknown.length === 0) return;
  throw new MaximsError(
    ExitCode.NothingResolved,
    `--rename names memories the source lacks: ${unknown.join(", ")}`,
  );
}

function assertLinksMet(
  chosen: readonly Memory[],
  installedNames: Set<string>,
  rename: RenameMap,
): void {
  const { unmet } = resolveWikilinks([...chosen], installedNames, rename);
  const first = unmet[0];
  if (first === undefined) return;
  throw new MaximsError(ExitCode.UnmetDependency, linksTo(first.memory, first.link), {
    hint: `install a source providing ${first.link} first`,
  });
}

// The sources the incoming one is resolved against: those installed here, each sibling of this
// add standing in for its own recorded entry.
async function resolutionIndex(
  siblings: readonly StagedAdd[],
  state: State,
  io: CliIo,
): Promise<IndexedSource[]> {
  const installed = await installedSources(state, io);
  return [
    ...installed.filter(
      (source) => !siblings.some((sibling) => sibling.request.key === source.key),
    ),
    ...siblings.map((sibling) => ({
      key: sibling.request.key,
      addedAt: io.now().toISOString(),
      intent: { select: sibling.request.select, rename: sibling.request.rename },
      names: sibling.memories.map((memory) => memory.name),
    })),
  ];
}

// The prompt answers per LOCAL name; the map is keyed by upstream name, so an answer for a
// memory already renamed once replaces that memory's entry rather than adding a second hop.
function withAnswers(
  rename: RenameMap,
  answers: Extract<RenameAnswer, { kind: "renamed" }>["rename"],
  chosen: readonly Memory[],
): RenameMap {
  let next = rename;
  for (const [local, to] of Object.entries(answers)) {
    const upstream = chosen.find((memory) => renamed(next, memory.name) === local);
    if (upstream !== undefined) next = { ...next, [upstream.name]: to };
  }
  return next;
}

// Collisions are answered by renames until the incoming set resolves. A repin is refused outright,
// and a declined prompt refuses on the first collision.
async function resolveRenames(
  request: AddRequest,
  chosen: readonly Memory[],
  installed: IndexedSource[],
  installedNames: Set<string>,
  state: State,
  console: Console,
): Promise<RenameMap> {
  let rename: RenameMap = { ...request.rename };
  for (;;) {
    const outcome = resolveIncoming({
      source: request.key,
      memories: chosen.map((memory) => ({
        name: memory.name,
        description: memory.description,
        contentHash: memory.contentHash,
      })),
      select: "*",
      rename,
      rule: request.rule,
      cap: request.cap,
      installed,
    });
    if (outcome.ok) return rename;
    if (outcome.code === ExitCode.RuleCapExceeded) throw ruleCapRefusal(request.key, outcome);
    const { collisions } = outcome;
    const owners = [...new Set(collisions.map((collision) => collision.ownedBy))];
    const repin = repinRefusal(request.from, owners, state);
    if (repin !== null) throw repin;
    const taken = new Set<string>(installedNames);
    for (const memory of chosen) taken.add(renamed(rename, memory.name));
    const answer = await promptRenames(console, collisions, renameSuffix(request.from), taken);
    if (answer.kind === "declined") {
      const [first] = collisions;
      throw new MaximsError(ExitCode.NameCollision, ownedBy(first.name, first.ownedBy), {
        hint: renameHint(first.name),
      });
    }
    rename = withAnswers(rename, answer.rename, chosen);
  }
}

export async function validate(
  request: AddRequest,
  chosen: readonly Memory[],
  state: State,
  siblings: readonly StagedAdd[],
  ctx: CommandContext,
  console: Console,
): Promise<RenameMap> {
  if (!request.allowHidden) assertNoHiddenCharacters(chosen);
  const installedNames = await installedLocalNames(request, siblings, state, ctx.io);
  assertRenamesKnown(request.rename, chosen);
  assertLinksMet(chosen, installedNames, request.rename);
  const installed = await resolutionIndex(siblings, state, ctx.io);
  return resolveRenames(request, chosen, installed, installedNames, state, console);
}

function renameSuffix(from: SourceFrom): string {
  const tail = sourceSlug(from).split("-").pop();
  return tail === undefined || tail === "" ? "renamed" : tail;
}
