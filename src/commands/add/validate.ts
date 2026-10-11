import type { Console } from "../../console/contract.ts";
import { promptRenames } from "../../console/rename.ts";
import { hiddenCharacter, linksTo, ownedBy, renameHint } from "../../console/strings.ts";
import { DEFAULT_GIT_REF, type SourceFrom } from "../../contracts/source.ts";
import { sourceSlug } from "../../engine/slug.ts";
import { sourceIdentity } from "../../engine/source-key.ts";
import {
  contentHashOf,
  hiddenCharacterLabel,
  hiddenCharacters,
  type Memory,
  renamed,
} from "../../memory/contract.ts";
import { resolveWikilinks } from "../../memory/wikilinks.ts";
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

export async function validate(
  request: AddRequest,
  chosen: readonly Memory[],
  state: State,
  siblings: readonly StagedAdd[],
  ctx: CommandContext,
  console: Console,
): Promise<RenameMap> {
  if (!request.allowHidden) {
    for (const memory of chosen) {
      const hidden = hiddenCharacters(memory.description);
      const first = hidden[0];
      if (first !== undefined) {
        throw new MaximsError(
          ExitCode.NothingResolved,
          hiddenCharacter(memory.name, hiddenCharacterLabel(first), first.index + 1),
          { hint: "pass --allow-hidden to install it anyway" },
        );
      }
    }
  }
  const installedNames = new Set<string>();
  for (const [key, entry] of sourcesHere(state, ctx.io)) {
    if (key === request.key || siblings.some((sibling) => sibling.request.key === key)) continue;
    for (const name of await effectiveNames(entry, ctx.io)) installedNames.add(name);
  }
  for (const sibling of siblings) {
    for (const memory of sibling.chosen) {
      installedNames.add(renamed(sibling.request.rename, memory.name));
    }
  }
  let rename: RenameMap = { ...request.rename };
  const unknownRenames = Object.keys(rename).filter(
    (name) => !chosen.some((memory) => memory.name === name),
  );
  if (unknownRenames.length > 0) {
    throw new MaximsError(
      ExitCode.NothingResolved,
      `--rename names memories the source lacks: ${unknownRenames.join(", ")}`,
    );
  }
  const { unmet } = resolveWikilinks([...chosen], installedNames, rename);
  const firstUnmet = unmet[0];
  if (firstUnmet !== undefined) {
    throw new MaximsError(ExitCode.UnmetDependency, linksTo(firstUnmet.memory, firstUnmet.link), {
      hint: `install a source providing ${firstUnmet.link} first`,
    });
  }
  const installed = [
    ...(await installedSources(state, ctx.io)).filter(
      (source) => !siblings.some((sibling) => sibling.request.key === source.key),
    ),
    ...siblings.map((sibling) => ({
      key: sibling.request.key,
      addedAt: ctx.io.now().toISOString(),
      intent: { select: sibling.request.select, rename: sibling.request.rename },
      names: sibling.memories.map((memory) => memory.name),
    })),
  ];
  for (;;) {
    const outcome = resolveIncoming({
      source: request.key,
      memories: chosen.map((memory) => ({
        name: memory.name,
        description: memory.description,
        contentHash: contentHashOf(memory.raw),
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
    const repin = repinRefusal(
      request.from,
      [...new Set(collisions.map((collision) => collision.ownedBy))],
      state,
    );
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
    // The prompt answers per LOCAL name; the map is keyed by upstream name, so an answer for a
    // memory already renamed once replaces that memory's entry rather than adding a second hop.
    for (const [local, next] of Object.entries(answer.rename)) {
      const upstream = chosen.find((memory) => renamed(rename, memory.name) === local);
      if (upstream !== undefined) rename = { ...rename, [upstream.name]: next };
    }
  }
}

function renameSuffix(from: SourceFrom): string {
  const tail = sourceSlug(from).split("-").pop();
  return tail === undefined || tail === "" ? "renamed" : tail;
}
