// The source repositories the bundle installs from, laid out under the launcher HOME, and a
// content snapshot of a directory tree so a row can prove a verb wrote nothing outside the paths
// it is allowed to touch. The bundle accepts https, http, ssh and git URLs and local directories;
// a fixture repository is handed to it as its checkout path, which it reads as a copied local
// source, so the git history it carries is what a later remote-URL install would clone.
import {
  cpSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  writeFileSync,
} from "node:fs";
import { join, parse, relative, resolve, sep } from "node:path";
import { sourceSlug } from "../../src/commands/shared/slug.ts";
import type { HarnessId } from "../../src/harnesses/contract.ts";
import { parseMemory } from "../../src/memory/contract.ts";
import { sha256 } from "../../src/util/fs.ts";
import { type Bundle, type Home, type Run, runMaxims } from "./binary.ts";

const HARNESS_FIXTURES = resolve(import.meta.dir, "..", "..", "src", "harnesses");

// A definition's hand-formatted file under `src/harnesses/<id>/fixtures/`.
export function harnessFixture(id: HarnessId, name: string): string {
  return readFileSync(join(HARNESS_FIXTURES, id, "fixtures", name), "utf8");
}

export const CLAUDE_SETTINGS = harnessFixture("claude-code", "settings.json");
export const CODEX_HOOKS = harnessFixture("codex", "hooks.json");

// A hook stdin fixture names directories under the example user's home; a run that read them as
// written would walk a real filesystem for a project root, so they are moved under the temp home,
// spelled as JSON spells a path (a Windows root carries backslashes).
export function hookPayload(fixture: string, home: Home): string {
  return fixture.replaceAll("/home/user", JSON.stringify(home.root).slice(1, -1));
}

const TREE_ROOT = resolve(import.meta.dir, "..", "fixtures", "cli");

function git(cwd: string, ...args: string[]): void {
  const run = Bun.spawnSync(["git", "-C", cwd, ...args], { stdout: "pipe", stderr: "pipe" });
  if (run.exitCode !== 0) {
    throw new Error(`git ${args.join(" ")} in ${cwd} exited ${run.exitCode}:\n${run.stderr}`);
  }
}

function commitAll(dir: string): void {
  git(dir, "init", "-q", "-b", "main");
  git(dir, "add", ".");
  git(dir, "commit", "-q", "-m", "fixture");
}

// Copies `tests/fixtures/cli/<tree>/` to `<dir>/<tree>` and commits it; returns the path the
// bundle installs from.
export function fixtureRepo(dir: string, tree: string): string {
  const source = join(TREE_ROOT, tree);
  if (!existsSync(source)) throw new Error(`no fixture tree named ${tree}`);
  const repo = join(dir, tree);
  cpSync(source, repo, { recursive: true });
  commitAll(repo);
  return repo;
}

// The `<name>: <description>` pairs a default install of the tree publishes as rule lines: every
// file that passes the memory contract and is not marked internal, in file order. Pairing the
// description with its memory is what catches two descriptions swapped between intact detail lines.
export function fixtureDescriptions(tree: string): string[] {
  const memories = join(TREE_ROOT, tree, "memories");
  return readdirSync(memories).flatMap((file) => {
    const parsed = parseMemory(file, readFileSync(join(memories, file), "utf8"));
    if (!parsed.ok || parsed.memory.metadata.internal === true) return [];
    return [`${parsed.memory.name}: ${parsed.memory.description}`];
  });
}

const RULE_LINE = /^- (.*) \(detail: (\S.*), [0-9a-f]{7}\)$/;

// The `<detail stem>: <description>` pair each `- ` line of a rule file carries; a line that does
// not follow the rule grammar stays whole so the mismatch shows what was written. The stem equals
// the upstream memory name for every caller: none installs with a rename.
export function ruleDescriptions(text: string): string[] {
  return text
    .split("\n")
    .filter((line) => line.startsWith("- "))
    .map((line) => {
      const match = RULE_LINE.exec(line);
      if (match === null) return line;
      const [, description = "", detail = ""] = match;
      return `${parse(detail).name}: ${description}`;
    });
}

// `count` rule-flagged memories named m-001.. so a row can cross the rule cap on purpose.
export function memoriesRepo(dir: string, count: number): string {
  const repo = join(dir, `memories-${count}`);
  mkdirSync(join(repo, "memories"), { recursive: true });
  for (let index = 1; index <= count; index += 1) {
    const name = `m-${String(index).padStart(3, "0")}`;
    writeFileSync(
      join(repo, "memories", `${name}.md`),
      [
        "---",
        `name: ${name}`,
        `description: Generated rule number ${index} for the cap row`,
        "metadata:",
        "  node_type: memory",
        "  type: feedback",
        "---",
        "",
        `**Why:** rule ${index} exists to be counted.`,
        "",
      ].join("\n"),
    );
  }
  commitAll(repo);
  return repo;
}

// Every entry under `root` by its path relative to the root, spelled with `/` on every platform:
// a file as its content hash, a symlink as its target, a directory as `dir`, so an empty folder
// or a dangling link a verb left behind shows up as well as a changed byte. `skip` lists the
// relative paths a run may touch.
export function snapshot(root: string, skip: string[] = []): Map<string, string> {
  const entries = new Map<string, string>();
  const skipped = new Set(skip);
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      const rel = relative(root, path).split(sep).join("/");
      if (skipped.has(rel)) continue;
      if (entry.isSymbolicLink()) entries.set(rel, `link:${readlinkSync(path)}`);
      else if (entry.isDirectory()) {
        entries.set(rel, "dir");
        walk(path);
      } else entries.set(rel, sha256(readFileSync(path)));
    }
  };
  if (existsSync(root)) walk(root);
  return entries;
}

export function seedRegistries(home: Home): { claude: string; codex: string } {
  const claude = join(home.root, ".claude", "settings.json");
  const codex = join(home.root, ".codex", "hooks.json");
  mkdirSync(join(home.root, ".claude"), { recursive: true });
  mkdirSync(join(home.root, ".codex"), { recursive: true });
  writeFileSync(claude, CLAUDE_SETTINGS);
  writeFileSync(codex, CODEX_HOOKS);
  return { claude, codex };
}

export type Installed = {
  source: string;
  slug: string;
  ruleFile: string;
  block: string;
  registries: { claude: string; codex: string };
  run: Run;
};

// The install the scenario rows and the golden build on: the dotfiles fixture into both seeded
// harnesses at the user scope with rule lines and hooks.
export async function installDotfiles(
  bundle: Bundle,
  dir: string,
  home: Home,
  extra: string[] = [],
): Promise<Installed> {
  const registries = seedRegistries(home);
  const source = fixtureRepo(dir, "dotfiles");
  const slug = sourceSlug({ type: "local", path: source });
  const run = await runMaxims(bundle, home, [
    "add",
    source,
    "-g",
    "--rule",
    "--add-hook",
    "-a",
    "claude-code,codex",
    "-y",
    ...extra,
  ]);
  return {
    source,
    slug,
    ruleFile: join(home.root, ".claude", "rules", `maxims-${slug}.md`),
    block: join(home.root, ".codex", "AGENTS.md"),
    registries,
    run,
  };
}

// The run-specific values a printed line may carry, so a whole frame can be pinned: the source
// path, the slug hashed from it, the home, and a token estimate that follows the path lengths.
// A path under the home keeps the separator of the machine that printed it; the golden holds the
// forward-slash spelling.
export function redact(
  text: string,
  installed: Pick<Installed, "source" | "slug">,
  home: Home,
): string {
  return text
    .replaceAll(installed.source, "<SOURCE>")
    .replaceAll(installed.slug, "<SLUG>")
    .replaceAll(home.root, "<HOME>")
    .replace(/<HOME>\S*/g, (path) => path.replaceAll("\\", "/"))
    .replace(/~\d+ tokens/g, "~N tokens");
}
