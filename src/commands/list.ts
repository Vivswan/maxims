import { readFileSync, statSync } from "node:fs";
import { heldToken } from "../console/strings.ts";
import {
  actsHere,
  DEFAULT_COOLDOWN_DAYS,
  type EngineContext,
  harnessContext,
  loadContext,
} from "../engine/context.ts";
import { noDefinitionReason, resolveTargets } from "../engine/destination.ts";
import { DAY_MS } from "../engine/fetch.ts";
import { pathAbsent } from "../engine/fs-probe.ts";
import { hookStatus, hookStatusText } from "../engine/hooks.ts";
import { installedHere } from "../engine/plan-sync.ts";
import { readProjectLock } from "../engine/project-lock-read.ts";
import type { RuleFileHeld } from "../engine/rules.ts";
import { disabledNames, type SelectInput, selectMemories } from "../engine/select.ts";
import { sourceSlug } from "../engine/slug.ts";
import { isFetchedEntry, shortSha, staleness } from "../engine/sync-refresh.ts";
import { retainedBlockNames, retainedNames } from "../engine/sync-retained.ts";
import { readInstalledTree } from "../engine/sync-trees.ts";
import type {
  EngineIo,
  ListedHarness,
  ListedMemory,
  ListedRename,
  ListedSource,
  ListOptions,
  ListReport,
} from "../engine/types.ts";
import type { AchievedTier, Scope } from "../harnesses/contract.ts";
import { achievedTier, demotionNote, hasHook, planHookOnly } from "../harnesses/hook-writer.ts";
import type { MemoryName } from "../memory/contract.ts";
import { estimateTokens } from "../rulefile/budget.ts";
import { buildNameIndex, type NameIndex, shortHash } from "../rulefile/dedupe.ts";
import type { Fetched, SourceEntry, State } from "../state/schema.ts";
import { realKeyOf } from "../util/fs.ts";
import { storePathFor } from "../util/home.ts";
import { jsonDocument } from "../util/json.ts";
import { previewState, reportedUnderJson } from "./frame/report.ts";

// Read-only: what state asks for, with everything past intent (tier, hook presence, collisions,
// staleness, token cost) re-derived from disk on the spot. Never takes the lock and never settles
// the state file.
export async function runList(options: ListOptions, io: EngineIo): Promise<ListReport> {
  try {
    return await runListChecked(options, io);
  } catch (error) {
    throw reportedUnderJson(error, io, options.json);
  }
}

async function runListChecked(options: ListOptions, io: EngineIo): Promise<ListReport> {
  const ctx = await loadContext(io, { readHookStdin: false });
  const preview = await previewState(ctx.home);
  const report =
    preview.kind === "loaded"
      ? await listState(preview.state, ctx, io)
      : { ...emptyReport(ctx), notices: [preview.line] };
  if (preview.kind !== "loaded") await addLockOnly(report, null, ctx);
  io.stdout(options.json ? jsonDocument(report) : renderList(report));
  return report;
}

function emptyReport(ctx: EngineContext): ListReport {
  return {
    sources: [],
    lockOnly: [],
    defaults: {
      agents: ctx.config.agents ?? null,
      rule: ctx.config.rule ?? false,
      cooldownDays: ctx.config.cooldownDays ?? DEFAULT_COOLDOWN_DAYS,
      ruleCap: ctx.ruleCap,
    },
    notices: [],
  };
}

type Loaded = { key: string; entry: SourceEntry; storeEntry: string; upstream: MemoryName[] };

type LoadedTree = Loaded & { tree: Awaited<ReturnType<typeof readInstalledTree>> };

// Every source in key order with its installed tree and the upstream names it owns. The bodies
// scan stops a run to protect a write; list writes nothing, so a readable source skips it and
// only an unreadable one's bodies are read for its names. A held file is noticed once, however
// many sources share it.
async function loadSources(
  state: State,
  ctx: EngineContext,
  io: EngineIo,
  notices: string[],
): Promise<LoadedTree[]> {
  const loaded: LoadedTree[] = [];
  const heldKeys = new Set<string>();
  const hold = (held: RuleFileHeld): void => {
    const realKey = realKeyOf(held.path);
    if (heldKeys.has(realKey)) return;
    heldKeys.add(realKey);
    notices.push(`maxims: ${held.message}`);
    if (held.hint !== undefined) notices.push(`maxims: ${held.hint}`);
  };
  for (const key of Object.keys(state.sources).sort()) {
    const entry = state.sources[key];
    if (entry === undefined) continue;
    const storeEntry = storePathFor(ctx.home, entry.intent.from);
    const tree = await readInstalledTree(entry, storeEntry, (line) =>
      notices.push(`maxims: ${key}: ${line}`),
    );
    let upstream: MemoryName[];
    if (tree.kind === "tree") {
      retainedBlockNames(key, entry, ctx, io, hold);
      upstream = selectMemories({
        memories: tree.tree.memories,
        intent: entry.intent,
        installInternal: ctx.installInternal,
        disabled: new Set(),
        detailPath: () => "",
      }).ownedUpstreamNames;
    } else {
      upstream = await retainedNames({ key, entry, ctx, io, hold });
    }
    loaded.push({ key, entry, storeEntry, upstream, tree });
  }
  return loaded;
}

// An unreadable source's names are already local (its selection and renames applied), so they
// enter the index as they are. A rename is judged against the entries that apply together with
// its source: the user's and its own project's, whichever project the listing runs in.
function nameIndexFor(loaded: LoadedTree[]): (root: string | null) => NameIndex {
  const indexes = new Map<string | null, NameIndex>();
  return (root) => {
    const known = indexes.get(root);
    if (known !== undefined) return known;
    const index = buildNameIndex(
      loaded
        .filter((source) => actsHere(source.entry, { projectRoot: root }))
        .map((source) => ({
          key: source.key,
          addedAt: source.entry.addedAt,
          intent: source.tree.kind === "tree" ? source.entry.intent : { select: "*", rename: {} },
          names: source.upstream,
        })),
    );
    indexes.set(root, index);
    return index;
  };
}

// The project a source's names and switched-off memories are judged with: its own for a project
// entry, else the one the listing runs in.
function judgedRoot(entry: SourceEntry, ctx: EngineContext): string | null {
  const { destination } = entry.intent;
  return destination.scope === "project" ? destination.root : ctx.projectRoot;
}

function listedMemories(
  memories: SelectInput["memories"],
  entry: SourceEntry,
  ctx: EngineContext,
  disabled: SelectInput["disabled"],
): ListedMemory[] {
  const selection = selectMemories({
    memories,
    intent: entry.intent,
    installInternal: ctx.installInternal,
    disabled,
    detailPath: () => "",
  });
  const listed: ListedMemory[] = [];
  for (const selected of selection.selected) {
    listed.push({
      upstreamName: selected.upstreamName,
      localName: selected.localName,
      shortHash: shortHash(selected.memory.memory.contentHash),
      disabled: false,
    });
  }
  for (const name of selection.disabledDropped) {
    listed.push({ upstreamName: name, localName: name, shortHash: null, disabled: true });
  }
  return listed;
}

// A rename still resolves a collision while another source in the index owns the upstream name;
// without such an owner it is no longer needed.
function listedRenames(entry: SourceEntry, key: string, index: NameIndex): ListedRename[] {
  // `Object.entries` hands the rename map's keys back as plain strings, so the index is read as one.
  const owners: ReadonlyMap<string, string> = index;
  return Object.entries(entry.intent.rename).map(([from, to]) => {
    const owner = owners.get(from);
    if (owner === undefined || owner === key) {
      return { upstreamName: from, localName: to, verdict: "unneeded", against: null };
    }
    return { upstreamName: from, localName: to, verdict: "resolves", against: owner };
  });
}

// The token cost of each rules file the source writes, once per file however many harnesses read it.
function tokenCosts(
  entry: SourceEntry,
  harnesses: ListedHarness[],
  io: EngineIo,
): ListedSource["tokens"] {
  const tokens: ListedSource["tokens"] = [];
  if (!entry.intent.rule) return tokens;
  for (const harness of harnesses) {
    if (harness.rulesFile === null || !harness.rulesPresent) continue;
    if (tokens.some((token) => token.path === harness.rulesFile)) continue;
    const def = io.harnesses.find((candidate) => candidate.id === harness.id);
    const text = readFileSync(harness.rulesFile, "utf8");
    tokens.push({
      path: harness.rulesFile,
      tokens: estimateTokens(text, def?.markers ?? "counted"),
    });
  }
  return tokens;
}

function projectFacts(entry: SourceEntry, ctx: EngineContext): ListedSource["project"] {
  const { destination } = entry.intent;
  if (destination.scope !== "project") return null;
  return {
    root: destination.root,
    here: destination.root === ctx.projectRoot,
    rootMissing: pathAbsent(destination.root),
  };
}

async function listSource(
  source: LoadedTree,
  state: State,
  ctx: EngineContext,
  io: EngineIo,
  indexFor: (root: string | null) => NameIndex,
  notices: string[],
): Promise<ListedSource> {
  const { key, entry } = source;
  const { destination } = entry.intent;
  const root = judgedRoot(entry, ctx);
  const fetched = isFetchedEntry(entry) ? entry.fetched : undefined;
  // A project entry's switched-off names are its own project's, wherever the listing runs.
  const disabled = disabledNames(state, destination.scope, root);
  let memories: ListedMemory[] = [];
  if (source.tree.kind === "tree") {
    memories = listedMemories(source.tree.tree.memories, entry, ctx, disabled);
  } else {
    notices.push(`maxims: ${key}: ${source.tree.reason}`);
  }
  const harnesses = await listHarnesses(source, state, ctx, io);
  return {
    key,
    scope: destination.scope,
    project: projectFacts(entry, ctx),
    shared: entry.intent.shared === true,
    review: entry.intent.review === true,
    held: isFetchedEntry(entry) ? (entry.pending ?? null) : null,
    live: !isFetchedEntry(entry),
    outDir: destination.scope === "out" ? destination.path : null,
    sha: fetched?.sha ?? (source.tree.kind === "tree" ? source.tree.tree.sha : null),
    fetchedAt: fetched?.at ?? null,
    lastError: fetched?.lastError ?? null,
    stale: staleFacts(fetched, ctx.now, ctx.cooldownDays),
    memories,
    harnesses,
    renames: listedRenames(entry, key, indexFor(root)),
    rule: entry.intent.rule,
    tokens: tokenCosts(entry, harnesses, io),
  };
}

async function listState(state: State, ctx: EngineContext, io: EngineIo): Promise<ListReport> {
  const report = emptyReport(ctx);
  if (ctx.configIssue !== null) report.notices.push(`maxims: ${ctx.configIssue}`);
  const loaded = await loadSources(state, ctx, io, report.notices);
  const indexFor = nameIndexFor(loaded);
  for (const source of loaded) {
    report.sources.push(await listSource(source, state, ctx, io, indexFor, report.notices));
  }
  await addLockOnly(report, state, ctx);
  return report;
}

// The lock's sources this machine has not installed, with or without a state file: a fresh
// clone has the lock and nothing else.
async function addLockOnly(report: ListReport, state: State | null, ctx: EngineContext) {
  if (ctx.projectRoot === null) return;
  const lock = await readProjectLock(ctx.projectRoot);
  if (lock.kind === "parsed") {
    report.lockOnly = lock.keys.filter((key) => state === null || !installedHere(state, key, ctx));
  } else if (lock.kind === "corrupt") {
    report.notices.push(`maxims: ${lock.path} could not be read: ${lock.issues.join("; ")}`);
  }
}

async function listHarnesses(
  source: Loaded,
  state: State,
  ctx: EngineContext,
  io: EngineIo,
): Promise<ListedHarness[]> {
  const { entry } = source;
  const harnessCtx = harnessContext(ctx);
  const out: ListedHarness[] = [];
  for (const id of entry.intent.harnesses) {
    const def = io.harnesses.find((candidate) => candidate.id === id);
    const base: ListedHarness = {
      id,
      tier: def?.tier ?? 2,
      tierNote: null,
      hook: "not-wanted",
      rulesFile: null,
      rulesPresent: false,
      skipped: null,
    };
    const scope = entry.intent.destination.scope;
    if (def === undefined) {
      out.push({ ...base, skipped: noDefinitionReason(id) });
      continue;
    }
    if (scope === "out") {
      out.push({ ...base, skipped: "out folder" });
      continue;
    }
    if (!actsHere(entry, ctx)) {
      out.push({ ...base, skipped: "another project" });
      continue;
    }
    const probed = await achievedTier(def, scope, harnessCtx);
    const listed: ListedHarness = { ...base, tier: probed.tier, tierNote: tierNote(def, probed) };
    const resolved = resolveTargets({
      intent: { harnesses: [id] },
      scope,
      sourceSlug: sourceSlug(entry.intent.from),
      ctx,
      harnesses: io.harnesses,
      agents: undefined,
      explicit: [],
    });
    const [target] = resolved.targets;
    const [skipped] = resolved.skipped;
    if (target !== undefined) {
      listed.rulesFile = target.path;
      listed.rulesPresent = fileExists(target.path);
    }
    if (skipped !== undefined) listed.skipped = skipped.reason;
    listed.hook = await hookStatus(def, scope, state, ctx.projectRoot, harnessCtx, planHookOnly);
    out.push(listed);
  }
  return out;
}

function tierNote(
  def: NonNullable<EngineIo["harnesses"][number]>,
  probed: AchievedTier,
): string | null {
  if (probed.unreadable !== null) return probed.unreadable;
  if (probed.tier === 1) return null;
  if (hasHook(def, "registry") && def.hook.tierCheck !== undefined) {
    return demotionNote(def.hook.tierCheck);
  }
  return "no hook";
}

function staleFacts(
  fetched: Fetched | undefined,
  now: Date,
  cooldownDays: number,
): ListedSource["stale"] {
  const stale = staleness(fetched, now, cooldownDays);
  if (stale === undefined) return null;
  const days = Math.floor((now.getTime() - Date.parse(stale.since)) / DAY_MS);
  return { ...stale, days: Math.max(0, days) };
}

function fileExists(path: string): boolean {
  return statSync(path, { throwIfNoEntry: false })?.isFile() === true;
}

const SCOPE_HEADERS: Record<Scope | "out", string> = {
  project: "Project memories",
  global: "Global memories",
  out: "Out",
};

function renameLine(rename: ListedRename): string {
  if (rename.verdict === "resolves") {
    return `  rename ${rename.upstreamName} -> ${rename.localName} still resolves a collision with ${rename.against ?? ""}`;
  }
  return `  rename ${rename.upstreamName} -> ${rename.localName} no longer needed (upstream renamed)`;
}

function agentsLine(source: ListedSource): string {
  const agents = source.harnesses.map(harnessCell).join(", ");
  return `  Agents: ${agents}  Rules: ${source.rule ? "yes" : "no"}`;
}

function sourceLines(source: ListedSource, scope: Scope | "out"): string[] {
  const lines = [sourceLine(source)];
  if (source.project !== null && !source.project.here) {
    const missing = source.project.rootMissing ? " (project folder missing)" : "";
    lines.push(`  installed for ${source.project.root}${missing}`);
  }
  for (const memory of source.memories) lines.push(memoryLine(memory, scope));
  lines.push(agentsLine(source));
  for (const rename of source.renames) lines.push(renameLine(rename));
  for (const token of source.tokens) lines.push(`  ~${token.tokens} tokens in ${token.path}`);
  for (const harness of source.harnesses) {
    if (harness.skipped !== null) lines.push(`  ${harness.id}: skipped (${harness.skipped})`);
  }
  return lines;
}

// Project, then global, then out; a scope heads its first source, and every `-o` source heads
// itself with its folder.
export function renderList(report: ListReport): string {
  const lines: string[] = [...report.notices];
  const order: (Scope | "out")[] = ["project", "global", "out"];
  for (const scope of order) {
    const sources = report.sources.filter((source) => source.scope === scope);
    for (const [position, source] of sources.entries()) {
      if (scope === "out") {
        lines.push(`${SCOPE_HEADERS.out}: ${source.outDir ?? ""}`);
      } else if (position === 0) {
        lines.push(SCOPE_HEADERS[scope]);
      }
      for (const line of sourceLines(source, scope)) lines.push(line);
    }
  }
  for (const key of report.lockOnly) {
    lines.push(`  ${key}: in .agents/maxims.lock, not installed here (run maxims install)`);
  }
  const { defaults } = report;
  lines.push(
    `Defaults: agents=${defaults.agents === null ? "detected" : defaults.agents.join(",")} rule=${defaults.rule} cooldownDays=${defaults.cooldownDays} ruleCap=${defaults.ruleCap}`,
  );
  return `${lines.join("\n")}\n`;
}

function sourceMarks(source: ListedSource): string {
  const marks: string[] = [];
  if (source.shared) marks.push("shared");
  if (source.held !== null) {
    marks.push(heldToken(source.key, source.held.summary.length));
  } else if (source.review) {
    marks.push("review");
  }
  return marks.map((mark) => `  ${mark}`).join("");
}

function fetchVerdict(source: ListedSource): string {
  if (source.stale !== null) return `stale ${source.stale.days}d: ${source.stale.kind}`;
  if (source.lastError !== null) return `ok (last fetch failed: ${source.lastError.kind})`;
  return "ok";
}

function sourceLine(source: ListedSource): string {
  const sha = source.sha === null ? "-" : shortSha(source.sha);
  const marks = sourceMarks(source);
  if (source.fetchedAt === null) {
    return `${source.key}  ${sha}  ${source.live ? "live" : "not fetched yet"}${marks}`;
  }
  const date = source.fetchedAt.slice(0, "2026-01-01".length);
  return `${source.key}  ${sha}  fetched ${date}  ${fetchVerdict(source)}${marks}`;
}

function memoryLine(memory: ListedMemory, scope: string): string {
  if (memory.disabled) return `  ${memory.localName}  disabled (${scope})`;
  const name =
    memory.upstreamName === memory.localName
      ? memory.localName
      : `${memory.upstreamName} -> ${memory.localName}`;
  return `  ${name}  (${memory.shortHash ?? "-"})`;
}

function harnessCell(harness: ListedHarness): string {
  const tier =
    harness.tierNote === null
      ? `tier ${harness.tier}`
      : `tier ${harness.tier}: ${harness.tierNote}`;
  const hook = hookStatusText(harness.hook);
  return `${harness.id} (${tier}${hook === null ? "" : `, ${hook}`})`;
}
