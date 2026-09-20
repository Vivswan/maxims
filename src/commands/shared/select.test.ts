// What would drift silently: a memory checked out with CRLF hashing differently from its LF twin
// (a rewrite of every rule file on Windows), a disabled or internal memory reaching a rule line,
// a lock projection whose bytes depend on the machine that wrote it, and a lock entry whose
// relative local path does not resolve back to the state key.
import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import {
  entryFor,
  localFrom,
  memoryFile,
  memoryName,
  stateWith,
} from "../../../tests/engine/harness.ts";
import { withTempDir } from "../../../tests/shared/temp_dir.ts";
import { parseMemory } from "../../memory/contract.ts";
import { contentHash, type SourceMemory } from "./memories.ts";
import { projectLockChange, readProjectLock } from "./project-lock-io.ts";
import { disabledNames, selectMemories } from "./select.ts";

function sourceMemory(name: string, description: string, internal = false): SourceMemory {
  const text = memoryFile(name, { description, internal });
  const parsed = parseMemory(`${name}.md`, text);
  if (!parsed.ok) throw new Error(parsed.reason);
  return { memory: parsed.memory, relPath: `memories/${name}.md`, text };
}

describe("selection", () => {
  test("CRLF and LF spellings of one memory hash alike", () => {
    const lf = memoryFile("crlf-rule", { description: "Same rule." });
    expect(contentHash(lf.replaceAll("\n", "\r\n"))).toBe(contentHash(lf));
  });

  test("disabled names leave the scope's selection by local name and stay owned for the index", () => {
    const memories = [
      sourceMemory("alpha", "A."),
      sourceMemory("beta", "B."),
      sourceMemory("hidden", "H.", true),
    ];
    const rename = { [memoryName("alpha")]: memoryName("alpha-local") };
    const selection = selectMemories({
      memories,
      intent: { select: "*", rename },
      installInternal: false,
      disabled: new Set(["alpha-local"]),
      detailPath: (_memory, local) => `memories/${local}.md`,
    });
    expect(selection.selected.map((memory) => memory.localName)).toEqual([memoryName("beta")]);
    expect(selection.selected[0]?.candidate.detailPath).toBe("memories/beta.md");
    expect(selection.disabledDropped).toEqual([memoryName("alpha-local")]);
    expect(selection.hiddenInternal).toBe(1);
    expect(selection.ownedUpstreamNames).toEqual([memoryName("alpha"), memoryName("beta")]);
    const state = stateWith({});
    expect([
      ...disabledNames({ ...state, disabled: { global: [memoryName("beta")] } }, "global", null),
    ]).toEqual(["beta"]);
    expect([...disabledNames(state, "project", "/home/user/project")]).toEqual([]);
  });
});

describe("project lock projection", () => {
  test("round-trips project-scope intent with a relative local path and stable bytes", async () => {
    await withTempDir(async (dir) => {
      const project = join(dir, "project");
      const local = join(dir, "memories");
      const state = stateWith({
        "@acme/rules#v2": entryFor(
          { type: "github", repo: "acme/rules", ref: "v2" },
          { destination: { scope: "project" }, select: [memoryName("one")], harnesses: ["codex"] },
        ),
        [local]: entryFor(localFrom(local, true), {
          destination: { scope: "project" },
          rename: { [memoryName("b")]: memoryName("b2"), [memoryName("a")]: memoryName("a2") },
          copy: true,
        }),
        "@acme/global": entryFor({ type: "github", repo: "acme/global", ref: "HEAD" }),
      });
      const change = projectLockChange(project, state);
      if (change.kind !== "write") throw new Error("expected a write");
      expect(change.content).toBe(
        `${JSON.stringify(
          {
            version: 1,
            sources: {
              "../memories": {
                from: { type: "local", path: "../memories", live: true },
                select: "*",
                rename: { a: "a2", b: "b2" },
                rule: true,
                harnesses: ["claude-code"],
                copy: true,
              },
              "@acme/rules#v2": {
                from: { type: "github", repo: "acme/rules" },
                pin: "v2",
                select: ["one"],
                rule: true,
                harnesses: ["codex"],
              },
            },
          },
          null,
          2,
        )}\n`,
      );
      const { mkdirSync, writeFileSync } = await import("node:fs");
      mkdirSync(join(project, ".agents"), { recursive: true });
      writeFileSync(change.path, change.content);
      const read = await readProjectLock(project);
      expect(read.kind).toBe("parsed");
      if (read.kind === "parsed")
        expect(read.keys.sort()).toEqual([local, "@acme/rules#v2"].sort());
      expect(projectLockChange(project, stateWith({})).kind).toBe("delete");
      // A local directory named like a GitHub key keeps its own entry beside the real one.
      const lookalike = join(project, "@acme", "rules");
      const twins = projectLockChange(
        project,
        stateWith({
          "@acme/rules": entryFor(
            { type: "github", repo: "acme/rules", ref: "HEAD" },
            { destination: { scope: "project" } },
          ),
          [lookalike]: entryFor(localFrom(lookalike), { destination: { scope: "project" } }),
        }),
      );
      if (twins.kind !== "write") throw new Error("expected a write");
      expect(Object.keys(JSON.parse(twins.content).sources).sort()).toEqual([
        "./@acme/rules",
        "@acme/rules",
      ]);
    });
  });
});
