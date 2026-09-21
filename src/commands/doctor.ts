import { existsSync, statSync } from "node:fs";
import { heldFinding, notDefinedHere } from "../console/strings.ts";
import type { HarnessDefinition, HarnessId, Scope } from "../harnesses/contract.ts";
import { rulesDirFrontmatter } from "../harnesses/strategies/rules-dir.ts";
import { type MemoryName, parseMemoryName } from "../memory/contract.ts";
import type { SourceEntry, State } from "../state/schema.ts";
import { ExitCode } from "../util/exit-codes.ts";
import { homePaths } from "../util/home.ts";
import { parseRuleBlocks, type RuleBlock } from "./shared/blocks.ts";
import { peekIntent } from "./shared/cli-context.ts";
import { actsHere } from "./shared/context.ts";
import { pathAbsent, readTextIfPresent } from "./shared/fs-probe.ts";
import { hookedAt } from "./shared/hooks.ts";
import {
  type Command,
  type CommandContext,
  FLAGS,
  type FlagSpec,
  usage,
} from "./shared/options.ts";
import { disabledNames } from "./shared/select.ts";
import { sourceSlug } from "./shared/slug.ts";
import {
  effectiveNames,
  effectiveNamesIfReadable,
  findSourceKey,
  harnessContext,
  localName,
  scopeOf,
  targetPath,
  tildify,
} from "./shared/sources.ts";

type Finding = { kind: "ok" | "warn" | "fail"; text: string };

// What the preamble a rules-dir writer puts before the block is for, when the file lacks it: the
// harness loads the file only on demand (`always-on`), or loads it for every file instead of the
// `--paths` filter (`path-scope`). Null when the writer puts none there.
type Preamble = { ok: true } | { ok: false; lost: "always-on" | "path-scope" } | null;

type RuleFileReport = {
  source: string;
  path: string;
  present: boolean;
  preamble: Preamble;
};

type HarnessReport = {
  id: HarnessId;
  scope: Scope;
  ruleFiles: RuleFileReport[];
  hook: "current" | "missing" | "none" | "not-wanted";
  tier: 1 | 2;
};

type ExpectReport = { name: string; met: boolean; checked: number; missing: string[] };

const DOCTOR_FLAGS: readonly FlagSpec[] = [FLAGS.expect];

// Read-only: `doctor` compares what each harness would load against what state asks for and never
// takes the lock or writes. Each `x` line is one harness that will not load a rule the user
// believes is installed; the exit code says whether there was any.
export const doctor: Command = {
  summary: "check that each harness loads the rule files and hook state asks for",
  usage: "doctor",
  arity: 0,
  flags: DOCTOR_FLAGS,
  async run(args, ctx) {
    const { io } = ctx;
    const { state, notices } = await peekIntent(io.home);
    const findings: Finding[] = notices.map((text) => ({ kind: "warn", text }));
    const unresolved = unresolvedHarnessIds(state, io.harnesses);
    for (const id of unresolved) findings.push({ kind: "warn", text: notDefinedHere(id) });
    for (const [key, entry] of Object.entries(state.sources)) {
      const { destination } = entry.intent;
      if (destination.scope === "project" && pathAbsent(destination.root)) {
        findings.push({
          kind: "warn",
          text: `${key}: project folder ${destination.root} is missing`,
        });
      }
      // A waiting revision is a warning, never a failure: the harness loads exactly what state
      // asks for, the last-good block, and the user chose to look before it changes.
      if ("pending" in entry && entry.pending !== undefined && actsHere(entry, io)) {
        findings.push({ kind: "warn", text: heldFinding(key, entry.pending.summary.length) });
      }
    }
    const here = (entry: SourceEntry): boolean => actsHere(entry, io);
    const reports: HarnessReport[] = [];
    for (const def of io.harnesses) {
      for (const scope of scopesFor(def.id, state, here)) {
        const report = await checkHarness(def, scope, state, ctx, here);
        reports.push(report);
        findings.push(...findingsOf(report, def, io.userHome));
      }
    }
    const expects: ExpectReport[] = [];
    for (const raw of args.list(FLAGS.expect)) {
      const report = await checkExpect(raw, state, ctx, here);
      expects.push(report);
      findings.push(expectFinding(report));
    }
    const lastSync = lastSyncAge(io.home, io.now());
    findings.push(
      lastSync === null
        ? { kind: "warn", text: "never synced" }
        : { kind: "ok", text: `last sync ${lastSync}` },
    );
    const defaults = `Defaults: rule=${ctx.config.rule === true} addHook=${ctx.config.addHook === true}`;
    const failed = findings.some((finding) => finding.kind === "fail");
    if (ctx.global.json) {
      const body = {
        ok: !failed,
        findings,
        harnesses: reports,
        unresolved,
        expect: expects,
        lastSync,
        defaults: ctx.config,
      };
      io.stdout.write(`${JSON.stringify(body, null, 2)}\n`);
    } else if (!ctx.global.quiet) {
      for (const finding of findings) io.stdout.write(`${symbol(finding.kind)}  ${finding.text}\n`);
      io.stdout.write(`${defaults}\n`);
    }
    return failed ? ExitCode.Usage : ExitCode.Ok;
  },
};

// A harness id intent names but no definition answers to: a user-declared harness whose entry
// left harnesses.json. Nothing checks it, so the report says so instead of staying silent.
function unresolvedHarnessIds(state: State, defs: readonly HarnessDefinition[]): HarnessId[] {
  const known = new Set(defs.map((def) => def.id));
  const named = new Set<HarnessId>([
    ...(state.hooks?.global ?? []),
    ...Object.values(state.hooks?.project ?? {}).flat(),
  ]);
  for (const entry of Object.values(state.sources)) {
    for (const id of entry.intent.harnesses) named.add(id);
  }
  return [...named].filter((id) => !known.has(id)).sort();
}

function symbol(kind: Finding["kind"]): string {
  return kind === "ok" ? "ok" : kind === "warn" ? "! " : "x ";
}

// A harness is checked at every scope some intent names it for; a harness nothing names here is
// not reported, since sync wants no hook and no file for it here. `here` says whether an entry
// is this project's or the user's; another project's is not checked from here, since its files
// live under a root this run does not read.
type Here = (entry: SourceEntry) => boolean;

function scopesFor(id: HarnessId, state: State, here: Here): Scope[] {
  const scopes = new Set<Scope>();
  for (const entry of Object.values(state.sources)) {
    if (!entry.intent.harnesses.includes(id) || !here(entry)) continue;
    // An `-o` folder is written under its own naming and registers no hook, as the planner sees it.
    if (entry.intent.destination.scope === "out") continue;
    scopes.add(entry.intent.destination.scope);
  }
  return [...scopes];
}

// A rule file counts as present when the engine's own parser finds this source's managed block in
// it; a shared file that merely mentions the source in prose or a comment does not. An `-o`
// folder is written by the engine under its own file naming and is not checked here, and neither
// is a readable source with no enabled memory at the scope (every one disabled, or none visible):
// the sync writes nothing for it. An unreadable source keeps its last-good file, so it is checked.
async function checkHarness(
  def: HarnessDefinition,
  scope: Scope,
  state: State,
  ctx: CommandContext,
  here: Here,
): Promise<HarnessReport> {
  const harnessCtx = harnessContext(ctx.io);
  const ruleFiles: RuleFileReport[] = [];
  for (const [key, entry] of Object.entries(state.sources)) {
    if (!entry.intent.harnesses.includes(def.id) || !entry.intent.rule || !here(entry)) continue;
    if (scopeOf(entry.intent.destination) !== scope) continue;
    if (entry.intent.destination.scope === "out") continue;
    const disabled = disabledNames(state, scope, ctx.io.projectRoot);
    const names = await effectiveNamesIfReadable(entry, ctx.io);
    if (names?.every((name) => disabled.has(name))) continue;
    const path = targetPath(
      def,
      entry.intent.destination,
      harnessCtx,
      sourceSlug(entry.intent.from),
    );
    if (path === null) continue;
    const blocks = ruleBlocks(path);
    ruleFiles.push({
      source: key,
      path,
      present: (blocks ?? []).some((block) => block.source === key),
      preamble: preambleCheck(def, scope, entry, readTextIfPresent(path)),
    });
  }
  const wanted = hookedAt(state, scope, ctx.io.projectRoot).includes(def.id);
  let hook: HarnessReport["hook"] = "not-wanted";
  if (def.hook.kind === "none") hook = "none";
  else if (wanted) {
    // The hook alone: a pending config edit beside it is not a missing hook.
    const plan = await ctx.engine.planHookAlone(def, scope, harnessCtx, true);
    hook = plan.changes.length === 0 ? "current" : "missing";
  }
  const tier = await ctx.engine.achievedTier(def, scope, harnessCtx);
  return { id: def.id, scope, ruleFiles, hook, tier };
}

// Null when the file is absent; an empty list when it exists but carries no managed block.
function ruleBlocks(path: string): RuleBlock[] | null {
  const text = readTextIfPresent(path);
  return text === null ? null : parseRuleBlocks(text);
}

// The preamble the rules-dir writer puts before the block, fences included, and the file must open
// with exactly it: a rules-dir harness that requires `alwaysApply: true` and does not find it
// loads the file only on demand, and one whose preamble is the `--paths` filter alone loads a bare
// file for every file, both failures `doctor` exists to name.
function preambleCheck(
  def: HarnessDefinition,
  scope: Scope,
  entry: SourceEntry,
  text: string | null,
): Preamble {
  const target = def.targets[scope];
  if (target === null || target.kind !== "rules-dir") return null;
  const declared = rulesDirFrontmatter({
    def,
    target,
    ...(entry.intent.paths === undefined ? {} : { paths: entry.intent.paths }),
  });
  if (declared === "") return null;
  if (text?.startsWith(declared)) return { ok: true };
  return { ok: false, lost: target.frontmatter === undefined ? "path-scope" : "always-on" };
}

function findingsOf(report: HarnessReport, def: HarnessDefinition, userHome: string): Finding[] {
  const findings: Finding[] = [];
  const prefix = `${def.id}:`;
  for (const file of report.ruleFiles) {
    const shown = tildify(file.path, userHome);
    if (!file.present) {
      const what =
        def.targets[report.scope]?.kind === "shared-block"
          ? `${shown} has no block for ${file.source}`
          : `${shown} is missing`;
      findings.push({ kind: "fail", text: `${prefix} ${what}` });
    } else if (file.preamble !== null && !file.preamble.ok) {
      findings.push({
        kind: "fail",
        text:
          file.preamble.lost === "always-on"
            ? `${prefix} ${shown} lacks the frontmatter ${def.displayName} needs to load it every session`
            : `${prefix} ${shown} lacks the path filter for --paths; ${def.displayName} loads it for every file`,
      });
    } else findings.push({ kind: "ok", text: `${prefix} ${shown}` });
  }
  if (report.hook === "current") {
    findings.push({ kind: "ok", text: `${prefix} SessionStart hook current` });
  }
  if (report.hook === "missing") {
    findings.push({
      kind: "fail",
      text: `${prefix} hook missing (run maxims add <source> --add-hook)`,
    });
  }
  if (report.tier === 2) findings.push({ kind: "warn", text: `${prefix} tier 2 on this machine` });
  return findings;
}

// `--expect name` or `--expect @owner/repo/name`: the memory must have a rule line in every rule
// file its source targets; a name two sources provide is checked for each. Met means every
// inspected file carries it AND at least one file was inspected: a source with no rule flag or no
// target is not a passing check.
async function checkExpect(
  raw: string,
  state: State,
  ctx: CommandContext,
  here: Here,
): Promise<ExpectReport> {
  const io = ctx.io;
  const qualified = /^(@.+)\/([a-z0-9-]+)$/.exec(raw);
  const nameRaw = qualified?.[2] ?? raw;
  const name = parseMemoryName(nameRaw);
  if (name === null) throw usage(`--expect "${raw}" is not a memory name or @owner/repo/name`);
  let entries = Object.entries(state.sources);
  if (qualified?.[1] !== undefined) {
    const key = findSourceKey(state, qualified[1]);
    entries = key === null ? [] : entries.filter(([candidate]) => candidate === key);
  }
  const owners: typeof entries = [];
  for (const candidate of entries) {
    const [, entry] = candidate;
    if (!entry.intent.rule || !here(entry)) continue;
    if ((await effectiveNames(entry, io)).includes(name)) owners.push(candidate);
  }
  const harnessCtx = harnessContext(io);
  const missing: string[] = [];
  let checked = 0;
  for (const [key, entry] of owners) {
    if (entry.intent.destination.scope === "out") continue;
    for (const id of entry.intent.harnesses) {
      const def = io.harnesses.find((candidate) => candidate.id === id);
      if (def === undefined) {
        checked += 1;
        missing.push(`${id} (not defined on this machine)`);
        continue;
      }
      const path = targetPath(
        def,
        entry.intent.destination,
        harnessCtx,
        sourceSlug(entry.intent.from),
      );
      if (path === null) continue;
      checked += 1;
      if (!hasRuleLine(ruleBlocks(path), key, entry, name))
        missing.push(tildify(path, io.userHome));
    }
  }
  return { name: raw, met: checked > 0 && missing.length === 0, checked, missing };
}

// A rule line's detail path names the store file at user scope, so it carries the upstream name
// and goes through the rename map; at project scope it names the body, already local.
function hasRuleLine(
  blocks: RuleBlock[] | null,
  source: string,
  entry: SourceEntry,
  name: MemoryName,
): boolean {
  const local = (upstream: MemoryName): MemoryName =>
    entry.intent.destination.scope === "global" ? localName(entry, upstream) : upstream;
  return (blocks ?? []).some((b) => b.source === source && b.names.some((n) => local(n) === name));
}

function expectFinding(report: ExpectReport): Finding {
  if (report.met) return { kind: "ok", text: `expect ${report.name}: rule line in place` };
  const where = report.checked === 0 ? "any rule-writing source" : report.missing.join(", ");
  return { kind: "fail", text: `expect ${report.name}: no rule line in ${where}` };
}

function lastSyncAge(home: string, now: Date): string | null {
  const path = homePaths(home).lastSync;
  if (!existsSync(path)) return null;
  const ageMs = now.getTime() - statSync(path).mtimeMs;
  const minutes = Math.max(0, Math.round(ageMs / 60_000));
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `${hours}h ago`;
  return `${Math.round(hours / 24)}d ago`;
}
