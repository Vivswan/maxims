import { readFileSync, statSync } from "node:fs";
import { heldToken } from "../console/strings.ts";
import type { AchievedTier, Scope } from "../harnesses/contract.ts";
import { achievedTier, hasHook } from "../harnesses/hook-writer.ts";
import type { MemoryName } from "../memory/contract.ts";
import { estimateTokens } from "../rulefile/budget.ts";
import { buildNameIndex, type NameIndex } from "../rulefile/dedupe.ts";
import type { Fetched, SourceEntry, State } from "../state/schema.ts";
import { storePathFor } from "../util/home.ts";
import {
  actsHere,
  DEFAULT_COOLDOWN_DAYS,
  type EngineContext,
  harnessContext,
  loadContext,
} from "./shared/context.ts";
import { noDefinitionReason, resolveTargets } from "./shared/destination.ts";
import {
  installedHere,
  isFetchedEntry,
  readInstalledTree,
  retainedNames,
  shortSha,
  staleness,
} from "./shared/engine.ts";
import { pathAbsent } from "./shared/fs-probe.ts";
import { hookedAt, planHookAlone } from "./shared/hooks.ts";
import { readProjectLock } from "./shared/project-lock-io.ts";
import { previewState, reportedUnderJson } from "./shared/report.ts";
import { disabledNames, selectMemories, shortHashOf } from "./shared/select.ts";
import { sourceSlug } from "./shared/slug.ts";
import type {
  EngineIo,
  ListedHarness,
  ListedMemory,
  ListedRename,
  ListedSource,
  ListOptions,
  ListReport,
} from "./types.ts";

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
  io.stdout(options.json ? `${JSON.stringify(report, null, 2)}\n` : renderList(report));
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

async function listState(state: State, ctx: EngineContext, io: EngineIo): Promise<ListReport> {
  const report = emptyReport(ctx);
  if (ctx.configIssue !== null) report.notices.push(`maxims: ${ctx.configIssue}`);
  const loaded: (Loaded & { tree: Awaited<ReturnType<typeof readInstalledTree>> })[] = [];
  for (const key of Object.keys(state.sources).sort()) {
    const entry = state.sources[key];
    if (entry === undefined) continue;
    const storeEntry = storePathFor(ctx.home, entry.intent.from);
    const tree = await readInstalledTree(entry, storeEntry, (line) =>
      report.notices.push(`maxims: ${key}: ${line}`),
    );
    const upstream: MemoryName[] =
      tree.kind === "tree"
        ? selectMemories({
            memories: tree.tree.memories,
            intent: entry.intent,
            installInternal: ctx.env.MAXIMS_INSTALL_INTERNAL === "1",
            disabled: new Set(),
            detailPath: () => "",
          }).ownedUpstreamNames
        : await retainedNames(key, entry, ctx, io);
    loaded.push({ key, entry, storeEntry, upstream, tree });
  }
  // An unreadable source's names are already local (its selection and renames applied), so
  // they enter the index as they are. A rename is judged against the entries that apply together
  // with its source: the user's and its own project's, whichever project the listing runs in.
  const indexes = new Map<string | null, NameIndex>();
  const indexFor = (root: string | null): NameIndex => {
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
  for (const source of loaded) {
    const { key, entry } = source;
    const scope = entry.intent.destination.scope;
    const index = indexFor(
      entry.intent.destination.scope === "project"
        ? entry.intent.destination.root
        : ctx.projectRoot,
    );
    const fetched = isFetchedEntry(entry) ? entry.fetched : undefined;
    // A project entry's switched-off names are its own project's, wherever the listing runs.
    const disabled = disabledNames(
      state,
      scope,
      entry.intent.destination.scope === "project"
        ? entry.intent.destination.root
        : ctx.projectRoot,
    );
    const memories: ListedMemory[] = [];
    if (source.tree.kind === "tree") {
      const selection = selectMemories({
        memories: source.tree.tree.memories,
        intent: entry.intent,
        installInternal: ctx.env.MAXIMS_INSTALL_INTERNAL === "1",
        disabled,
        detailPath: () => "",
      });
      for (const selected of selection.selected) {
        memories.push({
          upstreamName: selected.upstreamName,
          localName: selected.localName,
          shortHash: shortHashOf(selected.memory),
          disabled: false,
        });
      }
      for (const name of selection.disabledDropped) {
        memories.push({ upstreamName: name, localName: name, shortHash: null, disabled: true });
      }
    } else {
      report.notices.push(`maxims: ${key}: ${source.tree.reason}`);
    }
    const renames: ListedRename[] = Object.entries(entry.intent.rename).map(([from, to]) => {
      const owner = [...index.entries()].find(([name, owned]) => name === from && owned !== key);
      return owner === undefined
        ? { upstreamName: from, localName: to, verdict: "unneeded", against: null }
        : { upstreamName: from, localName: to, verdict: "resolves", against: owner[1] };
    });
    const harnesses = await listHarnesses(source, state, ctx, io);
    const tokens: ListedSource["tokens"] = [];
    if (entry.intent.rule) {
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
    }
    const { destination } = entry.intent;
    report.sources.push({
      key,
      scope,
      project:
        destination.scope === "project"
          ? {
              root: destination.root,
              here: destination.root === ctx.projectRoot,
              rootMissing: pathAbsent(destination.root),
            }
          : null,
      shared: entry.intent.shared === true,
      review: entry.intent.review === true,
      held: isFetchedEntry(entry) ? (entry.pending ?? null) : null,
      live: !isFetchedEntry(entry),
      outDir: entry.intent.destination.scope === "out" ? entry.intent.destination.path : null,
      sha: fetched?.sha ?? (source.tree.kind === "tree" ? source.tree.tree.sha : null),
      fetchedAt: fetched?.at ?? null,
      lastError: fetched?.lastError ?? null,
      stale: staleFacts(fetched, ctx.now),
      memories,
      harnesses,
      renames,
      rule: entry.intent.rule,
      tokens,
    });
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
    // A harness with no home at this scope (its config folder absent or a file) has no registry
    // to probe; sync does not touch it either.
    if (hookedAt(state, scope, ctx.projectRoot).includes(id) && skipped?.kind !== "unreachable") {
      const hook = await planHookAlone(def, scope, harnessCtx, true);
      listed.hook = hook.changes.length === 0 ? "ok" : "absent";
    }
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
    return `${def.hook.tierCheck.key} = ${JSON.stringify(def.hook.tierCheck.demotesWhen)}`;
  }
  return "no hook";
}

function staleFacts(fetched: Fetched | undefined, now: Date): ListedSource["stale"] {
  const stale = staleness(fetched, now);
  if (stale === undefined) return null;
  const days = Math.floor((now.getTime() - Date.parse(stale.since)) / (24 * 60 * 60 * 1000));
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

export function renderList(report: ListReport): string {
  const lines: string[] = [...report.notices];
  const order: (Scope | "out")[] = ["project", "global", "out"];
  for (const scope of order) {
    const sources = report.sources.filter((source) => source.scope === scope);
    for (const [position, source] of sources.entries()) {
      if (position === 0) {
        lines.push(
          scope === "out" ? `${SCOPE_HEADERS.out}: ${source.outDir ?? ""}` : SCOPE_HEADERS[scope],
        );
      } else if (scope === "out") {
        lines.push(`${SCOPE_HEADERS.out}: ${source.outDir ?? ""}`);
      }
      lines.push(sourceLine(source));
      if (source.project !== null && !source.project.here) {
        const missing = source.project.rootMissing ? " (project folder missing)" : "";
        lines.push(`  installed for ${source.project.root}${missing}`);
      }
      for (const memory of source.memories) lines.push(memoryLine(memory, scope));
      lines.push(
        `  Agents: ${source.harnesses.map(harnessCell).join(", ")}  Rules: ${source.rule ? "yes" : "no"}`,
      );
      for (const rename of source.renames) {
        lines.push(
          rename.verdict === "resolves"
            ? `  rename ${rename.upstreamName} -> ${rename.localName} still resolves a collision with ${rename.against ?? ""}`
            : `  rename ${rename.upstreamName} -> ${rename.localName} no longer needed (upstream renamed)`,
        );
      }
      for (const token of source.tokens) lines.push(`  ~${token.tokens} tokens in ${token.path}`);
      for (const harness of source.harnesses) {
        if (harness.skipped !== null) lines.push(`  ${harness.id}: skipped (${harness.skipped})`);
      }
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

function sourceLine(source: ListedSource): string {
  const sha = source.sha === null ? "-" : shortSha(source.sha);
  const marks = [
    source.shared ? "shared" : null,
    source.held !== null
      ? heldToken(source.key, source.held.summary.length)
      : source.review
        ? "review"
        : null,
  ]
    .flatMap((mark) => (mark === null ? [] : [`  ${mark}`]))
    .join("");
  if (source.fetchedAt === null) {
    return `${source.key}  ${sha}  ${source.live ? "live" : "not fetched yet"}${marks}`;
  }
  const date = source.fetchedAt.slice(0, "2026-01-01".length);
  const verdict =
    source.stale === null
      ? source.lastError === null
        ? "ok"
        : `ok (last fetch failed: ${source.lastError.kind})`
      : `stale ${source.stale.days}d: ${source.stale.kind}`;
  return `${source.key}  ${sha}  fetched ${date}  ${verdict}${marks}`;
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
  const hook = harness.hook === "not-wanted" ? "" : `, hook ${harness.hook}`;
  return `${harness.id} (${tier}${hook})`;
}
