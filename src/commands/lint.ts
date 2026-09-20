import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { hiddenCharacters, type Memory, parseMemory } from "../memory/contract.ts";
import { extractWikilinks } from "../memory/wikilinks.ts";
import { ExitCode, MaximsError } from "../util/exit-codes.ts";
import { DEFAULT_RULE_CAP } from "./add.ts";
import { type Command, FLAGS, type FlagSpec, parsePositiveInt } from "./shared/options.ts";

export type LintProblem = { path: string; line: number; reason: string };

// The same `--cap <n>` spelling as the install verbs, but a threshold for this check only: lint
// reads a source folder and persists nothing.
const LINT_CAP: FlagSpec = {
  name: "cap",
  kind: "value",
  placeholder: "<n>",
  summary: "the rule cap to check the folder against (this run only)",
};

const LINT_FLAGS: readonly FlagSpec[] = [FLAGS.fullDepth, LINT_CAP];

// The source-repo check: every `.md` under the folder against the contract, the hidden-character
// gate, wikilinks resolving within the folder, and the count against the cap, printed one
// `path:line: reason` per problem so an editor can jump to it.
export const lint: Command = {
  summary: "check a folder of memory files against the contract",
  usage: "lint [path]",
  arity: 1,
  flags: LINT_FLAGS,
  async run(args, ctx) {
    const cap = parsePositiveInt(LINT_CAP, args) ?? ctx.config.ruleCap ?? DEFAULT_RULE_CAP;
    const root = resolve(ctx.io.cwd, args.positionals[0] ?? "memories");
    const problems = lintFolder(root, ctx.io.cwd, args.flag(FLAGS.fullDepth), cap);
    if (ctx.global.json) {
      ctx.io.stdout.write(`${JSON.stringify({ ok: problems.length === 0, problems }, null, 2)}\n`);
    } else if (!ctx.global.quiet) {
      for (const problem of problems) {
        ctx.io.stdout.write(`${problem.path}:${problem.line}: ${problem.reason}\n`);
      }
    }
    return problems.length === 0 ? ExitCode.Ok : ExitCode.NothingResolved;
  },
};

export function lintFolder(
  root: string,
  cwd: string,
  recursive: boolean,
  cap: number,
): LintProblem[] {
  const files = collectMarkdown(root, recursive, true);
  const problems: LintProblem[] = [];
  const memories: { memory: Memory; path: string }[] = [];
  for (const file of files) {
    const path = relative(cwd, file) || file;
    const text = readFileSync(file, "utf8");
    const parsed = parseMemory(file, text);
    if (!parsed.ok) {
      problems.push({ path, line: keyLine(text, parsed.reason), reason: parsed.reason });
      continue;
    }
    if (parsed.warning !== undefined) {
      problems.push({ path, line: keyLine(text, "metadata"), reason: parsed.warning });
    }
    const hidden = hiddenCharacters(parsed.memory.description);
    const first = hidden[0];
    if (first !== undefined) {
      const label =
        first.kind === "html-comment"
          ? "an HTML comment"
          : `U+${first.codePoint.toString(16).toUpperCase().padStart(4, "0")} ${first.kind} character`;
      problems.push({
        path,
        line: keyLine(text, "description"),
        reason: `description carries ${label} at column ${first.index + 1}`,
      });
    }
    memories.push({ memory: parsed.memory, path });
  }
  const names = new Set<string>(memories.map(({ memory }) => memory.name));
  for (const { memory, path } of memories) {
    for (const link of extractWikilinks(memory.body)) {
      if (names.has(link)) continue;
      problems.push({
        path,
        line: bodyLine(memory, link),
        reason: `[[${link}]] does not name a memory in this folder`,
      });
    }
  }
  if (memories.length > cap) {
    problems.push({
      path: relative(cwd, root) || ".",
      line: 1,
      reason: `${memories.length} memories is over the rule cap of ${cap}`,
    });
  }
  return problems.sort((a, b) => a.path.localeCompare(b.path) || a.line - b.line);
}

// A folder that cannot be read is an error, never a clean result: "no problems" is a claim about
// files that were inspected.
function collectMarkdown(dir: string, recursive: boolean, isRoot: boolean): string[] {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch (cause) {
    const detail = cause instanceof Error ? cause.message : String(cause);
    throw new MaximsError(
      isRoot ? ExitCode.Usage : ExitCode.DestinationWriteFailed,
      `cannot read ${dir}: ${detail}`,
      { cause },
    );
  }
  const out: string[] = [];
  for (const entry of entries.sort()) {
    const path = join(dir, entry);
    const stat = statSync(path, { throwIfNoEntry: false });
    if (stat === undefined) continue;
    if (stat.isDirectory()) {
      if (recursive) out.push(...collectMarkdown(path, recursive, false));
    } else if (entry.endsWith(".md")) out.push(path);
  }
  return out;
}

// The line of the frontmatter key a reason names, so `description is missing or empty` points at
// the `description:` line when there is one; line 1 otherwise.
function keyLine(text: string, reason: string): number {
  const key =
    /^(name|description|metadata)\b/.exec(reason)?.[1] ?? /metadata\.(\w+)/.exec(reason)?.[1];
  if (key === undefined) return 1;
  const lines = text.split(/\r?\n/);
  const index = lines.findIndex(
    (line) => line.startsWith(`${key}:`) || line.trim().startsWith(`${key}:`),
  );
  return index === -1 ? 1 : index + 1;
}

function bodyLine(memory: Memory, link: string): number {
  const rawLines = memory.raw.split(/\r?\n/);
  const index = rawLines.findIndex((line) => line.includes(`[[${link}`));
  return index === -1 ? 1 : index + 1;
}
