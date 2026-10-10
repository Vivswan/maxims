import { readdirSync, type Stats, statSync } from "node:fs";
import { dirname, join } from "node:path";
import {
  type HarnessDefinition,
  type Scope,
  type SourceSlug,
  scopeRoot,
  type Target,
} from "../harnesses/contract.ts";
import { achievedTier } from "../harnesses/hook-writer.ts";
import { chooseSelfRefreshSource } from "../harnesses/strategies/once-per-target.ts";
import { assertWithinBudget, planRulesDirWrite } from "../harnesses/strategies/rules-dir.ts";
import { planSharedBlockRemove } from "../harnesses/strategies/shared-block.ts";
import {
  markdownLines,
  ownLineMatcher,
  parseBlocks,
  renderBlock,
  replaceBlock,
} from "../rulefile/block.ts";
import { parseRuleLines, ruleLineName } from "../rulefile/blocks.ts";
import { estimateTokens } from "../rulefile/budget.ts";
import type { ExpansionSyntax, Markers, RuleLine, Staleness } from "../rulefile/types.ts";
import { type Change, editInPlace, lstatOrNullSync } from "../util/change.ts";
import { MaximsError } from "../util/exit-codes.ts";
import {
  assertInsideRoot,
  cannotInspect,
  isAbsent,
  type RootedPath,
  readIfPresent,
  realpathOfExistingPrefix,
} from "../util/fs.ts";
import { agentsAllowed, type EngineContext, harnessContext } from "./context.ts";
import { type HarnessTarget, realKeyOf } from "./destination.ts";
import type { HarnessFilter } from "./types.ts";

export type BlockRequest = {
  key: string;
  sha: string;
  lines: RuleLine[];
  stale: Staleness | undefined;
  // Whether upstream changed this run: a differing block on disk is then the refresh's doing,
  // said once per source by the planner; otherwise it is judged for a local edit.
  refreshed: boolean;
  paths: string[] | undefined;
};

// How maxims holds a file, fixed when the file is first met and agreed by every target that joins
// it: a rules-dir file is written whole, a link at its path included; a shared file is the user's,
// a block kept in it and edited through a link. A file met as one and joined as the other is a
// shared file linked at a rule file, which the engine refuses rather than lets visit order decide.
export type Ownership = "whole" | "shared";

export function ownershipOf(target: Target): Ownership {
  return target.kind === "rules-dir" ? "whole" : "shared";
}

export type RuleFile =
  | {
      kind: "harness";
      owned: Ownership;
      path: RootedPath;
      sourceSlug: SourceSlug | null;
      targets: HarnessTarget[];
      // Links other harnesses read the file by, none of them a reader this run renders for: the
      // file is never deleted under one of them.
      aliases: string[];
      blocks: BlockRequest[];
    }
  | { kind: "out"; path: RootedPath; blocks: BlockRequest[] };

export type RuleFilePlan = {
  writes: Change[];
  removals: Change[];
  notices: string[];
  tokens: { path: string; tokens: number }[];
};

export type RuleFileOptions = {
  // Sources whose block must survive in this file even though this run renders none for them: a
  // collision or a cap failure keeps the last-good block rather than dropping the rules.
  keep: ReadonlySet<string>;
};

// A removal the grammar refuses (`stripBlock`), or a link maxims cannot edit through, holds the
// file whole, since only the user can edit the stray markers or repoint the link. Not a
// `MaximsError`: a catch that classifies write failures must not take the hold for one.
export class RuleFileHeld extends Error {
  readonly hint: string | undefined;

  constructor(
    readonly path: string,
    refusal: MaximsError,
  ) {
    super(refusal.message);
    this.name = "RuleFileHeld";
    this.hint = refusal.hint;
  }
}

// One target file: every block this run renders for it, spliced over whatever the file holds, plus
// the removal of blocks no intent derives any more. Identical output means no change. A block with
// no rule line (every memory of its source disabled at this scope) is rendered by nobody: a
// rules-dir file holding it leaves, and a shared file loses it like a block whose source left.
export async function planRuleFile(
  file: RuleFile,
  options: RuleFileOptions,
): Promise<RuleFilePlan> {
  const notices: string[] = [];
  const tokens: RuleFilePlan["tokens"] = [];
  const { linked, current, rendering, gone, rendered, unreadable } = await renderRuleFile(file);
  for (const line of unreadable) notices.push(`maxims: ${line}`);
  for (const { block, text } of rendered) {
    notices.push(...blockChangeNotices(file.path, block, text, current));
  }
  const writes: Change[] = [];
  const removals: Change[] = [];
  if (ownedWhole(file)) {
    const [entry, ...extra] = rendered;
    if (entry === undefined) {
      if (linked || current !== null) removals.push({ kind: "delete", path: file.path });
      return { writes, removals, notices, tokens };
    }
    if (extra.length > 0) {
      const keys = rendered.map((each) => each.block.key).join(", ");
      throw new Error(`${file.path} is one file for several sources (${keys})`);
    }
    const content =
      file.kind === "out" ? entry.text : rulesDirContent(file, entry.text, entry.block);
    if (content !== current) {
      writes.push({ kind: "write", path: file.path, content });
      tokens.push({ path: file.path, tokens: estimateTokens(content, rendering.markers) });
    }
    return { writes, removals, notices, tokens };
  }
  const targets = file.kind === "harness" ? file.targets : [];
  const [primary] = targets;
  if (primary === undefined || primary.target.kind !== "shared-block") {
    throw new Error(`${file.path} is held as a shared file by no shared-block reader`);
  }
  // One shared file carries a block per source. The blocks are spliced here with the grammar's
  // own splicer (which closes a construct the user left open) and the byte budget is judged once,
  // on the finished text, against every reader of the file: a per-block write would judge the
  // second of two blocks on the text with the first already replaced, and refuse a source that
  // grew while a later one shrank even when the finished file fits.
  const sharedTarget = primary.target;
  // The file is the user's (a symlink into a dotfiles checkout included), so every write edits it
  // where its bytes live; a link maxims cannot follow holds the file whole, since only the user
  // can repoint it. A file the strip leaves blank is deleted, unless any reader reaches it
  // through a link, which is the user's to keep: the blocks leave and the file stays, empty.
  const held = <T>(plan: () => T): T => {
    try {
      return plan();
    } catch (error) {
      if (!(error instanceof MaximsError)) throw error;
      throw new RuleFileHeld(file.path, error);
    }
  };
  const root = scopeRoot(primary.def, primary.scope, primary.ctx);
  const edit = (content: string): Change => held(() => editInPlace(root, file.path)(content));
  const aliases = file.kind === "harness" ? file.aliases : [];
  const aliased = linked || aliases.length > 0 || targets.some((target) => isSymlink(target.path));
  const emptied = (): Change => (aliased ? edit("") : { kind: "delete", path: file.path });
  const remove = (source: string, from: string): Change | undefined =>
    held(
      () =>
        planSharedBlockRemove({
          def: primary.def,
          target: sharedTarget,
          scope: primary.scope,
          ctx: primary.ctx,
          source,
          currentText: from,
        })[0],
    );
  let text = current ?? "";
  for (const entry of rendered) text = replaceBlock(text, entry.block.key, entry.text);
  // A still-installed source whose block renders empty leaves with this run's write, so the
  // budget is judged on the text the harness will load, not on a block about to go.
  for (const block of gone) {
    const change = remove(block.key, text);
    if (change?.kind === "delete") {
      removals.push(emptied());
      return { writes, removals, notices, tokens };
    }
    if (change?.kind === "write") text = change.content;
  }
  if (rendered.length > 0) {
    for (const target of targets) assertWithinBudget(target.def, target.scope, file.path, text);
  }
  if (text !== (current ?? "")) {
    writes.push(edit(text));
    tokens.push({ path: file.path, tokens: estimateTokens(text, rendering.markers) });
  }
  const wanted = new Set([...rendered.map((entry) => entry.block.key), ...options.keep]);
  let stripped = text;
  let blank = false;
  for (const span of parseBlocks(text).blocks) {
    if (wanted.has(span.source) || blank) continue;
    const change = remove(span.source, stripped);
    if (change?.kind === "delete") blank = true;
    else if (change?.kind === "write") stripped = change.content;
  }
  if (blank && current !== null) removals.push(emptied());
  else if (stripped !== text) removals.push(edit(stripped));
  return { writes, removals, notices, tokens };
}

type RenderedFile = {
  linked: boolean;
  current: string | null;
  rendering: Rendering;
  gone: BlockRequest[];
  rendered: { block: BlockRequest; text: string }[];
  // What the tier probes could not read, each with the harness ahead of it, said by the plan.
  unreadable: string[];
};

// The blocks as this run draws them, beside what the file holds. A rule file maxims owns whole is
// always a real file, so a symlink at its path reads as absent and the write that replaces it is
// planned even when the linked content matches. A shared file is the user's, so a link there is
// read through when it reaches a regular file: anything else behind it reads as nothing, and the
// edit that follows refuses the link by name and holds the file.
async function renderRuleFile(file: RuleFile): Promise<RenderedFile> {
  const linked = isSymlink(file.path);
  const current = linked
    ? ownedWhole(file)
      ? null
      : regularFileText(file.path)
    : readIfPresent(file.path);
  const rendering = renderingFor(file);
  const live = file.blocks.filter((block) => block.lines.length > 0);
  const gone = file.blocks.filter((block) => block.lines.length === 0);
  const staleKeys = live.filter((block) => block.stale !== undefined).map((block) => block.key);
  // The tier decides only which stale block carries the self-refresh line, so the harness configs
  // behind it are read only when a block is stale: a file this run renders no block for (a kept
  // block, an orphan strip) must plan on a machine whose config a probe cannot read.
  const probed = staleKeys.length === 0 ? null : await fileTier(file);
  const selfRefresh =
    probed === null ? null : chooseSelfRefreshSource({ tier: probed.tier }, staleKeys);
  const rendered = live.map((block) => ({
    block,
    text: renderBlock({
      source: block.key,
      sha: block.sha,
      lines: block.lines,
      markers: rendering.markers,
      expands: rendering.expands,
      stale: block.stale,
      selfRefresh: block.key === selfRefresh,
    }),
  }));
  return { linked, current, rendering, gone, rendered, unreadable: probed?.unreadable ?? [] };
}

export function ownedWhole(file: RuleFile): boolean {
  return file.kind === "out" || file.owned === "whole";
}

// The sources whose block this run changes in the file: absent from it, or drawn differently
// from the span it holds. Holding any other source cannot make the file smaller.
export async function changingBlocks(file: RuleFile): Promise<string[]> {
  const drawn = await renderRuleFile(file);
  const current = drawn.current ?? "";
  const spans = parseBlocks(current).blocks;
  return drawn.rendered
    .filter(({ block, text }) => {
      const span = spans.find((candidate) => candidate.source === block.key);
      return span === undefined || current.slice(span.start, span.end) !== text;
    })
    .map(({ block }) => block.key);
}

type Rendering = { markers: Markers; expands: ExpansionSyntax[] };

// A file several harnesses read is rendered for the most demanding of them: markers count if any
// counts them, escaping is conservative if any declares no syntax.
function renderingFor(file: RuleFile): Rendering {
  if (file.kind === "out") return { markers: "counted", expands: [] };
  const defs = file.targets.map((target) => target.def);
  const markers: Markers = defs.some((def) => def.markers === "counted") ? "counted" : "stripped";
  const expands = defs.some((def) => def.expands.length === 0)
    ? []
    : [...new Set(defs.flatMap((def) => def.expands))];
  return { markers, expands };
}

// One hooked (tier 1) reader is enough to make the self-refresh line redundant. Every reader is
// probed, so a config one of them could not read is said even when another reader hooks.
async function fileTier(file: RuleFile): Promise<{ tier: 1 | 2; unreadable: string[] }> {
  if (file.kind === "out") return { tier: 1, unreadable: [] };
  let tier: 1 | 2 = 2;
  const unreadable: string[] = [];
  for (const target of file.targets) {
    const probed = await achievedTier(target.def, target.scope, target.ctx);
    if (probed.tier === 1) tier = 1;
    if (probed.unreadable !== null) unreadable.push(`${target.def.id} ${probed.unreadable}`);
  }
  return { tier, unreadable };
}

// The strategy owns the frontmatter and the byte budget; the file it names is `file.path`.
function rulesDirContent(
  file: Extract<RuleFile, { kind: "harness" }>,
  block: string,
  request: BlockRequest,
): string {
  const [primary] = file.targets;
  if (primary === undefined || primary.target.kind !== "rules-dir" || file.sourceSlug === null) {
    return block;
  }
  const [change] = planRulesDirWrite({
    def: primary.def,
    target: primary.target,
    scope: primary.scope,
    ctx: primary.ctx,
    sourceSlug: file.sourceSlug,
    block,
    paths: request.paths,
  });
  return change?.kind === "write" ? change.content : block;
}

// The block on disk is compared with the fresh rendering: a difference not explained by a fetch
// (same sha, same facts) is judged for a hand edit inside the markers, which the regeneration
// discards.
function blockChangeNotices(
  path: string,
  block: BlockRequest,
  rendered: string,
  current: string | null,
): string[] {
  if (current === null || block.refreshed) return [];
  const span = parseBlocks(current).blocks.find((candidate) => candidate.source === block.key);
  if (span === undefined) return [];
  const onDisk = current.slice(span.start, span.end);
  if (onDisk === rendered) return [];
  if (span.sha !== block.sha) return [];
  if (!handEdited(onDisk, rendered, ownLineMatcher(block.key))) return [];
  return [`maxims: local edit in ${path} discarded (the block is regenerated from ${block.key})`];
}

// A rule line for a memory this run does not render, or one this run renders that the file lacks,
// follows an intent change (a memory disabled, deselected or renamed) as readily as a hand
// deletion, so it earns no notice; the regeneration settles both. A rule line is judged as one
// before the own-line test, so a description that opens like the staleness notice never turns on
// how closely that test matches.
function handEdited(
  onDisk: string,
  rendered: string,
  isOwnLine: (line: string) => boolean,
): boolean {
  const renderedLines = new Set(markdownLines(rendered).map((line) => line.text));
  const renderedByName = new Map(parseRuleLines(rendered).map((line) => [line.name, line.text]));
  for (const { text } of markdownLines(onDisk)) {
    if (renderedLines.has(text)) continue;
    const name = ruleLineName(text);
    if (name === null) {
      if (isOwnLine(text)) continue;
      return true;
    }
    const fresh = renderedByName.get(name);
    if (fresh !== undefined && fresh !== text) return true;
  }
  return false;
}

export type RulesDirSweepInput = {
  ctx: EngineContext;
  harnesses: readonly HarnessDefinition[];
  agents: HarnessFilter | undefined;
  scopes: readonly Scope[];
  // Real paths of the rule files this run plans or keeps; a file is compared by its real path
  // too, so a rules directory reached through a symlink agrees with its other spelling.
  planned: ReadonlySet<string>;
  // A directory or file that exists but cannot be inspected is reported here rather than passed
  // over as absent, so a removal that could not finish says so.
  warn: (line: string) => void;
};

// Rule files maxims wrote for an intent that no longer derives them: a file in a rules directory
// this run can reach, carrying a managed block, whose path this run did not plan. A directory
// holding nothing but such files goes with them, so add-then-remove leaves no empty folder.
export function planRulesDirSweep(input: RulesDirSweepInput): Change[] {
  const changes: Change[] = [];
  const harnessCtx = harnessContext(input.ctx);
  for (const def of input.harnesses) {
    if (!agentsAllowed(input.agents, def.id)) continue;
    for (const scope of input.scopes) {
      const target = def.targets[scope];
      if (target === null || target.kind !== "rules-dir") continue;
      const root = scopeRoot(def, scope, harnessCtx);
      const dir = join(root, target.dir);
      let names: string[];
      try {
        names = readdirSync(dir);
      } catch (error) {
        if (!isAbsent(error)) input.warn(`cannot list ${dir}: ${describe(error)}`);
        continue;
      }
      const orphans = names.filter((name) => {
        const path = join(dir, name);
        if (input.planned.has(realKeyOf(path))) return false;
        let text: string | null;
        try {
          text = regularFileText(path);
        } catch (error) {
          input.warn(describe(error));
          return false;
        }
        return text !== null && claimedByMaxims(text);
      });
      if (orphans.length === 0) continue;
      const realDir = realpathOfExistingPrefix(dir);
      const plannedHere = [...input.planned].some((path) => dirname(path) === realDir);
      if (orphans.length === names.length && !plannedHere) {
        changes.push({ kind: "delete", path: assertInsideRoot(root, dir) });
        continue;
      }
      for (const name of orphans) {
        changes.push({ kind: "delete", path: assertInsideRoot(root, join(dir, name)) });
      }
    }
  }
  return changes;
}

// A file at a name maxims derives is ours to remove only while it carries a managed block; the
// user may keep a file of their own at that name once the rules that wrote it are gone.
export function claimedByMaxims(text: string): boolean {
  return parseBlocks(text).blocks.length > 0;
}

export function isSymlink(path: string): boolean {
  return lstatOrNullSync(path)?.isSymbolicLink() === true;
}

// The text of the file at a derived rule-file name, read through a link, for the reads that take
// only a file carrying a managed block (the sweeps, the names a block still reserves). Anything
// there that is not a regular file (a directory or a link to one; a FIFO, whose read would block
// the run) is nobody's rule file and is passed over unread rather than refused: only the
// planner's own read of a file it will write refuses it (`readIfPresent`).
export function regularFileText(path: string): string | null {
  let target: Stats;
  try {
    target = statSync(path);
  } catch (cause) {
    if (isAbsent(cause)) return null;
    throw cannotInspect(path, cause);
  }
  return target.isFile() ? readIfPresent(path) : null;
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
