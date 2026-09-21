import { lstatSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { type HarnessDefinition, type Scope, scopeRoot } from "../../harnesses/contract.ts";
import { achievedTier } from "../../harnesses/hook-writer.ts";
import { chooseSelfRefreshSource } from "../../harnesses/strategies/once-per-target.ts";
import { assertWithinBudget, planRulesDirWrite } from "../../harnesses/strategies/rules-dir.ts";
import { planSharedBlockRemove } from "../../harnesses/strategies/shared-block.ts";
import {
  markdownLines,
  ownLineMatcher,
  parseBlocks,
  renderBlock,
  replaceBlock,
} from "../../rulefile/block.ts";
import { estimateTokens } from "../../rulefile/budget.ts";
import type { ExpansionSyntax, Markers, RuleLine, Staleness } from "../../rulefile/types.ts";
import type { Change } from "../../util/change.ts";
import { MaximsError } from "../../util/exit-codes.ts";
import { assertInsideRoot, type RootedPath } from "../../util/fs.ts";
import type { HarnessFilter } from "../types.ts";
import { parseRuleLines, ruleLineName } from "./blocks.ts";
import { agentsAllowed, type EngineContext, harnessContext } from "./context.ts";
import { type HarnessTarget, realDirOf, realKeyOf } from "./destination.ts";

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

export type RuleFile =
  | {
      kind: "harness";
      path: RootedPath;
      sourceSlug: string;
      targets: HarnessTarget[];
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
  ctx: EngineContext;
  // Sources whose block must survive in this file even though this run renders none for them: a
  // collision or a cap failure keeps the last-good block rather than dropping the rules.
  keep: ReadonlySet<string>;
};

const EMPTY_PLAN: RuleFilePlan = { writes: [], removals: [], notices: [], tokens: [] };

// A removal the grammar refuses (`stripBlock`) holds the file whole, since only the user can edit
// the stray markers. Not a `MaximsError`: a catch that classifies write failures must not take
// the hold for one.
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
  const drawn = await renderRuleFile(file, options);
  if (drawn === null) {
    // The sweep visits every shared file a harness reads here, wanted or not; a link is only
    // worth a line when the run has a block to write, keep or strip in it.
    if (!hasWork(file, options)) return EMPTY_PLAN;
    return {
      ...EMPTY_PLAN,
      notices: [`maxims: ${file.path} is a symlink; managed blocks are not written through links`],
    };
  }
  const { linked, current, rendering, gone, rendered, unreadable } = drawn;
  for (const line of unreadable) notices.push(`maxims: ${line}`);
  for (const { block, text } of rendered) {
    notices.push(...blockChangeNotices(file.path, block, text, current));
  }
  const writes: Change[] = [];
  const removals: Change[] = [];
  if (file.kind === "out" || file.targets[0]?.target.kind === "rules-dir") {
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
      file.kind === "out"
        ? entry.text
        : rulesDirContent(file, options.ctx, entry.text, entry.block);
    if (content !== current) {
      writes.push({ kind: "write", path: file.path, content });
      tokens.push({ path: file.path, tokens: estimateTokens(content, rendering.markers) });
    }
    return { writes, removals, notices, tokens };
  }
  const [primary] = file.targets;
  if (primary === undefined || primary.target.kind !== "shared-block") {
    return { writes, removals, notices, tokens };
  }
  // One shared file carries a block per source. The strategy writes one block and judges the
  // byte budget on the result, which for the second of two blocks is the text with the first
  // already replaced: a source that grew while a later one shrank would be refused on that
  // intermediate text even when the finished file fits. So the blocks are spliced here with the
  // grammar's own splicer (which closes a construct the user left open, as the strategy does) and
  // the budget is judged once, on the finished text, against every reader of the file.
  const sharedTarget = primary.target;
  const remove = (source: string, from: string): Change | undefined => {
    try {
      return planSharedBlockRemove({
        def: primary.def,
        target: sharedTarget,
        scope: primary.scope,
        ctx: harnessContext(options.ctx),
        source,
        currentText: from,
      })[0];
    } catch (error) {
      if (!(error instanceof MaximsError)) throw error;
      throw new RuleFileHeld(file.path, error);
    }
  };
  let text = current ?? "";
  for (const entry of rendered) text = replaceBlock(text, entry.block.key, entry.text);
  // A still-installed source whose block renders empty leaves with this run's write, so the
  // budget is judged on the text the harness will load, not on a block about to go.
  for (const block of gone) {
    const change = remove(block.key, text);
    if (change?.kind === "delete") {
      removals.push(change);
      return { writes, removals, notices, tokens };
    }
    if (change?.kind === "write") text = change.content;
  }
  if (rendered.length > 0) {
    for (const target of file.targets)
      assertWithinBudget(target.def, target.scope, file.path, text);
  }
  if (text !== (current ?? "")) {
    writes.push({ kind: "write", path: file.path, content: text });
    tokens.push({ path: file.path, tokens: estimateTokens(text, rendering.markers) });
  }
  const wanted = new Set([...rendered.map((entry) => entry.block.key), ...options.keep]);
  let stripped = text;
  let emptied = false;
  for (const span of parseBlocks(text).blocks) {
    if (wanted.has(span.source) || emptied) continue;
    const change = remove(span.source, stripped);
    if (change?.kind === "delete") emptied = true;
    else if (change?.kind === "write") stripped = change.content;
  }
  if (emptied && current !== null) removals.push({ kind: "delete", path: file.path });
  else if (stripped !== text) removals.push({ kind: "write", path: file.path, content: stripped });
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

// The blocks as this run draws them, beside what the file holds. Null for a shared file the user
// keeps as a symlink (a dotfiles checkout): it is left alone rather than replaced by a regular
// file holding only the blocks. A rule file maxims owns whole is always a real file, so a symlink
// at its path reads as absent and the write that replaces it is planned even when the linked
// content matches.
async function renderRuleFile(
  file: RuleFile,
  options: RuleFileOptions,
): Promise<RenderedFile | null> {
  const linked = isSymlink(file.path);
  if (linked && file.kind === "harness" && file.targets[0]?.target.kind === "shared-block") {
    return null;
  }
  const current = linked ? null : readIfPresent(file.path);
  const rendering = renderingFor(file);
  const live = file.blocks.filter((block) => block.lines.length > 0);
  const gone = file.blocks.filter((block) => block.lines.length === 0);
  const staleKeys = live.filter((block) => block.stale !== undefined).map((block) => block.key);
  // The tier decides only which stale block carries the self-refresh line, so the harness configs
  // behind it are read only when a block is stale: a file this run renders no block for (a kept
  // block, an orphan strip) must plan on a machine whose config a probe cannot read.
  const probed = staleKeys.length === 0 ? null : await fileTier(file, options.ctx);
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

// Whether a run has anything to do in a file it cannot write: a block some source renders here,
// one it keeps, or a managed block on disk it would strip.
function hasWork(file: RuleFile, options: RuleFileOptions): boolean {
  if (file.blocks.length > 0 || options.keep.size > 0) return true;
  const current = readIfPresent(file.path);
  return current !== null && parseBlocks(current).blocks.length > 0;
}

// The sources whose block this run changes in the file: absent from it, or drawn differently
// from the span it holds. Holding any other source cannot make the file smaller.
export async function changingBlocks(file: RuleFile, options: RuleFileOptions): Promise<string[]> {
  const drawn = await renderRuleFile(file, options);
  if (drawn === null) return [];
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
async function fileTier(
  file: RuleFile,
  ctx: EngineContext,
): Promise<{ tier: 1 | 2; unreadable: string[] }> {
  if (file.kind === "out") return { tier: 1, unreadable: [] };
  const harnessCtx = harnessContext(ctx);
  let tier: 1 | 2 = 2;
  const unreadable: string[] = [];
  for (const target of file.targets) {
    const probed = await achievedTier(target.def, target.scope, harnessCtx);
    if (probed.tier === 1) tier = 1;
    if (probed.unreadable !== null) unreadable.push(`${target.def.id} ${probed.unreadable}`);
  }
  return { tier, unreadable };
}

// The strategy owns the frontmatter and the byte budget; the file it names is `file.path`.
function rulesDirContent(
  file: Extract<RuleFile, { kind: "harness" }>,
  ctx: EngineContext,
  block: string,
  request: BlockRequest,
): string {
  const [primary] = file.targets;
  if (primary === undefined || primary.target.kind !== "rules-dir") return block;
  const [change] = planRulesDirWrite({
    def: primary.def,
    target: primary.target,
    scope: primary.scope,
    ctx: harnessContext(ctx),
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
        let text: string;
        try {
          text = readFileSync(path, "utf8");
        } catch (error) {
          if (!isAbsent(error)) input.warn(`cannot read ${path}: ${describe(error)}`);
          return false;
        }
        return claimedByMaxims(text);
      });
      if (orphans.length === 0) continue;
      const realDir = realDirOf(dir);
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

function isSymlink(path: string): boolean {
  return lstatSync(path, { throwIfNoEntry: false })?.isSymbolicLink() === true;
}

// Absent means nothing is there; a file that exists but cannot be read propagates, so a plan
// never treats an unreadable destination as empty and writes over it blind.
export function readIfPresent(path: string): string | null {
  try {
    return readFileSync(path, "utf8");
  } catch (error) {
    if (isAbsent(error)) return null;
    throw error;
  }
}

// A directory in the path, or a plain file where a directory was expected, both mean absent.
export function isAbsent(error: unknown): boolean {
  const code = error instanceof Error && "code" in error ? error.code : undefined;
  return code === "ENOENT" || code === "ENOTDIR" || code === "EISDIR";
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
