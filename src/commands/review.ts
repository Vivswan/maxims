import {
  accepted,
  alreadyReviewing,
  heldRevisionAltered,
  heldRevisionGone,
  nothingHeld,
  notReviewing,
  reviewing,
  STRINGS,
  unreviewed,
} from "../console/strings.ts";
import type { Pending, SourceEntry, State } from "../state/schema.ts";
import { applyChanges, type Change } from "../util/change.ts";
import { ExitCode, MaximsError } from "../util/exit-codes.ts";
import { pendingPathFor, storePathFor } from "../util/home.ts";
import { admitIntent, syncCommitted } from "./add.ts";
import { type Intent, loadIntentFor, updateIntent } from "./shared/cli-context.ts";
import { isFetchedEntry } from "./shared/engine.ts";
import {
  diffLines,
  type FetchedEntry,
  fetchedFactsFor,
  memoryFacts,
  swapStoreEntry,
  withoutPending,
} from "./shared/fetch.ts";
import { validateMemoryFiles } from "./shared/memories.ts";
import {
  type Args,
  type Command,
  type CommandContext,
  type FlagSpec,
  usage,
} from "./shared/options.ts";
import { finish } from "./shared/output.ts";
import { findInstalledSource, sourcesHere, storeTree, withIntent } from "./shared/sources.ts";
import type { CliIo } from "./types.ts";

// `review` marks a source as reviewed-before-apply: from then on a refresh is held under pending
// and the last-good block stays until `accept`. `unreview` lifts the mark and applies whatever is
// held, so no source is left with a revision nobody will accept. None of the three prompts.

// `--all` here selects the held sources, not memories or harnesses, so it carries its own summary.
const ACCEPT_ALL: FlagSpec = {
  name: "all",
  kind: "boolean",
  summary: "every source with a revision held for review",
};

type Held = { entry: FetchedEntry; pending: Pending };

function heldOf(entry: SourceEntry): Held | null {
  if (!isFetchedEntry(entry) || entry.pending === undefined) return null;
  return { entry, pending: entry.pending };
}

function entryOrThrow(state: State, key: string): SourceEntry {
  const entry = state.sources[key];
  if (entry === undefined) throw new MaximsError(ExitCode.Usage, `${key} is not installed`);
  return entry;
}

// The positional resolved to its recorded key, with the intent it was found in, read once.
async function namedSource(
  args: Args,
  ctx: CommandContext,
  verb: string,
): Promise<Intent & { key: string }> {
  const positional = args.positionals[0];
  if (positional === undefined) throw usage(`${verb} needs a source`);
  const intent = await loadIntentFor(ctx.io.home, ctx.global.dryRun);
  return { ...intent, key: findInstalledSource(intent.state, positional, ctx.io) };
}

type Acceptance = { entry: SourceEntry; changes: Change[]; line: string; applied: boolean };

// The held revision becomes the fetch record and the store copy in one plan: the same swap a
// refresh lands, plus the pending directory's removal. The recorded sha names the revision as
// fetched, so the tree is accepted only while its diff against the installed record is still
// the one the hold recorded; a tree that is gone or has lost a file is forgotten instead. The
// cooldown still runs from the hold, so `update` is the way to fetch it again, and the line
// says so.
async function acceptHeld(key: string, held: Held, home: string): Promise<Acceptance> {
  const { entry, pending } = held;
  const { from, memoryPath } = entry.intent;
  const pendingEntry = pendingPathFor(home, from);
  const tree = await storeTree(pendingEntry, entry.intent);
  const memories = tree === null ? [] : validateMemoryFiles(tree.files).memories;
  const forgotten = (line: string): Acceptance => ({
    entry: withoutPending(entry),
    changes: [],
    line,
    applied: false,
  });
  if (memories.length === 0) return forgotten(heldRevisionGone(key));
  const found = diffLines(entry.fetched?.memories ?? {}, memoryFacts(memories));
  if (found.join("\n") !== pending.summary.join("\n")) return forgotten(heldRevisionAltered(key));
  const next = fetchedFactsFor(entry, memories, memoryPath, { sha: pending.sha, at: pending.at });
  if (next === null) throw new Error("unreachable: a pending sha carries its variant's brand");
  const files = memories.map((memory) => ({ relPath: memory.relPath, text: memory.text }));
  return {
    entry: next,
    changes: [
      ...swapStoreEntry(storePathFor(home, from), files),
      { kind: "delete", path: pendingEntry },
    ],
    line: accepted(key, pending.summary.length),
    applied: true,
  };
}

type Applied = {
  state: State;
  changes: Change[];
  notices: string[];
  lines: string[];
  // The keys whose held revision landed; a key with nothing held, or whose files were gone, is
  // said in `lines` and not counted.
  accepted: string[];
};

// One state write and one sync for every key: each held revision is accepted, a key with nothing
// held is said so, and `clearReview` lifts the mark as `unreview` asks. The destinations must
// admit what lands before anything is written, as they must for every other intent edit.
async function applyHeld(
  keys: readonly string[],
  ctx: CommandContext,
  clearReview: boolean,
): Promise<Applied> {
  const { io } = ctx;
  const lines: string[] = [];
  const landed: string[] = [];
  const update = await updateIntent(
    io.home,
    ctx.global.dryRun,
    async (current) => {
      let state = current.state;
      const changes: Change[] = [];
      for (const key of keys) {
        const existing = entryOrThrow(state, key);
        const held = heldOf(existing);
        let entry = existing;
        if (held !== null) {
          const acceptance = await acceptHeld(key, held, io.home);
          entry = acceptance.entry;
          changes.push(...acceptance.changes);
          lines.push(acceptance.line);
          if (acceptance.applied) landed.push(key);
        } else if (!clearReview) {
          lines.push(nothingHeld(key));
        }
        if (clearReview) entry = withIntent(entry, ({ review: _lifted, ...rest }) => rest);
        state = { ...state, sources: { ...state.sources, [key]: entry } };
      }
      await admitIntent(ctx, { state, config: ctx.config, changes }, []);
      return { state, changes, notices: [...current.notices] };
    },
    (plan) => applyChanges(plan, { dryRun: ctx.global.dryRun }),
  );
  return {
    state: update.state,
    changes: update.changes,
    notices: update.notices,
    lines,
    accepted: landed,
  };
}

function heldKeys(state: State, io: CliIo): string[] {
  return sourcesHere(state, io)
    .filter(([, entry]) => heldOf(entry) !== null)
    .map(([key]) => key)
    .sort();
}

function heldCount(state: State, key: string): number {
  const entry = state.sources[key];
  const held = entry === undefined ? null : heldOf(entry);
  return held === null ? 0 : held.pending.summary.length;
}

export const review: Command = {
  summary: "hold this source's upstream changes until maxims accept, then sync",
  usage: "review <source>",
  arity: 1,
  flags: [],
  async run(args, ctx) {
    const { io } = ctx;
    const { key } = await namedSource(args, ctx, "review");
    const console = await ctx.openConsole(true);
    let changed = false;
    const update = await updateIntent(
      io.home,
      ctx.global.dryRun,
      async (current) => {
        const existing = entryOrThrow(current.state, key);
        const { from } = existing.intent;
        if (from.type === "local" && from.live === true) {
          throw usage(`${key} is live and read in place; there is no fetch to hold`);
        }
        if (existing.intent.review === true) {
          return { state: current.state, changes: [], notices: [...current.notices] };
        }
        changed = true;
        const entry = withIntent(existing, (fields) => ({ ...fields, review: true }));
        const state = { ...current.state, sources: { ...current.state.sources, [key]: entry } };
        return { state, changes: [], notices: [...current.notices] };
      },
      (plan) => applyChanges(plan, { dryRun: ctx.global.dryRun }),
    );
    const report = await syncCommitted(
      ctx,
      { state: update.state, config: ctx.config, changes: update.changes },
      [],
    );
    return finish(ctx, console, {
      plan: { changes: [...update.changes, ...report.plan.changes], notices: [] },
      notices: [...update.notices, ...report.notices],
      json: { source: key, review: true, accepted: false, held: heldCount(update.state, key) },
      lines: [changed ? reviewing(key) : alreadyReviewing(key)],
    });
  },
};

export const unreview: Command = {
  summary: "let this source's upstream changes apply at once again, accepting any held",
  usage: "unreview <source>",
  arity: 1,
  flags: [],
  async run(args, ctx) {
    const { key, state, notices } = await namedSource(args, ctx, "unreview");
    const console = await ctx.openConsole(true);
    const existing = entryOrThrow(state, key);
    if (existing.intent.review !== true && heldOf(existing) === null) {
      const report = await syncCommitted(ctx, { state, config: ctx.config, changes: [] }, []);
      return finish(ctx, console, {
        plan: report.plan,
        notices: [...notices, ...report.notices],
        json: { source: key, review: false, accepted: false, held: 0 },
        lines: [notReviewing(key)],
      });
    }
    const applied = await applyHeld([key], ctx, true);
    const report = await syncCommitted(
      ctx,
      { state: applied.state, config: ctx.config, changes: applied.changes },
      [],
    );
    return finish(ctx, console, {
      plan: { changes: [...applied.changes, ...report.plan.changes], notices: [] },
      notices: [...applied.notices, ...report.notices],
      json: { source: key, review: false, accepted: applied.accepted.includes(key), held: 0 },
      lines: [...applied.lines, unreviewed(key)],
    });
  },
};

export const accept: Command = {
  summary: "apply the upstream changes held for review, then sync",
  usage: "accept <source>",
  arity: 1,
  flags: [ACCEPT_ALL],
  async run(args, ctx) {
    const { io } = ctx;
    const all = args.flag(ACCEPT_ALL);
    const positional = args.positionals[0];
    if (all && positional !== undefined) throw usage(STRINGS.allWithSource);
    if (!all && positional === undefined) {
      throw usage("accept needs a source", { hint: "maxims accept <source>, or accept --all" });
    }
    const console = await ctx.openConsole(true);
    const { state, notices } = await loadIntentFor(io.home, ctx.global.dryRun);
    const keys = all ? heldKeys(state, io) : [findInstalledSource(state, positional ?? "", io)];
    if (keys.length === 0) {
      return finish(ctx, console, {
        plan: { changes: [], notices: [] },
        notices,
        json: { sources: [], accepted: false, held: 0 },
        lines: [STRINGS.nothingHeld],
      });
    }
    const applied = await applyHeld(keys, ctx, false);
    const report = await syncCommitted(
      ctx,
      { state: applied.state, config: ctx.config, changes: applied.changes },
      [],
    );
    const [key = ""] = keys;
    return finish(ctx, console, {
      plan: { changes: [...applied.changes, ...report.plan.changes], notices: [] },
      notices: [...applied.notices, ...report.notices],
      json: all
        ? { sources: applied.accepted, accepted: applied.accepted.length > 0, held: 0 }
        : {
            source: key,
            review: state.sources[key]?.intent.review === true,
            accepted: applied.accepted.includes(key),
            held: 0,
          },
      lines: applied.lines,
    });
  },
};
