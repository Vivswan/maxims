// Synthetic memory sources for the chaos and convergence suites: hand-written memory files and a
// git repository holding them, so a source can be served over git://, moved away, or rewound.
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { commitAll, gitInit } from "../../shared/git_fixture.ts";

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

// A repository on branch `main` with one commit holding the given files and a README beside the
// memories folder, so a sparse checkout has something to leave behind.
export function fixtureRepo(
  dir: string,
  files: Record<string, FileSpec>,
): { dir: string; head: string } {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "README.md"), "# fixture source\n");
  writeMemories(dir, files);
  gitInit(dir);
  const head = commitAll(dir, "one");
  return { dir, head };
}
