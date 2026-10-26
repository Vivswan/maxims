// `install` replays the project's manifest, so a bad or declined entry leaves the machine and the
// manifest untouched; state stays the only thing `sync` reads.
//   every entry prepared (fetched, validated, shown) -> all recorded in one write together with the manifest's disabled names -> one sync runs
//
//   a rename accepted at one entry's prompt  -> what the entries planned after it validate against
//   the manifest                             -> how a fresh clone learns what to add

import type { Console } from "../console/contract.ts";
import {
  foundInManifest,
  installed,
  linksTo,
  ownedBy,
  renameHint,
  STRINGS,
} from "../console/strings.ts";
import {
  manifestOrUsage,
  projectLockPath,
  readProjectLock,
  sourceFromLock,
} from "../engine/project-lock-read.ts";
import type { CliIo } from "../engine/types.ts";
import { resolveWikilinks } from "../memory/wikilinks.ts";
import { DEFAULT_RULE_CAP } from "../rulefile/budget.ts";
import type { LockSource } from "../state/project-lock.ts";
import { canonicalSourceKey } from "../state/schema.ts";
import { ExitCode, MaximsError } from "../util/exit-codes.ts";
import { commitAdd, registeredLines, syncCommitted } from "./add/commit.ts";
import { type PreparedAdd, planAdd } from "./add/plan.ts";
import { type AddRequest, hookWanted } from "./add/request.ts";
import { type StagedAdd, stageAdd } from "./add/stage.ts";
import { effectiveNames, knownHarnessIds, sourcesHere, tildify } from "./frame/lookup.ts";
import {
  type Command,
  type CommandContext,
  FLAGS,
  type FlagSpec,
  INTENT_DEFAULTS,
  parseAgents,
  usage,
} from "./frame/options.ts";
import { finish, mergePlans } from "./frame/output.ts";

const INSTALL_FLAGS: readonly FlagSpec[] = [FLAGS.agent, FLAGS.yes, FLAGS.strict];

function assertDistinctSources(entries: [string, LockSource][], projectRoot: string): void {
  const keys = new Map<string, string>();
  for (const [lockKey, entry] of entries) {
    const key = canonicalSourceKey(sourceFromLock(entry, projectRoot));
    const twin = keys.get(key);
    if (twin !== undefined) {
      throw usage(`manifest entries ${twin} and ${lockKey} name the same source ${key}`);
    }
    keys.set(key, lockKey);
  }
}

// Each entry is planned against its siblings as staged, and a rename accepted at one entry's
// prompt is what the entries planned after it validate against. Null when the user cancelled.
async function planEntries(
  staged: readonly StagedAdd[],
  ctx: CommandContext,
  console: Console,
): Promise<PreparedAdd[] | null> {
  const prepared: PreparedAdd[] = [];
  const current = [...staged];
  for (const [index, item] of current.entries()) {
    const siblings = current.filter((other) => other !== item);
    const outcome = await planAdd(item, ctx, console, siblings);
    if (outcome.kind === "cancelled") return null;
    if (outcome.kind !== "prepared") continue;
    prepared.push(outcome.prepared);
    current[index] = { ...item, request: { ...item.request, rename: outcome.prepared.rename } };
  }
  return prepared;
}

export const install: Command = {
  summary: "replay the project manifest: add every source it names, then sync",
  usage: "install",
  arity: 0,
  flags: INSTALL_FLAGS,
  async run(args, ctx) {
    const { io } = ctx;
    if (io.projectRoot === null) {
      throw usage("install needs a project root", { hint: "run inside a git checkout" });
    }
    const console = await ctx.openConsole(args.flag(FLAGS.yes) || ctx.config.yes === true);
    const lock = manifestOrUsage(await readProjectLock(io.projectRoot));
    console.intro();
    if (lock === null) {
      return finish(ctx, console, {
        plan: { changes: [], notices: [] },
        notices: [],
        json: { sources: [], memories: [], harnesses: [] },
        lines: [STRINGS.noManifest],
      });
    }
    const entries = Object.entries(lock.sources);
    console.step(
      foundInManifest(entries.length, tildify(projectLockPath(io.projectRoot), io.userHome)),
    );
    const agentFilter = parseAgents(args, knownHarnessIds(ctx.io));
    const strict = args.flag(FLAGS.strict);
    assertDistinctSources(entries, io.projectRoot);
    const staged: StagedAdd[] = [];
    for (const [, entry] of entries) {
      console.gap();
      const stage = await stageAdd(
        requestFrom(entry, agentFilter, strict, ctx, io.projectRoot),
        ctx,
        console,
      );
      if (stage.kind === "staged") {
        staged.push({ ...stage.staged, disabledByManifest: lock.disabled ?? [] });
      }
    }
    const prepared = await planEntries(staged, ctx, console);
    if (prepared === null) return ExitCode.Ok;
    await assertBatchConsistent(prepared, ctx);
    const commit = await commitAdd(prepared, ctx, {
      writeManifest: false,
      disabledAtProject: lock.disabled ?? [],
    });
    const harnesses = [...new Set(prepared.flatMap((item) => item.harnesses.ids))];
    const names = prepared.flatMap((item) => item.names);
    const report = await syncCommitted(ctx, commit, commit.harnesses);
    const planned = ctx.global.dryRun;
    const lines = [installed(names.length, report.rules, report.tokens, planned)];
    lines.push(...registeredLines(commit.hooked, planned));
    const code = finish(ctx, console, {
      plan: mergePlans({ changes: commit.changes, notices: [] }, report.plan),
      notices: [...commit.notices, ...report.notices],
      json: {
        sources: prepared.map((item) => item.request.key),
        memories: names,
        harnesses,
        warnings: prepared.flatMap((item) => item.warnings),
      },
      lines,
    });
    if (!ctx.global.json && !ctx.global.quiet) console.gap();
    return code;
  },
};

function assertDistinctNames(prepared: readonly PreparedAdd[]): void {
  const owners = new Map<string, string>();
  for (const item of prepared) {
    for (const name of item.names) {
      const owner = owners.get(name);
      if (owner !== undefined && owner !== item.request.key) {
        throw new MaximsError(ExitCode.NameCollision, ownedBy(name, owner), {
          hint: renameHint(name),
        });
      }
      owners.set(name, item.request.key);
    }
  }
}

// The local names installed here by the sources outside the batch.
async function namesOutsideBatch(
  prepared: readonly PreparedAdd[],
  io: CliIo,
): Promise<Set<string>> {
  const outside = new Set<string>();
  const batchKeys = new Set(prepared.map((item) => item.request.key));
  const first = prepared[0];
  if (first === undefined) return outside;
  for (const [key, entry] of sourcesHere(first.staged, io)) {
    if (batchKeys.has(key)) continue;
    for (const name of await effectiveNames(entry, io)) outside.add(name);
  }
  return outside;
}

// Each entry's wikilinks resolve against the names outside the batch plus its siblings' own.
function assertBatchLinksMet(prepared: readonly PreparedAdd[], outside: Set<string>): void {
  for (const item of prepared) {
    const others = new Set(outside);
    for (const sibling of prepared) {
      if (sibling !== item) for (const name of sibling.names) others.add(name);
    }
    const { unmet } = resolveWikilinks(item.chosen, others, item.rename);
    const missing = unmet[0];
    if (missing === undefined) continue;
    throw new MaximsError(ExitCode.UnmetDependency, linksTo(missing.memory, missing.link), {
      hint: `install a source providing ${missing.link} first`,
    });
  }
}

// Entries are planned against each other's names as STAGED; a rename answered at a prompt can
// move a name after a sibling validated against it. The final batch is therefore checked once
// more for distinct local names and for wikilinks, against the names it will really record plus
// the sources outside the batch, before anything is written.
async function assertBatchConsistent(
  prepared: readonly PreparedAdd[],
  ctx: CommandContext,
): Promise<void> {
  assertDistinctNames(prepared);
  const outside = await namesOutsideBatch(prepared, ctx.io);
  assertBatchLinksMet(prepared, outside);
}

// The lock carries intent only: a field it omits is one `add` recorded at its default, and the
// entry's `pin` is the ref state records.
function requestFrom(
  source: LockSource,
  agentFilter: ReturnType<typeof parseAgents>,
  strict: boolean,
  ctx: CommandContext,
  projectRoot: string,
): AddRequest {
  const harnesses =
    agentFilter.kind === "ids"
      ? source.harnesses.filter((id) => agentFilter.ids.includes(id))
      : source.harnesses;
  const from = sourceFromLock(source, projectRoot);
  const destination = { scope: "project", root: projectRoot } as const;
  return {
    key: canonicalSourceKey(from),
    from,
    destination,
    select: source.select,
    rename: source.rename ?? {},
    rule: source.rule,
    addHook: hookWanted(from, destination, ctx.config.addHook === true),
    // An entry came from the lock, so it stays in the lock.
    shared: true,
    copy: source.copy ?? INTENT_DEFAULTS.copy,
    memoryPath: source.memoryPath ?? INTENT_DEFAULTS.memoryPath,
    fullDepth: source.fullDepth ?? INTENT_DEFAULTS.fullDepth,
    paths: source.paths,
    auth: source.auth === true,
    agents: { kind: "ids", ids: harnesses },
    allowHidden: source.allowHidden === true,
    strict,
    // The lock carries install-time intent only; whether to review upstream changes is chosen per
    // machine, with `maxims review`.
    review: false,
    cap: ctx.config.ruleCap ?? DEFAULT_RULE_CAP,
    list: false,
    noFetch: false,
    verbose: ctx.global.verbose,
    configChanges: null,
  };
}
