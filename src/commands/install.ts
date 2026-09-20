import {
  foundInManifest,
  hookRegistered,
  installed,
  linksTo,
  ownedBy,
  renameHint,
  STRINGS,
} from "../console/strings.ts";
import { HOOK_COMMAND } from "../harnesses/contract.ts";
import { resolveWikilinks } from "../memory/wikilinks.ts";
import type { LockSource } from "../state/project-lock.ts";
import { canonicalSourceKey } from "../state/schema.ts";
import { ExitCode, MaximsError } from "../util/exit-codes.ts";
import {
  type AddRequest,
  commitAdd,
  DEFAULT_RULE_CAP,
  hookWanted,
  type PreparedAdd,
  planAdd,
  type StagedAdd,
  stageAdd,
  syncAfterCommit,
} from "./add.ts";
import {
  type Command,
  type CommandContext,
  FLAGS,
  type FlagSpec,
  INTENT_DEFAULTS,
  parseAgents,
  usage,
} from "./shared/options.ts";
import { finish, mergePlans } from "./shared/output.ts";
import { projectLockPath, readProjectLock, sourceFromLock } from "./shared/project-lock-io.ts";
import { effectiveNames, knownHarnessIds, tildify } from "./shared/sources.ts";

const INSTALL_FLAGS: readonly FlagSpec[] = [FLAGS.agent, FLAGS.yes];

// Replays the project's manifest: every entry is prepared (fetched, validated, shown) before any
// is recorded, then all are recorded in one write, the manifest's disabled names are replayed as
// project-scope disables, and one sync runs, so a bad or declined entry leaves the machine and
// the manifest untouched. A rename accepted at one entry's prompt is what the entries planned
// after it validate against. The manifest is how a fresh clone learns what to add; state
// stays the only thing `sync` reads.
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
    const lock = readProjectLock(io.projectRoot);
    console.intro();
    if (lock.kind === "absent") {
      return finish(ctx, console, {
        plan: { changes: [], notices: [] },
        notices: [],
        json: { sources: [], memories: [], harnesses: [] },
        lines: [STRINGS.noManifest],
      });
    }
    const entries = Object.entries(lock.lock.sources);
    console.step(
      foundInManifest(entries.length, tildify(projectLockPath(io.projectRoot), io.userHome)),
    );
    const agentFilter = parseAgents(args, knownHarnessIds(ctx.io));
    const keys = new Map<string, string>();
    for (const [lockKey, entry] of entries) {
      const key = canonicalSourceKey(sourceFromLock(entry, io.projectRoot));
      const twin = keys.get(key);
      if (twin !== undefined) {
        throw usage(`manifest entries ${twin} and ${lockKey} name the same source ${key}`);
      }
      keys.set(key, lockKey);
    }
    const staged: StagedAdd[] = [];
    for (const [, entry] of entries) {
      console.gap();
      const stage = await stageAdd(
        requestFrom(entry, agentFilter, ctx, io.projectRoot),
        ctx,
        console,
      );
      if (stage.kind === "staged") staged.push(stage.staged);
    }
    const prepared: PreparedAdd[] = [];
    const current = [...staged];
    for (const [index, item] of current.entries()) {
      const siblings = current.filter((other) => other !== item);
      const outcome = await planAdd(item, ctx, console, siblings);
      if (outcome.kind === "cancelled") return ExitCode.Ok;
      if (outcome.kind !== "prepared") continue;
      prepared.push(outcome.prepared);
      current[index] = { ...item, request: { ...item.request, rename: outcome.prepared.rename } };
    }
    assertBatchConsistent(prepared, ctx);
    const commit = await commitAdd(prepared, ctx, false);
    for (const name of lock.lock.disabled ?? []) {
      const edit = await ctx.engine.editDisabled(
        {
          scope: "project",
          name,
          disabled: true,
          dryRun: ctx.global.dryRun,
          ...(ctx.global.dryRun ? { base: commit.state } : {}),
        },
        io,
      );
      commit.state = edit.state;
      commit.changes.push(...edit.changes);
    }
    const harnesses = [...new Set(prepared.flatMap((item) => item.harnesses.ids))];
    const names = prepared.flatMap((item) => item.names);
    const report = await ctx.engine.runSync(syncAfterCommit(ctx, commit, harnesses), io);
    const lines = [installed(names.length, report.rules, report.tokens)];
    for (const _ of commit.hooked) lines.push(hookRegistered(HOOK_COMMAND));
    const code = finish(ctx, console, {
      plan: mergePlans({ changes: commit.changes, notices: [] }, report.plan),
      notices: [...commit.notices, ...report.notices],
      json: { sources: prepared.map((item) => item.request.key), memories: names, harnesses },
      lines,
    });
    if (!ctx.global.json && !ctx.global.quiet) console.gap();
    return code;
  },
};

// Entries are planned against each other's names as STAGED; a rename answered at a prompt can
// move a name after a sibling validated against it. The final batch is therefore checked once
// more for distinct local names and for wikilinks, against the names it will really record plus
// the sources outside the batch, before anything is written.
function assertBatchConsistent(prepared: readonly PreparedAdd[], ctx: CommandContext): void {
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
  const outside = new Set<string>();
  const batchKeys = new Set(prepared.map((item) => item.request.key));
  const first = prepared[0];
  if (first !== undefined) {
    for (const [key, entry] of Object.entries(first.staged.sources)) {
      if (batchKeys.has(key)) continue;
      for (const name of effectiveNames(entry, ctx.io)) outside.add(name);
    }
  }
  for (const item of prepared) {
    const others = new Set(outside);
    for (const sibling of prepared) {
      if (sibling !== item) for (const name of sibling.names) others.add(name);
    }
    const { unmet } = resolveWikilinks(item.chosen, others, item.rename);
    const missing = unmet[0];
    if (missing !== undefined) {
      throw new MaximsError(ExitCode.UnmetDependency, linksTo(missing.memory, missing.link), {
        hint: `install a source providing ${missing.link} first`,
      });
    }
  }
}

// The lock carries intent only: a field it omits is one `add` recorded at its default, and the
// entry's `pin` is the ref state records.
function requestFrom(
  source: LockSource,
  agentFilter: ReturnType<typeof parseAgents>,
  ctx: CommandContext,
  projectRoot: string,
): AddRequest {
  const harnesses =
    agentFilter.kind === "ids"
      ? source.harnesses.filter((id) => agentFilter.ids.includes(id))
      : source.harnesses;
  const from = sourceFromLock(source, projectRoot);
  return {
    key: canonicalSourceKey(from),
    from,
    destination: { scope: "project" },
    select: source.select,
    rename: source.rename ?? {},
    rule: source.rule,
    addHook: hookWanted(from, ctx.config.addHook === true),
    copy: source.copy ?? INTENT_DEFAULTS.copy,
    memoryPath: source.memoryPath ?? INTENT_DEFAULTS.memoryPath,
    fullDepth: source.fullDepth ?? INTENT_DEFAULTS.fullDepth,
    paths: source.paths,
    auth: source.auth === true,
    agents: { kind: "ids", ids: harnesses },
    allowHidden: source.allowHidden === true,
    cap: ctx.config.ruleCap ?? DEFAULT_RULE_CAP,
    list: false,
    noFetch: false,
    verbose: ctx.global.verbose,
    configChanges: null,
  };
}
