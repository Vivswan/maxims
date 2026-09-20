import { lstatSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { type HarnessDefinition, type Scope, scopeRoot } from "../../harnesses/contract.ts";
import { achievedTier } from "../../harnesses/hook-writer.ts";
import { chooseSelfRefreshSource } from "../../harnesses/strategies/once-per-target.ts";
import { assertWithinBudget, planRulesDirWrite } from "../../harnesses/strategies/rules-dir.ts";
import { planSharedBlockRemove } from "../../harnesses/strategies/shared-block.ts";
import { parseBlocks, renderBlock, replaceBlock } from "../../rulefile/block.ts";
import { estimateTokens } from "../../rulefile/budget.ts";
import type { ExpansionSyntax, Markers, RuleLine, Staleness } from "../../rulefile/types.ts";
import type { Change } from "../../util/change.ts";
import { assertInsideRoot, type RootedPath } from "../../util/fs.ts";
import type { HarnessFilter } from "../types.ts";
import { agentsAllowed, type EngineContext, harnessContext } from "./context.ts";
import { type HarnessTarget, realDirOf, realKeyOf } from "./destination.ts";

export type BlockRequest = {
  key: string;
  sha: string;
  lines: RuleLine[];
  stale: Staleness | undefined;
  // Diff lines for a block whose rule set changed because upstream changed this run; empty when
  // the fetch facts are unchanged, in which case a differing block on disk was a local edit.
  changeLines: string[];
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

// One target file: every block this run renders for it, spliced over whatever the file holds, plus
// the removal of blocks no intent derives any more. Identical output means no change.
export async function planRuleFile(
  file: RuleFile,
  options: RuleFileOptions,
): Promise<RuleFilePlan> {
  const notices: string[] = [];
  const tokens: RuleFilePlan["tokens"] = [];
  // A rule file maxims owns whole is always a real file: a symlink at its path reads as absent so
  // the write that replaces it is planned even when the linked content matches. A shared file is
  // the user's; one they keep as a link (a dotfiles checkout) is left alone rather than replaced
  // by a regular file holding only the blocks.
  const linked = isSymlink(file.path);
  if (linked && file.kind === "harness" && file.targets[0]?.target.kind === "shared-block") {
    return {
      ...EMPTY_PLAN,
      notices: [`maxims: ${file.path} is a symlink; managed blocks are not written through links`],
    };
  }
  const current = linked ? null : readIfPresent(file.path);
  const rendering = await renderingFor(file, options.ctx);
  const staleKeys = file.blocks
    .filter((block) => block.stale !== undefined)
    .map((block) => block.key);
  const selfRefresh = chooseSelfRefreshSource({ tier: rendering.tier }, staleKeys);
  const rendered = file.blocks.map((block) => ({
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
  for (const { block, text } of rendered) {
    notices.push(...blockChangeNotices(file.path, block, text, current));
  }
  const writes: Change[] = [];
  const removals: Change[] = [];
  if (file.kind === "out" || file.targets[0]?.target.kind === "rules-dir") {
    const [entry, ...extra] = rendered;
    if (entry === undefined) return { writes, removals, notices, tokens };
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
  let text = current ?? "";
  for (const entry of rendered) text = replaceBlock(text, entry.block.key, entry.text);
  if (rendered.length > 0) {
    for (const target of file.targets)
      assertWithinBudget(target.def, target.scope, file.path, text);
  }
  if (text !== (current ?? "")) {
    writes.push({ kind: "write", path: file.path, content: text });
    tokens.push({ path: file.path, tokens: estimateTokens(text, rendering.markers) });
  }
  const wanted = new Set([...file.blocks.map((block) => block.key), ...options.keep]);
  let stripped = text;
  let emptied = false;
  for (const span of parseBlocks(text).blocks) {
    if (wanted.has(span.source) || emptied) continue;
    const [change] = planSharedBlockRemove({
      def: primary.def,
      target: primary.target,
      scope: primary.scope,
      ctx: harnessContext(options.ctx),
      source: span.source,
      currentText: stripped,
    });
    if (change?.kind === "delete") emptied = true;
    else if (change?.kind === "write") stripped = change.content;
  }
  if (emptied && current !== null) removals.push({ kind: "delete", path: file.path });
  else if (stripped !== text) removals.push({ kind: "write", path: file.path, content: stripped });
  return { writes, removals, notices, tokens };
}

type Rendering = { markers: Markers; expands: ExpansionSyntax[]; tier: 1 | 2 };

// A file several harnesses read is rendered for the most demanding of them: markers count if any
// counts them, escaping is conservative if any declares no syntax, and one hooked (tier 1) reader
// is enough to make the self-refresh line redundant.
async function renderingFor(file: RuleFile, ctx: EngineContext): Promise<Rendering> {
  if (file.kind === "out") return { markers: "counted", expands: [], tier: 1 };
  const defs = file.targets.map((target) => target.def);
  const markers: Markers = defs.some((def) => def.markers === "counted") ? "counted" : "stripped";
  const expands = defs.some((def) => def.expands.length === 0)
    ? []
    : [...new Set(defs.flatMap((def) => def.expands))];
  const harnessCtx = harnessContext(ctx);
  let tier: 1 | 2 = 2;
  for (const target of file.targets) {
    if ((await achievedTier(target.def, target.scope, harnessCtx)) === 1) tier = 1;
  }
  return { markers, expands, tier };
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

// The block on disk is compared with the fresh rendering: a difference explained by this run's
// fetch is reported as rule-line changes, one not explained by any fetch (same sha, same facts)
// was a hand edit inside the markers, which the regeneration discards.
function blockChangeNotices(
  path: string,
  block: BlockRequest,
  rendered: string,
  current: string | null,
): string[] {
  if (current === null) return block.changeLines;
  const span = parseBlocks(current).blocks.find((candidate) => candidate.source === block.key);
  if (span === undefined) return block.changeLines;
  if (current.slice(span.start, span.end) === rendered) return [];
  if (block.changeLines.length > 0) return block.changeLines;
  if (span.sha !== block.sha) return [];
  return [`maxims: local edit in ${path} discarded (the block is regenerated from ${block.key})`];
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
