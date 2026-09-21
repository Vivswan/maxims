// What would drift silently: a disabled or internal memory reaching a rule line, a lock
// projection whose bytes depend on the machine that wrote it or that drops the project's disabled
// names, and a lock entry whose relative local path does not resolve back to the state key.
import { describe, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  entryFor,
  localFrom,
  memoryFile,
  memoryName,
  stateWith,
  writeSource,
} from "../../../tests/engine/harness.ts";
import { withTempDir } from "../../../tests/shared/temp_dir.ts";
import { parseMemory } from "../../memory/contract.ts";
import type { SourceEntry } from "../../state/schema.ts";
import type { SourceMemory } from "./memories.ts";
import { projectLockChange, readProjectLock } from "./project-lock-io.ts";
import { disabledNames, selectMemories } from "./select.ts";
import { withShared } from "./sources.ts";

function sourceMemory(name: string, description: string, internal = false): SourceMemory {
  const text = memoryFile(name, { description, internal });
  const parsed = parseMemory(`${name}.md`, text);
  if (!parsed.ok) throw new Error(parsed.reason);
  return { memory: parsed.memory, relPath: `memories/${name}.md`, text };
}

describe("selection", () => {
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
  // The lock carries what this project shares and nothing else: the entries recorded for this
  // root and marked shared, and of the project's disabled names only those such an entry provides.
  test("round-trips shared project-scope intent with a relative local path and stable bytes", async () => {
    await withTempDir(async (dir) => {
      const project = join(dir, "project");
      const other = join(dir, "other");
      const local = writeSource(join(project, "memories"), {
        a: { description: "A." },
        b: { description: "B." },
      });
      const io = { home: join(dir, "home"), env: {} };
      const at = (root: string, shared: boolean) => ({
        destination: { scope: "project" as const, root },
        ...(shared ? { shared: true as const } : {}),
      });
      const state = stateWith(
        {
          "@acme/rules#v2": entryFor(
            { type: "github", repo: "acme/rules", ref: "v2" },
            {
              ...at(project, true),
              select: [memoryName("one")],
              harnesses: ["codex"],
              allowHidden: true,
            },
          ),
          [local]: entryFor(localFrom(local, true), {
            ...at(project, true),
            rename: { [memoryName("b")]: memoryName("b2"), [memoryName("a")]: memoryName("a2") },
            paths: ["src/**"],
          }),
          "@acme/private": entryFor(
            { type: "github", repo: "acme/private", ref: "HEAD" },
            at(project, false),
          ),
          "@acme/elsewhere": entryFor(
            { type: "github", repo: "acme/elsewhere", ref: "HEAD" },
            at(other, true),
          ),
          "@acme/global": entryFor({ type: "github", repo: "acme/global", ref: "HEAD" }),
        },
        undefined,
        {
          global: [memoryName("one")],
          project: { [project]: [memoryName("a2"), memoryName("zed")] },
        },
      );
      const change = await projectLockChange(project, state, state, io);
      if (change?.kind !== "write") throw new Error("expected a write");
      expect(change.content).toBe(
        `${JSON.stringify(
          {
            version: 1,
            sources: {
              "./memories": {
                from: { type: "local", path: "./memories", live: true },
                select: "*",
                rename: { a: "a2", b: "b2" },
                rule: true,
                harnesses: ["claude-code"],
                paths: ["src/**"],
              },
              "@acme/rules#v2": {
                from: { type: "github", repo: "acme/rules" },
                pin: "v2",
                select: ["one"],
                rule: true,
                harnesses: ["codex"],
                allowHidden: true,
              },
            },
            disabled: ["a2"],
          },
          null,
          2,
        )}\n`,
      );
      mkdirSync(join(project, ".agents"), { recursive: true });
      writeFileSync(change.path, change.content);
      const read = await readProjectLock(project);
      expect(read.kind).toBe("parsed");
      if (read.kind === "parsed")
        expect(read.keys.sort()).toEqual([local, "@acme/rules#v2"].sort());
      // The file as it is plans nothing. A teammate's entry and its disabled name stay through a
      // rewrite this machine makes, since a clone that has not replayed the lock holds neither.
      expect(await projectLockChange(project, state, state, io)).toBeNull();
      const team = JSON.parse(change.content) as {
        sources: Record<string, unknown>;
        disabled?: string[];
      };
      team.sources["@acme/team"] = {
        from: { type: "github", repo: "acme/team" },
        select: "*",
        rule: true,
        harnesses: ["codex"],
      };
      team.disabled = ["a2", "team-rule"];
      writeFileSync(change.path, `${JSON.stringify(team, null, 2)}\n`);
      expect(await projectLockChange(project, state, state, io)).toBeNull();
      const unshared = stateWith(
        { ...state.sources, [local]: withShared(state.sources[local] as SourceEntry, false) },
        undefined,
        state.disabled,
      );
      const withoutLocal = await projectLockChange(project, state, unshared, io);
      if (withoutLocal?.kind !== "write") throw new Error("expected a write");
      expect(JSON.parse(withoutLocal.content)).toEqual({
        version: 1,
        sources: {
          "@acme/rules#v2": team.sources["@acme/rules#v2"],
          "@acme/team": team.sources["@acme/team"],
        },
        disabled: ["team-rule"],
      });
      // A teammate spelled our GitHub source in another case: the lock's entry is still ours, so an
      // unshare takes it out instead of leaving a twin.
      const spelled = JSON.parse(change.content) as {
        sources: Record<string, { from: { repo: string } }>;
      };
      const rules = spelled.sources["@acme/rules#v2"];
      if (rules === undefined) throw new Error("expected the rules entry");
      spelled.sources["@Acme/rules#v2"] = { ...rules, from: { ...rules.from, repo: "Acme/rules" } };
      delete spelled.sources["@acme/rules#v2"];
      writeFileSync(change.path, `${JSON.stringify(spelled, null, 2)}\n`);
      const rulesPrivate = stateWith(
        {
          ...state.sources,
          "@acme/rules#v2": withShared(state.sources["@acme/rules#v2"] as SourceEntry, false),
        },
        undefined,
        state.disabled,
      );
      const unspelled = await projectLockChange(project, state, rulesPrivate, io);
      if (unspelled?.kind !== "write") throw new Error("expected a write");
      expect(Object.keys(JSON.parse(unspelled.content).sources)).toEqual(["./memories"]);
      // A git URL is the key it is: a teammate's `rules.git` is not this machine's `Rules.git`, so
      // a private add of the latter leaves the lock as the file has it.
      const teamOnly = {
        version: 1,
        sources: {
          "https://git.example.com/team/rules.git": {
            from: { type: "git", url: "https://git.example.com/team/rules.git" },
            select: "*",
            rule: true,
            harnesses: ["codex"],
          },
        },
      };
      writeFileSync(change.path, `${JSON.stringify(teamOnly, null, 2)}\n`);
      const privateOnly = stateWith(
        Object.fromEntries(
          Object.entries(state.sources).map(([key, entry]) => [key, withShared(entry, false)]),
        ),
        undefined,
        state.disabled,
      );
      const withTwin = stateWith(
        {
          ...privateOnly.sources,
          "https://git.example.com/team/Rules.git": entryFor(
            { type: "git", url: "https://git.example.com/team/Rules.git", ref: "HEAD" },
            at(project, false),
          ),
        },
        undefined,
        state.disabled,
      );
      expect(await projectLockChange(project, privateOnly, withTwin, io)).toBeNull();
      // A private source providing a name a teammate switched off says nothing about that choice.
      const teamDisabled = {
        ...teamOnly,
        sources: {
          "@acme/team": {
            from: { type: "github", repo: "acme/team" },
            select: "*",
            rule: true,
            harnesses: ["codex"],
          },
        },
        disabled: ["alpha"],
      };
      writeFileSync(change.path, `${JSON.stringify(teamDisabled, null, 2)}\n`);
      const alphaSource = writeSource(join(project, "alpha-src"), { alpha: { description: "A." } });
      const withPrivateAlpha = stateWith(
        {
          ...privateOnly.sources,
          [alphaSource]: entryFor(localFrom(alphaSource, true), at(project, false)),
        },
        undefined,
        state.disabled,
      );
      expect(await projectLockChange(project, privateOnly, withPrivateAlpha, io)).toBeNull();
      // Every entry of ours unshared and none of the team's left: the file goes; where none
      // exists, nothing is planned.
      writeFileSync(change.path, change.content);
      const priv = stateWith(
        Object.fromEntries(
          Object.entries(state.sources).map(([key, entry]) => [key, withShared(entry, false)]),
        ),
        undefined,
        state.disabled,
      );
      expect((await projectLockChange(project, state, priv, io))?.kind).toBe("delete");
      expect(await projectLockChange(other, priv, priv, io)).toBeNull();
      // A local directory named like a GitHub key keeps its own entry beside the real one.
      const twinProject = join(dir, "twins");
      const lookalike = join(twinProject, "@acme", "rules");
      const twinState = stateWith({
        "@acme/rules": entryFor(
          { type: "github", repo: "acme/rules", ref: "HEAD" },
          at(twinProject, true),
        ),
        [lookalike]: entryFor(localFrom(lookalike), at(twinProject, true)),
      });
      const twins = await projectLockChange(twinProject, twinState, twinState, io);
      if (twins?.kind !== "write") throw new Error("expected a write");
      expect(Object.keys(JSON.parse(twins.content).sources).sort()).toEqual([
        "./@acme/rules",
        "@acme/rules",
      ]);
    });
  });
});
