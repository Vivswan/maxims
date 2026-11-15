// The source repositories the bundle installs from, laid out under the launcher HOME, and a
// content snapshot of a directory tree so a row can prove a verb wrote nothing outside the paths
// it is allowed to touch. The bundle accepts https, http, ssh and git URLs and local directories;
// a fixture repository is handed to it as its checkout path, which it reads as a copied local
// source, so the git history it carries is what a later remote-URL install would clone.
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, parse, resolve } from "node:path";
import type { HarnessId } from "../../src/contracts/harness-id.ts";
import { sourceSlug } from "../../src/engine/slug.ts";
import { parseMemory } from "../../src/memory/contract.ts";
import { sha256 } from "../../src/util/fs.ts";
import { commitAll, gitInit } from "../shared/git_fixture.ts";
import { memoryFile } from "../shared/memory_file.ts";
import { walkTree } from "../shared/tree.ts";
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

const TREE_ROOT = resolve(import.meta.dir, "..", "fixtures", "commands");

// Copies `tests/fixtures/commands/<tree>/` to `<dir>/<tree>` and commits it; returns the path the
// bundle installs from.
export function fixtureRepo(dir: string, tree: string): string {
  const source = join(TREE_ROOT, tree);
  if (!existsSync(source)) throw new Error(`no fixture tree named ${tree}`);
  const repo = join(dir, tree);
  cpSync(source, repo, { recursive: true });
  gitInit(repo);
  commitAll(repo, "fixture");
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
    const spec = {
      description: `Generated rule number ${index} for the cap row`,
      type: "feedback",
      body: `**Why:** rule ${index} exists to be counted.`,
    } as const;
    writeFileSync(join(repo, "memories", `${name}.md`), memoryFile(name, spec));
  }
  gitInit(repo);
  commitAll(repo, "fixture");
  return repo;
}

// Every entry under `root` by its path relative to the root, spelled with `/` on every platform:
// a file as its content hash, a symlink as its target, a directory as `dir`, so an empty folder
// or a dangling link a verb left behind shows up as well as a changed byte. `skip` lists the
// relative paths a run may touch.
export function snapshot(root: string, skip: string[] = []): Map<string, string> {
  const entries = new Map<string, string>();
  if (!existsSync(root)) return entries;

  for (const entry of walkTree(root, new Set(skip))) {
    if (entry.kind === "symlink") entries.set(entry.path, `link:${entry.target}`);
    else if (entry.kind === "dir") entries.set(entry.path, "dir");
    else entries.set(entry.path, sha256(readFileSync(join(root, entry.path))));
  }

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
