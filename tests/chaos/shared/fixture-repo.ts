// Synthetic memory sources for the chaos and convergence suites: hand-written memory files and a
// git repository holding them, so a source can be served over git://, moved away, or rewound.
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export type MemorySpec = { description: string; body?: string };

// A file that must NOT parse as a memory is spelled as its raw text.
export type FileSpec = MemorySpec | { raw: string };

export function memoryFile(name: string, spec: MemorySpec): string {
  return `---\nname: ${name}\ndescription: ${spec.description}\nmetadata:\n  node_type: memory\n---\n\n${spec.body ?? `Body of ${name}.`}\n`;
}

export function writeMemories(root: string, files: Record<string, FileSpec>): void {
  const dir = join(root, "memories");
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  for (const [name, spec] of Object.entries(files)) {
    const text = "raw" in spec ? spec.raw : memoryFile(name, spec);
    writeFileSync(join(dir, `${name}.md`), text);
  }
}

export function manyMemories(count: number): Record<string, MemorySpec> {
  const memories: Record<string, MemorySpec> = {};
  for (let index = 1; index <= count; index += 1) {
    const name = `rule-${String(index).padStart(2, "0")}`;
    memories[name] = { description: `Rule number ${index} of the generated source.` };
  }
  return memories;
}

// The git identity comes from the launcher's GIT_* environment; the repository gets no config of
// its own, so a fixture never differs by the machine it was made on.
export function git(dir: string, args: string[]): string {
  const result = Bun.spawnSync(["git", "-C", dir, ...args], { stdout: "pipe", stderr: "pipe" });
  if (result.exitCode !== 0) {
    throw new Error(`git ${args.join(" ")} in ${dir} exited ${result.exitCode}:\n${result.stderr}`);
  }
  return result.stdout.toString("utf8").trim();
}

export function commitAll(dir: string, message: string): string {
  git(dir, ["add", "--all"]);
  git(dir, ["commit", "--quiet", "--message", message]);
  return git(dir, ["rev-parse", "HEAD"]);
}

// A repository on branch `main` with one commit holding the given files and a README beside the
// memories folder, so a sparse checkout has something to leave behind.
export function fixtureRepo(
  dir: string,
  files: Record<string, FileSpec>,
): { dir: string; head: string } {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "README.md"), "# fixture source\n");
  writeMemories(dir, files);
  git(dir, ["init", "--quiet", "--initial-branch", "main"]);
  const head = commitAll(dir, "one");
  return { dir, head };
}
