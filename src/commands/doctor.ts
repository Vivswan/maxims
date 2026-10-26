// Read-only: `doctor` compares what each harness would load against what state asks for and never
// takes the lock or writes. Each `x` line is one harness that will not load a rule the user
// believes is installed, or an unmet `--expect`; the exit code says whether there was any.

import { heldFinding, notDefinedHere } from "../console/strings.ts";
import type { HarnessId } from "../contracts/harness-id.ts";
import { actsHere, harnessContext } from "../engine/context.ts";
import { pathAbsent } from "../engine/fs-probe.ts";
import { type HookStatus, hookStatus, hookStatusText } from "../engine/hooks.ts";
import { RuleFileHeld } from "../engine/rules.ts";
import { disabledNames } from "../engine/select.ts";
import { sourceSlug } from "../engine/slug.ts";
import { findSourceKey } from "../engine/source-key.ts";
import type { CliIo } from "../engine/types.ts";
import type { AchievedTier, HarnessDefinition, Scope } from "../harnesses/contract.ts";
import { rulesDirFrontmatter } from "../harnesses/strategies/rules-dir.ts";
import { type MemoryName, parseMemoryName, renamed } from "../memory/contract.ts";
import { MarkerRefused } from "../rulefile/block.ts";
import { parseRuleBlocks, type RuleBlock } from "../rulefile/blocks.ts";
import type { SourceEntry, State } from "../state/schema.ts";
import { ExitCode } from "../util/exit-codes.ts";
import { readIfPresent } from "../util/fs.ts";
import { homePaths } from "../util/home.ts";
import { jsonDocument } from "../util/json.ts";
import { peekIntent } from "./frame/cli-context.ts";
import { readLastSync } from "./frame/debounce.ts";
import {
  effectiveNames,
  effectiveNamesIfReadable,
  scopeOf,
  targetPath,
  tildify,
} from "./frame/lookup.ts";
import { type Command, type CommandContext, FLAGS, type FlagSpec, usage } from "./frame/options.ts";

type Finding = { kind: "ok" | "warn" | "fail"; text: string };

// What the preamble a rules-dir writer puts before the block is for, when the file lacks it: the
// harness loads the file only on demand (`always-on`), or loads it for every file instead of the
// `--paths` filter (`path-scope`). Null when the writer puts none there.
type Preamble = { ok: true } | { ok: false; lost: "always-on" | "path-scope" } | null;

// A file behind a marker the grammar refuses is held whole, blocks unread: its row is the hold's
// own words, the ones sync prints, with no `present` to judge.
type RuleFileReport = { source: string; path: string } & (
  | { held: null; present: boolean; preamble: Preamble }
  | { held: { message: string; hint: string | null } }
);

type HarnessReport = {
  id: HarnessId;
  scope: Scope;
  ruleFiles: RuleFileReport[];
  hook: HookStatus;
  tier: AchievedTier;
};

type ExpectReport = { name: string; met: boolean; checked: number; missing: string[] };

const DOCTOR_FLAGS: readonly FlagSpec[] = [FLAGS.expect];
const FINDING_SYMBOLS: Record<Finding["kind"], string> = { ok: "ok", warn: "! ", fail: "x " };

// Per source: a project whose folder is gone, and a revision waiting for review. The wait is a
// warning, never a failure: the harness loads exactly what state asks for, the last-good block,
// and the user chose to look before it changes.
function sourceFindings(state: State, here: Here): Finding[] {
  const findings: Finding[] = [];
  for (const [key, entry] of Object.entries(state.sources)) {
    const { destination } = entry.intent;
    if (destination.scope === "project" && pathAbsent(destination.root)) {
      findings.push({
        kind: "warn",
        text: `${key}: project folder ${destination.root} is missing`,
      });
    }
    if ("pending" in entry && entry.pending !== undefined && here(entry)) {
      findings.push({ kind: "warn", text: heldFinding(key, entry.pending.summary.length) });
    }
  }
  return findings;
}

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
    const here = (entry: SourceEntry): boolean => actsHere(entry, io);
    findings.push(...sourceFindings(state, here));
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
    findings.push(lastSync.finding);
    const defaults = `Defaults: rule=${ctx.config.rule === true} addHook=${ctx.config.addHook === true}`;
    const failed = findings.some((finding) => finding.kind === "fail");
    if (ctx.global.json) {
      const body = {
        ok: !failed,
        findings,
        harnesses: reports,
        unresolved,
        expect: expects,
        lastSync: lastSync.age,
        defaults: ctx.config,
      };
      io.stdout.write(jsonDocument(body));
    } else if (!ctx.global.quiet) {
      for (const finding of findings)
        io.stdout.write(`${FINDING_SYMBOLS[finding.kind]}  ${finding.text}\n`);
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

// A file behind a marker the grammar refuses reports the hold; any other reports whether this
// source's block is in it and whether the preamble the harness needs opens it.
function ruleFileReport(
  def: HarnessDefinition,
  scope: Scope,
  key: string,
  entry: SourceEntry,
  path: string,
): RuleFileReport {
  const blocks = ruleBlocks(path);
  if (blocks instanceof RuleFileHeld) {
    return { source: key, path, held: { message: blocks.message, hint: blocks.hint ?? null } };
  }
  return {
    source: key,
    path,
    held: null,
    present: (blocks ?? []).some((block) => block.source === key),
    preamble: preambleCheck(def, scope, entry, readIfPresent(path)),
  };
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
    ruleFiles.push(ruleFileReport(def, scope, key, entry, path));
  }
  const hook = await hookStatus(
    def,
    scope,
    state,
    ctx.io.projectRoot,
    harnessCtx,
    ctx.engine.planHookOnly,
  );
  const tier = await ctx.engine.achievedTier(def, scope, harnessCtx);
  return { id: def.id, scope, ruleFiles, hook, tier };
}

// Null when the file is absent; an empty list when it exists but carries no managed block; the
// hold when a marker in it is one the grammar refuses, since the parser then reads no block of it.
function ruleBlocks(path: string): RuleBlock[] | null | RuleFileHeld {
  const text = readIfPresent(path);
  if (text === null) return null;
  try {
    return parseRuleBlocks(text);
  } catch (error) {
    if (error instanceof MarkerRefused) return new RuleFileHeld(path, error);
    throw error;
  }
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

// What a rule file lacks for this source: the block itself, or the preamble the harness needs to
// load it. A held file is reported once per file, by its caller, not per source.
function ruleFileFailures(
  file: RuleFileReport,
  def: HarnessDefinition,
  scope: Scope,
  shown: string,
): string[] {
  if (file.held !== null) return [];
  if (!file.present) {
    if (def.targets[scope]?.kind === "shared-block") {
      return [`${shown} has no block for ${file.source}`];
    }
    return [`${shown} is missing`];
  }
  if (file.preamble === null || file.preamble.ok) return [];
  if (file.preamble.lost === "always-on") {
    return [`${shown} lacks the frontmatter ${def.displayName} needs to load it every session`];
  }
  return [`${shown} lacks the path filter for --paths; ${def.displayName} loads it for every file`];
}

// A shared file is checked once per source it should carry and reported once as a file: one ok
// line when every block is in place, otherwise a fail line naming each source whose block is not.
function ruleFileFindings(
  files: RuleFileReport[],
  shown: string,
  prefix: string,
  def: HarnessDefinition,
  scope: Scope,
): Finding[] {
  const held = files.find((file) => file.held !== null)?.held ?? null;
  const failed = files.flatMap((file) => ruleFileFailures(file, def, scope, shown));
  // One hold per file, however many sources share it: the hint sits where the hook row puts its fix.
  if (held !== null) {
    failed.push(held.hint === null ? held.message : `${held.message} (${held.hint})`);
  }
  const findings: Finding[] = [];
  for (const what of failed) findings.push({ kind: "fail", text: `${prefix} ${what}` });
  if (failed.length === 0) findings.push({ kind: "ok", text: `${prefix} ${shown}` });
  return findings;
}

function hookFinding(report: HarnessReport, prefix: string): Finding | null {
  const hook = hookStatusText(report.hook);
  if (hook === null) return null;
  if (report.hook === "current") return { kind: "ok", text: `${prefix} ${hook}` };
  const hint =
    typeof report.hook === "object" ? report.hook.hint : "run maxims add <source> --add-hook";
  return { kind: "fail", text: `${prefix} ${hook}${hint === null ? "" : ` (${hint})`}` };
}

function findingsOf(report: HarnessReport, def: HarnessDefinition, userHome: string): Finding[] {
  const prefix = `${def.id}:`;
  const findings: Finding[] = [];
  for (const [path, files] of Map.groupBy(report.ruleFiles, (file) => file.path)) {
    const shown = tildify(path, userHome);
    findings.push(...ruleFileFindings(files, shown, prefix, def, report.scope));
  }
  const hook = hookFinding(report, prefix);
  if (hook !== null) findings.push(hook);
  if (report.tier.tier === 2) {
    findings.push({ kind: "warn", text: `${prefix} tier 2 on this machine` });
  }
  if (report.tier.unreadable !== null) {
    findings.push({ kind: "warn", text: `${prefix} ${report.tier.unreadable}` });
  }
  return findings;
}

type Owner = [key: string, entry: SourceEntry];

// The rule-writing sources acting here whose effective set provides the name; `@owner/repo`
// narrows the candidates to that one source, or to none when it is not installed.
async function expectOwners(
  state: State,
  io: CliIo,
  here: Here,
  owner: string | undefined,
  name: MemoryName,
): Promise<Owner[]> {
  let entries = Object.entries(state.sources);
  if (owner !== undefined) {
    const key = findSourceKey(state, owner);
    entries = key === null ? [] : entries.filter(([candidate]) => candidate === key);
  }
  const owners: Owner[] = [];
  for (const candidate of entries) {
    const [, entry] = candidate;
    if (!entry.intent.rule || !here(entry)) continue;
    if ((await effectiveNames(entry, io)).includes(name)) owners.push(candidate);
  }
  return owners;
}

// Every rule file the owners target is inspected for the line. A harness not defined on this
// machine counts as inspected and missing, since nothing here can say the line is in place.
function inspectRuleFiles(
  owners: Owner[],
  name: MemoryName,
  io: CliIo,
): { checked: number; missing: string[] } {
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
  return { checked, missing };
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
  const owners = await expectOwners(state, io, here, qualified?.[1], name);
  const { checked, missing } = inspectRuleFiles(owners, name, io);
  return { name: raw, met: checked > 0 && missing.length === 0, checked, missing };
}

// A rule line's detail path names the store file at user scope, so it carries the upstream name
// and goes through the rename map; at project scope it names the body, already local. A held file
// has no line anyone read, so it is missing the line like an absent file.
function hasRuleLine(
  blocks: RuleBlock[] | null | RuleFileHeld,
  source: string,
  entry: SourceEntry,
  name: MemoryName,
): boolean {
  if (blocks instanceof RuleFileHeld) return false;
  const local = (upstream: MemoryName): MemoryName =>
    entry.intent.destination.scope === "global" ? renamed(entry.intent.rename, upstream) : upstream;
  return (blocks ?? []).some((b) => b.source === source && b.names.some((n) => local(n) === name));
}

function expectFinding(report: ExpectReport): Finding {
  if (report.met) return { kind: "ok", text: `expect ${report.name}: rule line in place` };
  const where = report.checked === 0 ? "any rule-writing source" : report.missing.join(", ");
  return { kind: "fail", text: `expect ${report.name}: no rule line in ${where}` };
}

function syncAgeText(minutes: number): string {
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `${hours}h ago`;
  return `${Math.round(minutes / 60 / 24)}d ago`;
}

// The age is null when no sync has stamped and when the stamp cannot be read; the finding tells
// the two apart, since a stamp nobody can read is not a machine that never synced.
function lastSyncAge(home: string, now: Date): { age: string | null; finding: Finding } {
  const stamp = readLastSync(homePaths(home));
  if (stamp.kind === "absent")
    return { age: null, finding: { kind: "warn", text: "never synced" } };
  if (stamp.kind === "unreadable") {
    return { age: null, finding: { kind: "warn", text: `last sync unknown: ${stamp.reason}` } };
  }
  const minutes = Math.max(0, Math.round((now.getTime() - stamp.at.getTime()) / 60_000));
  const age = syncAgeText(minutes);
  return { age, finding: { kind: "ok", text: `last sync ${age}` } };
}
