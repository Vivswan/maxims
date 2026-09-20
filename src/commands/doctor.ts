import { existsSync, statSync } from "node:fs";
import type { HarnessDefinition, HarnessId, Scope } from "../harnesses/contract.ts";
import { type MemoryName, parseMemoryName } from "../memory/contract.ts";
import type { SourceEntry, State } from "../state/schema.ts";
import { ExitCode } from "../util/exit-codes.ts";
import { homePaths } from "../util/home.ts";
import { loadIntent } from "./shared/cli-context.ts";
import { readTextIfPresent } from "./shared/fs-probe.ts";
import {
  type Command,
  type CommandContext,
  FLAGS,
  type FlagSpec,
  usage,
} from "./shared/options.ts";
import {
  effectiveNames,
  findSourceKey,
  harnessContext,
  scopeOf,
  sourceSlug,
  targetPath,
  tildify,
} from "./shared/sources.ts";
import type { RuleBlock } from "./types.ts";

type Finding = { level: "ok" | "warn" | "fail"; text: string };

type RuleFileReport = {
  source: string;
  path: string;
  present: boolean;
  frontmatter: boolean | null;
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
    const { state, notices } = await loadIntent(io.home);
    const findings: Finding[] = notices.map((text) => ({ level: "warn", text }));
    const reports: HarnessReport[] = [];
    for (const def of io.harnesses) {
      for (const scope of scopesFor(def.id, state, io.projectRoot)) {
        const report = await checkHarness(def, scope, state, ctx);
        reports.push(report);
        findings.push(...findingsOf(report, def, io.userHome));
      }
    }
    const expects: ExpectReport[] = [];
    for (const raw of args.list(FLAGS.expect)) {
      const report = checkExpect(raw, state, ctx);
      expects.push(report);
      findings.push(expectFinding(report));
    }
    const lastSync = lastSyncAge(io.home, io.now());
    findings.push(
      lastSync === null
        ? { level: "warn", text: "never synced" }
        : { level: "ok", text: `last sync ${lastSync}` },
    );
    const defaults = `Defaults: rule=${ctx.config.rule === true} addHook=${ctx.config.addHook === true}`;
    const failed = findings.some((finding) => finding.level === "fail");
    if (ctx.global.json) {
      const body = {
        ok: !failed,
        harnesses: reports,
        expect: expects,
        lastSync,
        defaults: ctx.config,
      };
      io.stdout.write(`${JSON.stringify(body, null, 2)}\n`);
    } else if (!ctx.global.quiet) {
      for (const finding of findings)
        io.stdout.write(`${symbol(finding.level)}  ${finding.text}\n`);
      io.stdout.write(`${defaults}\n`);
    }
    return failed ? ExitCode.Usage : ExitCode.Ok;
  },
};

function symbol(level: Finding["level"]): string {
  return level === "ok" ? "ok" : level === "warn" ? "! " : "x ";
}

// A harness is checked at every scope some intent names it for, and at the user scope when only
// a hook names it; a harness nothing names is not reported, since it should be loading nothing.
function scopesFor(id: HarnessId, state: State, projectRoot: string | null): Scope[] {
  const scopes = new Set<Scope>();
  for (const entry of Object.values(state.sources)) {
    if (!entry.intent.harnesses.includes(id)) continue;
    const scope = scopeOf(entry.intent.destination);
    if (scope === "project" && projectRoot === null) continue;
    scopes.add(scope);
  }
  if (scopes.size === 0 && state.hooks.includes(id)) scopes.add("global");
  return [...scopes];
}

// A rule file counts as present when the engine's own parser finds this source's managed block in
// it; a shared file that merely mentions the source in prose or a comment does not. An `-o`
// folder is written by the engine under its own file naming and is not checked here.
async function checkHarness(
  def: HarnessDefinition,
  scope: Scope,
  state: State,
  ctx: CommandContext,
): Promise<HarnessReport> {
  const harnessCtx = harnessContext(ctx.io);
  const ruleFiles: RuleFileReport[] = [];
  for (const [key, entry] of Object.entries(state.sources)) {
    if (!entry.intent.harnesses.includes(def.id) || !entry.intent.rule) continue;
    if (scopeOf(entry.intent.destination) !== scope) continue;
    if (entry.intent.destination.scope === "out") continue;
    const path = targetPath(def, entry.intent.destination, harnessCtx, sourceSlug(key));
    if (path === null) continue;
    const blocks = ruleBlocks(path, ctx);
    ruleFiles.push({
      source: key,
      path,
      present: blocks !== null && blocks.some((block) => block.source === key),
      frontmatter: frontmatterOk(def, scope, entry, readTextIfPresent(path)),
    });
  }
  const wanted = state.hooks.includes(def.id);
  let hook: HarnessReport["hook"] = "not-wanted";
  if (def.hook.kind === "none") hook = "none";
  else if (wanted) {
    const plan = await ctx.engine.planHookWrite({ def, scope, ctx: harnessCtx, wanted: true });
    hook = plan.changes.length === 0 ? "current" : "missing";
  }
  const tier = await ctx.engine.achievedTier(def, scope, harnessCtx);
  return { id: def.id, scope, ruleFiles, hook, tier };
}

// Null when the file is absent; an empty list when it exists but carries no managed block.
function ruleBlocks(path: string, ctx: CommandContext): RuleBlock[] | null {
  const text = readTextIfPresent(path);
  return text === null ? null : ctx.engine.parseRuleFile(text);
}

// The target declares the frontmatter BODY (`applyTo: "**"`); the file opens with that body inside
// `---` fences. A rules-dir harness that requires `alwaysApply: true` and does not find it loads
// the file only on demand, which is the failure `doctor` exists to name.
function frontmatterOk(
  def: HarnessDefinition,
  scope: Scope,
  entry: SourceEntry,
  text: string | null,
): boolean | null {
  const target = def.targets[scope];
  if (target === null || target.kind !== "rules-dir" || target.frontmatter === undefined) {
    return null;
  }
  if (text === null) return false;
  const body = target.frontmatter(
    entry.intent.paths === undefined ? {} : { paths: entry.intent.paths },
  );
  return text.startsWith(`---\n${body}---\n`);
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
      findings.push({ level: "fail", text: `${prefix} ${what}` });
    } else if (file.frontmatter === false) {
      findings.push({
        level: "fail",
        text: `${prefix} ${shown} lacks the frontmatter ${def.displayName} needs to load it every session`,
      });
    } else findings.push({ level: "ok", text: `${prefix} ${shown}` });
  }
  if (report.hook === "current") {
    findings.push({ level: "ok", text: `${prefix} SessionStart hook current` });
  }
  if (report.hook === "missing") {
    findings.push({
      level: "fail",
      text: `${prefix} hook missing (run maxims add <source> --add-hook)`,
    });
  }
  if (report.tier === 2) findings.push({ level: "warn", text: `${prefix} tier 2 on this machine` });
  return findings;
}

// `--expect name` or `--expect @owner/repo/name`: the memory must have a rule line in every rule
// file its source targets; a name two sources provide is checked for each. Met means every
// inspected file carries it AND at least one file was inspected: a source with no rule flag or no
// target is not a passing check.
function checkExpect(raw: string, state: State, ctx: CommandContext): ExpectReport {
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
  const owners = entries.filter(
    ([, entry]) => entry.intent.rule && effectiveNames(entry, io).includes(name),
  );
  const harnessCtx = harnessContext(io);
  const missing: string[] = [];
  let checked = 0;
  for (const [key, entry] of owners) {
    for (const id of entry.intent.harnesses) {
      const def = io.harnesses.find((candidate) => candidate.id === id);
      if (def === undefined || entry.intent.destination.scope === "out") continue;
      const path = targetPath(def, entry.intent.destination, harnessCtx, sourceSlug(key));
      if (path === null) continue;
      checked += 1;
      if (!hasRuleLine(ruleBlocks(path, ctx), key, name)) missing.push(tildify(path, io.userHome));
    }
  }
  return { name: raw, met: checked > 0 && missing.length === 0, checked, missing };
}

function hasRuleLine(blocks: RuleBlock[] | null, source: string, name: MemoryName): boolean {
  return blocks !== null && blocks.some((b) => b.source === source && b.names.includes(name));
}

function expectFinding(report: ExpectReport): Finding {
  if (report.met) return { level: "ok", text: `expect ${report.name}: rule line in place` };
  const where = report.checked === 0 ? "any rule-writing source" : report.missing.join(", ");
  return { level: "fail", text: `expect ${report.name}: no rule line in ${where}` };
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
