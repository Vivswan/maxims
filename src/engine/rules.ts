import { readdirSync, type Stats, statSync } from "node:fs";
import { dirname, join } from "node:path";
import {
  type HarnessDefinition,
  type Scope,
  type SharedBlockTarget,
  type SourceSlug,
  scopeRoot,
  type Target,
} from "../harnesses/contract.ts";
import { achievedTier } from "../harnesses/hook-writer.ts";
import { chooseSelfRefreshSource } from "../harnesses/strategies/once-per-target.ts";
import { assertWithinBudget, planRulesDirWrite } from "../harnesses/strategies/rules-dir.ts";
import { planSharedBlockRemove } from "../harnesses/strategies/shared-block.ts";
import {
  MarkerRefused,
  markdownLines,
  ownLineMatcher,
  type ParsedBlock,
  parseBlocks,
  renderBlock,
  replaceBlock,
} from "../rulefile/block.ts";
import { parseRuleLines, ruleLineName } from "../rulefile/blocks.ts";
import { estimateTokens } from "../rulefile/budget.ts";
import type { ExpansionSyntax, Markers, RuleLine, Staleness } from "../rulefile/types.ts";
import { type Change, editInPlace } from "../util/change.ts";
import { ExitCode, MaximsError } from "../util/exit-codes.ts";
import {
  assertInsideRoot,
  cannotInspect,
  isAbsent,
  isSymlink,
  type RootedPath,
  readIfPresent,
  realKeyOf,
  realpathOfExistingPrefix,
} from "../util/fs.ts";
import { agentsAllowed, type EngineContext, harnessContext } from "./context.ts";
import type { HarnessTarget } from "./destination.ts";
import type { HarnessFilter } from "./types.ts";

// `refreshed` says whether upstream changed this run: a differing block on disk is then the
// refresh's doing, said once per source by the planner; otherwise it is judged for a local edit.
export type BlockRequest = {
  key: string;
  sha: string;
  lines: RuleLine[];
  stale: Staleness | undefined;
  refreshed: boolean;
  paths: string[] | undefined;
};

// How maxims holds a file, fixed when it is first met and agreed by every target that joins it: a
// rules-dir file is written whole, a link at its path included; a shared file is the user's, a
// block kept in it and edited through a link. Met as one and joined as the other, it is a shared
// file linked at a rule file, refused rather than left to visit order.
export type Ownership = "whole" | "shared";

export function ownershipOf(target: Target): Ownership {
  return target.kind === "rules-dir" ? "whole" : "shared";
}

// `aliases` are the links other harnesses read the file by, none of them a reader this run
// renders for: the file is never deleted under one of them.
export type RuleFile =
  | {
      kind: "harness";
      owned: Ownership;
      path: RootedPath;
      sourceSlug: SourceSlug | null;
      targets: HarnessTarget[];
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

// `keep` names the sources whose block must survive in this file even though this run renders
// none for them: a collision or a cap failure keeps the last-good block rather than dropping the
// rules.
export type RuleFileOptions = {
  keep: ReadonlySet<string>;
};

// A link maxims would edit a user-owned file through (a shared file's, a hook registry's) that
// passes a rule file maxims owns whole. The plan is refused whole: a catch that turns a write
// failure into one harness's failure lets this one through, since the write it would allow is
// the harm.
export class LinkedAtRuleFile extends MaximsError {
  constructor(keys: readonly string[], link: string, ruleFile: string) {
    const named = keys.length === 0 ? "" : `${keys.join(", ")}: `;
    super(
      ExitCode.DestinationWriteFailed,
      `${named}cannot edit ${link}: it is a symlink to ${ruleFile}, a rule file maxims owns whole`,
      { hint: "replace the link with a file of its own, or remove it, then run maxims sync" },
    );
  }
}

// A removal the grammar refuses (`stripBlock`), a link maxims cannot edit through, or a marker it
// does not read (`MarkerRefused`) holds the file whole, since only the user can edit the lines or
// repoint the link. Not a `MaximsError`: a catch that classifies write failures must not take the
// hold for one. A refused removal or link leaves the rules current and fails only the verb that
// asked for it; a refused marker leaves a block no run can refresh, so it names the file and
// fails every verb.
export class RuleFileHeld extends Error {
  readonly hint: string | undefined;
  readonly fails: "remove" | "every verb";

  constructor(
    readonly path: string,
    refusal: MaximsError,
  ) {
    const foreign = refusal instanceof MarkerRefused;
    super(foreign ? `${path}: ${refusal.message}` : refusal.message);
    this.name = "RuleFileHeld";
    this.hint = refusal.hint;
    this.fails = foreign ? "every verb" : "remove";
  }
}

//   spans       -> the blocks the file holds, read once by the scanner in `renderRuleFile`: a
//                  marker it refuses holds the file before any branch of `planReadableRuleFile`
//                  writes or deletes it, since a whole-file write never reads it again
//   unreadable  -> what the tier probes could not read, each with the harness ahead of it, said by
//                  the plan
type RenderedFile = {
  linked: boolean;
  current: string | null;
  spans: ParsedBlock[];
  rendering: Rendering;
  gone: BlockRequest[];
  rendered: { block: BlockRequest; text: string }[];
  unreadable: string[];
};

// A rule file maxims owns whole is always a real file: a link at its path reads as absent, and the
// replacing write is planned even when the linked content matches. A shared file is the user's: a
// link there is read through to a regular file, and anything else behind it reads as nothing, for
// the edit to refuse by name.
function currentText(file: RuleFile, linked: boolean): string | null {
  if (!linked) return readIfPresent(file.path);
  if (ownedWhole(file)) return null;
  return regularFileText(file.path);
}

// The blocks as this run draws them, beside what the file holds.
async function renderRuleFile(file: RuleFile): Promise<RenderedFile> {
  const linked = isSymlink(file.path);
  const current = currentText(file, linked);
  const spans = current === null ? [] : parseBlocks(current).blocks;
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
  return {
    linked,
    current,
    spans,
    rendering,
    gone,
    rendered,
    unreadable: probed?.unreadable ?? [],
  };
}

export function ownedWhole(file: RuleFile): boolean {
  return file.kind === "out" || file.owned === "whole";
}

// The sources whose block this run changes in the file: absent from it, or drawn differently
// from the span it holds. Holding any other source cannot make the file smaller.
export async function changingBlocks(file: RuleFile): Promise<string[]> {
  const drawn = await renderRuleFile(file);
  const current = drawn.current ?? "";
  const spans = drawn.spans;
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
  spans: readonly ParsedBlock[],
): string[] {
  if (current === null || block.refreshed) return [];
  const span = spans.find((candidate) => candidate.source === block.key);
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

//   planned  -> real paths of the rule files this run plans or keeps; a file is compared by its
//               real path too, so a rules directory reached through a symlink agrees with its
//               other spelling
//   warn     -> a directory or file that exists but cannot be inspected is reported here rather
//               than passed over as absent, so a removal that could not finish says so
//   hold     -> a file behind a marker the grammar refuses is left where it is and held, so the
//               run says so and fails like any held file
export type RulesDirSweepInput = {
  ctx: EngineContext;
  harnesses: readonly HarnessDefinition[];
  agents: HarnessFilter | undefined;
  scopes: readonly Scope[];
  planned: ReadonlySet<string>;
  warn: (line: string) => void;
  hold: (held: RuleFileHeld) => void;
};

// A file at a name maxims derives is ours to remove only while it carries a managed block; the
// user may keep a file of their own at that name once the rules that wrote it are gone. A block
// behind a marker the grammar refuses is nobody's to remove: the read throws `MarkerRefused`, and
// the sweep holds the file where it is.
export function claimedByMaxims(text: string): boolean {
  return parseBlocks(text).blocks.length > 0;
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

//   emptied -> the strip that leaves the file blank: the delete, or the empty write when a reader
//              reaches the file through a link
type SharedFileEditor = {
  edit: (content: string) => Change;
  emptied: () => Change;
  remove: (source: string, from: string) => Change | undefined;
};

// A refusal the grammar or the link raises inside `plan` holds the file whole.
function holdingFile<T>(path: string, plan: () => T): T {
  try {
    return plan();
  } catch (error) {
    if (!(error instanceof MaximsError)) throw error;
    throw new RuleFileHeld(path, error);
  }
}

// The file is the user's (a symlink into a dotfiles checkout included), so every write edits it
// where its bytes live; a link maxims cannot follow holds the file whole, since only the user can
// repoint it. A file the strip leaves blank is deleted, unless any reader reaches it through a
// link (`aliased`), which is the user's to keep: the blocks leave and the file stays, empty.
function sharedFileEditor(
  path: RootedPath,
  reader: HarnessTarget,
  target: SharedBlockTarget,
  aliased: boolean,
): SharedFileEditor {
  const root = scopeRoot(reader.def, reader.scope, reader.ctx);
  const edit = (content: string): Change =>
    holdingFile(path, () => editInPlace(root, path)(content));
  const emptied = (): Change => (aliased ? edit("") : { kind: "delete", path });
  const remove = (source: string, from: string): Change | undefined =>
    holdingFile(
      path,
      () =>
        planSharedBlockRemove({
          def: reader.def,
          target,
          scope: reader.scope,
          ctx: reader.ctx,
          source,
          currentText: from,
        })[0],
    );
  return { edit, emptied, remove };
}

// The rendered blocks spliced over the file with the grammar's own splicer (which closes a
// construct the user left open), then the blocks of still-installed sources that render empty
// taken out, so the budget is judged on the text the harness will load, not on a block about to
// go; `null` when such a removal leaves the file blank.
function splicedText(
  current: string,
  drawn: RenderedFile,
  editor: SharedFileEditor,
): string | null {
  let text = current;
  for (const entry of drawn.rendered) text = replaceBlock(text, entry.block.key, entry.text);
  for (const block of drawn.gone) {
    const change = editor.remove(block.key, text);
    if (change?.kind === "delete") return null;
    if (change?.kind === "write") text = change.content;
  }
  return text;
}

// Every block no intent derives any more taken out, each removal planned over the text the one
// before it left. `blank` says a removal left nothing, and `text` is then the strip up to it.
function stripUnwanted(
  text: string,
  wanted: ReadonlySet<string>,
  editor: SharedFileEditor,
): { text: string; blank: boolean } {
  let stripped = text;
  for (const span of parseBlocks(text).blocks) {
    if (wanted.has(span.source)) continue;
    const change = editor.remove(span.source, stripped);
    if (change?.kind === "delete") return { text: stripped, blank: true };
    if (change?.kind === "write") stripped = change.content;
  }
  return { text: stripped, blank: false };
}

// One shared file carries a block per source. The byte budget is judged once, on the finished
// text, against every reader of the file: a per-block write would judge the second of two blocks
// on the text with the first already replaced, and refuse a source that grew while a later one
// shrank even when the finished file fits.
function planSharedFile(
  file: RuleFile,
  drawn: RenderedFile,
  options: RuleFileOptions,
  notices: string[],
): RuleFilePlan {
  const plan: RuleFilePlan = { writes: [], removals: [], notices, tokens: [] };
  const targets = file.kind === "harness" ? file.targets : [];
  const [primary] = targets;
  if (primary === undefined || primary.target.kind !== "shared-block") {
    throw new Error(`${file.path} is held as a shared file by no shared-block reader`);
  }
  const aliases = file.kind === "harness" ? file.aliases : [];
  const aliased =
    drawn.linked || aliases.length > 0 || targets.some((target) => isSymlink(target.path));
  const editor = sharedFileEditor(file.path, primary, primary.target, aliased);
  const current = drawn.current ?? "";
  const text = splicedText(current, drawn, editor);
  if (text === null) {
    plan.removals.push(editor.emptied());
    return plan;
  }
  if (drawn.rendered.length > 0) {
    for (const target of targets) assertWithinBudget(target.def, target.scope, file.path, text);
  }
  if (text !== current) {
    plan.writes.push(editor.edit(text));
    plan.tokens.push({ path: file.path, tokens: estimateTokens(text, drawn.rendering.markers) });
  }
  const wanted = new Set([...drawn.rendered.map((entry) => entry.block.key), ...options.keep]);
  const stripped = stripUnwanted(text, wanted, editor);
  if (stripped.blank && drawn.current !== null) plan.removals.push(editor.emptied());
  else if (stripped.text !== text) plan.removals.push(editor.edit(stripped.text));
  return plan;
}

// A rules-dir file or an `out` file is written whole for its one source, and deleted when it
// renders nothing.
function planWholeFile(file: RuleFile, drawn: RenderedFile, notices: string[]): RuleFilePlan {
  const plan: RuleFilePlan = { writes: [], removals: [], notices, tokens: [] };
  const [entry, ...extra] = drawn.rendered;
  if (entry === undefined) {
    if (drawn.linked || drawn.current !== null) {
      plan.removals.push({ kind: "delete", path: file.path });
    }
    return plan;
  }
  if (extra.length > 0) {
    const keys = drawn.rendered.map((each) => each.block.key).join(", ");
    throw new Error(`${file.path} is one file for several sources (${keys})`);
  }
  const content = file.kind === "out" ? entry.text : rulesDirContent(file, entry.text, entry.block);
  if (content !== drawn.current) {
    plan.writes.push({ kind: "write", path: file.path, content });
    plan.tokens.push({ path: file.path, tokens: estimateTokens(content, drawn.rendering.markers) });
  }
  return plan;
}

function renderNotices(file: RuleFile, drawn: RenderedFile): string[] {
  const notices = drawn.unreadable.map((line) => `maxims: ${line}`);
  for (const { block, text } of drawn.rendered) {
    notices.push(...blockChangeNotices(file.path, block, text, drawn.current, drawn.spans));
  }
  return notices;
}

async function planReadableRuleFile(
  file: RuleFile,
  options: RuleFileOptions,
): Promise<RuleFilePlan> {
  const drawn = await renderRuleFile(file);
  const notices = renderNotices(file, drawn);
  if (ownedWhole(file)) return planWholeFile(file, drawn, notices);
  return planSharedFile(file, drawn, options, notices);
}

// One target file: every block this run renders for it, spliced over whatever the file holds, plus
// the removal of blocks no intent derives any more. Identical output means no change. A block with
// no rule line (every memory of its source disabled at this scope) is rendered by nobody: a
// rules-dir file holding it leaves, and a shared file loses it like a block whose source left.
export async function planRuleFile(
  file: RuleFile,
  options: RuleFileOptions,
): Promise<RuleFilePlan> {
  try {
    return await planReadableRuleFile(file, options);
  } catch (error) {
    if (error instanceof MarkerRefused) throw new RuleFileHeld(file.path, error);
    throw error;
  }
}

// `null` when the directory cannot be listed: an absent one holds nothing, any other failure is
// said.
function listedNames(dir: string, warn: RulesDirSweepInput["warn"]): string[] | null {
  try {
    return readdirSync(dir);
  } catch (error) {
    if (!isAbsent(error)) warn(`cannot list ${dir}: ${describe(error)}`);
    return null;
  }
}

// A file this run did not plan that carries a managed block. One behind a marker the grammar
// refuses is held where it is; one that cannot be inspected is said.
function isOrphan(
  path: string,
  input: Pick<RulesDirSweepInput, "planned" | "warn" | "hold">,
): boolean {
  if (input.planned.has(realKeyOf(path))) return false;
  try {
    const text = regularFileText(path);
    return text !== null && claimedByMaxims(text);
  } catch (error) {
    if (error instanceof MarkerRefused) input.hold(new RuleFileHeld(path, error));
    else input.warn(describe(error));
    return false;
  }
}

// The orphans of one rules directory. A directory holding nothing but orphans goes with them, so
// add-then-remove leaves no empty folder, unless a planned file lands in it.
function sweepRulesDir(root: string, dir: string, input: RulesDirSweepInput): Change[] {
  const names = listedNames(dir, input.warn);
  if (names === null) return [];
  const orphans = names.filter((name) => isOrphan(join(dir, name), input));
  if (orphans.length === 0) return [];
  const realDir = realpathOfExistingPrefix(dir);
  const plannedHere = [...input.planned].some((path) => dirname(path) === realDir);
  if (orphans.length === names.length && !plannedHere) {
    return [{ kind: "delete", path: assertInsideRoot(root, dir) }];
  }
  return orphans.map(
    (name): Change => ({ kind: "delete", path: assertInsideRoot(root, join(dir, name)) }),
  );
}

// Rule files maxims wrote for an intent that no longer derives them: a file in a rules directory
// this run can reach, carrying a managed block, whose path this run did not plan.
export function planRulesDirSweep(input: RulesDirSweepInput): Change[] {
  const changes: Change[] = [];
  const harnessCtx = harnessContext(input.ctx);
  for (const def of input.harnesses) {
    if (!agentsAllowed(input.agents, def.id)) continue;
    for (const scope of input.scopes) {
      const target = def.targets[scope];
      if (target === null || target.kind !== "rules-dir") continue;
      const root = scopeRoot(def, scope, harnessCtx);
      changes.push(...sweepRulesDir(root, join(root, target.dir), input));
    }
  }
  return changes;
}
