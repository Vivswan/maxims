import { hookRegistered, mcpStubRegistered } from "../../console/strings.ts";
import { parseGitSha } from "../../contracts/git-sha.ts";
import type { HarnessId } from "../../contracts/harness-id.ts";
import { isLiveLocal, type SourceFrom } from "../../contracts/source.ts";
import { harnessContext } from "../../engine/context.ts";
import { swapStoreEntry } from "../../engine/fetch.ts";
import { prunedHooks, withHooks } from "../../engine/hooks.ts";
import type { CliIo, SyncOptions, SyncPreview, SyncReport } from "../../engine/types.ts";
import { HOOK_COMMAND } from "../../harnesses/contract.ts";
import { MCP_SERVER_COMMAND } from "../../harnesses/mcp-stub/register.ts";
import {
  contentHashOf,
  type Memory,
  type MemoryName,
  parseContentHash,
} from "../../memory/contract.ts";
import { materializeLocal } from "../../sources/local.ts";
import type { TreeFile } from "../../sources/tree.ts";
import type { UserConfig } from "../../state/config.ts";
import type { Destination, RenameMap, SourceEntry, State } from "../../state/schema.ts";
import type { ScopeAt } from "../../state/scoped.ts";
import { applyChanges, type Change } from "../../util/change.ts";
import { ExitCode, MaximsError } from "../../util/exit-codes.ts";
import { storePathFor } from "../../util/home.ts";
import { configWrite, updateIntent, withDisabled } from "../frame/cli-context.ts";
import { framed } from "../frame/engine-io.ts";
import { agentsFilter, type CommandContext, commonOptions } from "../frame/options.ts";
import { projectLockChange } from "../frame/project-lock-io.ts";
import type { PreparedAdd } from "./plan.ts";
import type { AddRequest } from "./request.ts";
import type { FetchedFiles } from "./stage.ts";

// The sync that follows a commit never fetches: it plans from what the verb prepared (a fetch, a
// promoted hold, or an intent edit), or from the state as it stands when the verb had nothing to
// do. The verb frames the output, so the engine's own lines go nowhere.
//   --dry-run   plans against the state the commit would have written; the file was left alone
//   --quiet     the frame's silence only: the engine runs an interactive sync, with no debounce and
//               no deferred deletions
export function syncCommitted(
  ctx: CommandContext,
  preview: SyncPreview & { retired?: readonly SourceEntry[] },
  agents: readonly HarnessId[],
): Promise<SyncReport> {
  return framed(ctx.io, (io) => ctx.engine.runSync(committedSyncOptions(ctx, preview, agents), io));
}

function committedSyncOptions(
  ctx: CommandContext,
  preview: SyncPreview & { retired?: readonly SourceEntry[] },
  agents: readonly HarnessId[],
): SyncOptions {
  const retired = preview.retired ?? [];
  return {
    ...commonOptions(ctx.global),
    quiet: false,
    fetch: "none",
    ...agentsFilter(agents),
    ...(retired.length === 0 ? {} : { retired: [...retired] }),
    ...(ctx.global.dryRun ? { preview } : {}),
  };
}

// The plan the edit's sync would make, drawn against the state and store writes as they would land,
// before any of them does. A collision, a cap or a byte budget the engine refuses stops here, so
// the one commit point keeps its promise that a refused install leaves the machine as it was.
export async function admitIntent(
  ctx: CommandContext,
  preview: SyncPreview,
  agents: readonly HarnessId[],
): Promise<void> {
  const options: SyncOptions = {
    ...committedSyncOptions(ctx, preview, agents),
    dryRun: true,
    json: false,
    preview,
  };
  await framed(ctx.io, (io) => ctx.engine.runSync(options, io));
}

// What `sync` registers for a harness under the hook intent at one scope: its session-start hook,
// the stub MCP server where its servers file lives at that scope, or both (amp, devin and pi
// declare a hook and a servers file). A harness with neither has nothing to register there:
// asking is not an error, it is a no-op that is never reported as a registration.
type Registration = "hook" | "mcp" | "hook-and-mcp";
export type HookedHarness = { id: HarnessId; registration: Registration };

function registrable(ids: readonly HarnessId[], io: CliIo, at: ScopeAt): HookedHarness[] {
  const ctx = harnessContext(io);
  const hooked: HookedHarness[] = [];
  for (const id of ids) {
    const def = io.harnesses.find((candidate) => candidate.id === id);
    if (def === undefined) continue;
    const hook = def.hook.kind !== "none";
    const mcp = def.mcp !== undefined && def.mcp.path(at.scope, ctx) !== null;
    if (hook && mcp) hooked.push({ id, registration: "hook-and-mcp" });
    else if (hook) hooked.push({ id, registration: "hook" });
    else if (mcp) hooked.push({ id, registration: "mcp" });
  }
  return hooked;
}

// The frame line per registration, printed by `add` and `install` from here alone.
export function registeredLines(hooked: readonly HookedHarness[], planned: boolean): string[] {
  const hook = hookRegistered(HOOK_COMMAND, planned);
  const mcp = mcpStubRegistered(MCP_SERVER_COMMAND, planned);
  const lines: Record<Registration, string[]> = {
    hook: [hook],
    mcp: [mcp],
    "hook-and-mcp": [hook, mcp],
  };
  return hooked.flatMap(({ registration }) => lines[registration]);
}

// What the commit hands the sync beyond the preview, so the sweep reaches files the new intent no
// longer names.
//   harnesses   those listed now and before, so a re-add that drops one takes its files with it;
//               empty means every harness, which a manifest's disabled names call for, since a
//               name switched off may belong to any project source
//   retired     the previous entries a re-add moved to another destination, whose old folders the
//               sync sweeps
export type CommitOutcome = SyncPreview & {
  notices: string[];
  hooked: HookedHarness[];
  harnesses: HarnessId[];
  retired: SourceEntry[];
};

// `install` passes `writeManifest: false` because the manifest is its input, not a projection of
// its result, and `disabledAtProject` because the names the manifest switches off land in the
// same state document as the sources, so a replay is one write and one sync.
export type CommitOptions = {
  writeManifest: boolean;
  disabledAtProject?: readonly MemoryName[];
};

// Steps 5 and 6: the one durable transition, for one or several prepared sources under one lock.
// The store entries, the manifest projection and the config file ride in the same plan as the
// state write; the caller runs the sync that writes destinations.
export async function commitAdd(
  prepared: readonly PreparedAdd[],
  ctx: CommandContext,
  options: CommitOptions,
): Promise<CommitOutcome> {
  const { io } = ctx;
  const now = io.now().toISOString();
  const hooked = new Map<HarnessId, HookedHarness>();
  const reached = new Set<HarnessId>();
  const retired: SourceEntry[] = [];
  let everyHarness = false;
  let config: UserConfig = { ...ctx.config };
  const update = await updateIntent(
    io.home,
    ctx.global.dryRun,
    async (current) => {
      let state = current.state;
      const changes: Change[] = [];
      let touchesProject = false;
      let configChanged = false;
      for (const item of prepared) {
        const { request, harnesses } = item;
        const previous = state.sources[request.key];
        for (const id of [...(previous?.intent.harnesses ?? []), ...harnesses.ids]) reached.add(id);
        if (
          previous !== undefined &&
          !sameDestination(previous.intent.destination, request.destination)
        ) {
          retired.push(previous);
        }
        const entry = buildEntry(
          request,
          item.rename,
          harnesses.ids,
          item.tree,
          item.recorded,
          now,
          state,
        );
        state = { ...state, sources: { ...state.sources, [request.key]: entry } };
        if (request.addHook && request.destination.scope !== "out") {
          const registrations = registrable(harnesses.ids, io, request.destination);
          state = withHooks(
            state,
            request.destination,
            registrations.map((entry) => entry.id),
          );
          for (const entry of registrations) hooked.set(entry.id, entry);
        }
        changes.push(...storeEntryChanges(request.from, io.home, item.tree.files));
        if (
          previous?.intent.destination.scope === "project" ||
          request.destination.scope === "project"
        ) {
          touchesProject = true;
        }
        if (request.configChanges !== null) {
          config = { ...config, ...request.configChanges };
          configChanged = true;
        }
        if (harnesses.remember) {
          config.lastAgents = harnesses.ids;
          configChanged = true;
        }
      }
      state = prunedHooks(state);
      if (io.projectRoot !== null) {
        const at = { scope: "project", root: io.projectRoot } as const;
        for (const name of options.disabledAtProject ?? []) {
          const edit = withDisabled(state, at, name, true);
          state = edit.state;
          everyHarness ||= edit.changed;
        }
      }
      if (options.writeManifest && touchesProject && io.projectRoot !== null) {
        const lock = await projectLockChange(io.projectRoot, current.state, state, io);
        if (lock !== null) changes.push(lock);
      }
      if (configChanged) changes.push(configWrite(io.home, config));
      await admitIntent(ctx, { state, config, changes }, everyHarness ? [] : [...reached]);
      return { state, changes, notices: [...current.notices] };
    },
    (plan) => applyChanges(plan, { dryRun: ctx.global.dryRun }),
  );
  return {
    state: update.state,
    config,
    changes: update.changes,
    notices: update.notices,
    hooked: [...hooked.values()],
    harnesses: everyHarness ? [] : [...reached],
    retired,
  };
}

function sameDestination(a: Destination, b: Destination): boolean {
  return a.scope === b.scope && (a.scope !== "out" || b.scope !== "out" || a.path === b.path);
}

function storeEntryChanges(from: SourceFrom, home: string, files: readonly TreeFile[]): Change[] {
  if (from.type === "local") return materializeLocal(from, home, [...files]);
  return swapStoreEntry(storePathFor(home, from), [...files]);
}

function buildEntry(
  request: AddRequest,
  rename: RenameMap,
  harnesses: HarnessId[],
  tree: FetchedFiles,
  memories: readonly Memory[],
  now: string,
  state: State,
): SourceEntry {
  const addedAt = state.sources[request.key]?.addedAt ?? now;
  const base = {
    select: request.select,
    rename,
    rule: request.rule,
    destination: request.destination,
    copy: request.copy,
    auth: request.auth,
    harnesses,
    memoryPath: request.memoryPath,
    fullDepth: request.fullDepth,
    ...(request.paths === undefined ? {} : { paths: request.paths }),
    ...(request.allowHidden ? { allowHidden: true } : {}),
    ...(request.shared ? { shared: true as const } : {}),
    ...(request.review ? { review: true as const } : {}),
  };
  const from = request.from;
  const fetchedMemories = Object.fromEntries(
    memories.map((memory) => [
      memory.name,
      { content: contentHashOf(memory.raw), description: contentHashOf(memory.description) },
    ]),
  );
  if (from.type === "local") {
    if (isLiveLocal(from)) return { intent: { from, ...base }, addedAt };
    const sha = parseContentHash(tree.sha);
    if (sha === null) throw badSha(request.key, tree.sha, "a sha256 content hash");
    const fetched = {
      at: now,
      sha,
      memoryPath: tree.memoryPath,
      memories: fetchedMemories,
      lastError: null,
    };
    return { intent: { from: { type: "local", path: from.path }, ...base }, fetched, addedAt };
  }
  const sha = parseGitSha(tree.sha);
  if (sha === null) throw badSha(request.key, tree.sha, "a 40-character commit sha");
  const fetched = {
    at: now,
    sha,
    memoryPath: tree.memoryPath,
    memories: fetchedMemories,
    lastError: null,
  };
  return { intent: { from, ...base }, fetched, addedAt };
}

function badSha(key: string, reported: string, expected: string): MaximsError {
  return new MaximsError(
    ExitCode.SourceUnresolvable,
    `${key}: the resolver reported "${reported}" where ${expected} was expected`,
  );
}
