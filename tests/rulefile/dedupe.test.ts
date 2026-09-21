// Guards the identity rules a user cannot see from the file: a name owned by another source that
// silently became a skip, a rename that stopped applying, a 26th rule truncated instead of refused,
// a later-installed source winning a shared name because timestamps sorted as text, or a memory
// named like an Object prototype member reading a function out of the rename map.
import { describe, expect, test } from "bun:test";
import type { MemoryName } from "../../src/memory/contract.ts";
import { DEFAULT_RULE_CAP } from "../../src/rulefile/budget.ts";
import {
  buildNameIndex,
  type Candidate,
  type IndexedSource,
  pruneRenames,
  resolveSourceCandidates,
} from "../../src/rulefile/dedupe.ts";
import type { RenameMap, Select } from "../../src/state/schema.ts";
import { ExitCode } from "../../src/util/exit-codes.ts";

const SKILLS = "@Vivswan/skills";
const DOTFILES = "@Vivswan/dotfiles";
const GATE = "gate-exit-conditions-the-merge" as MemoryName;
const GATE_DOTFILES = "gate-exit-conditions-the-merge-dotfiles" as MemoryName;
const RUBBER_DUCK = "rubber-duck-before-every-commit" as MemoryName;
const NO_PIPE = "no-pipe-masked-exit-codes" as MemoryName;
const BRAND_NEW = "brand-new" as MemoryName;

const HASH_A = `sha256:${"a".repeat(64)}`;
const HASH_B = `sha256:${"b".repeat(7)}${"0".repeat(57)}`;

function candidate(name: MemoryName, hash = HASH_A): Candidate {
  return { name, description: `about ${name}`, contentHash: hash, detailPath: `/store/${name}.md` };
}

type Installed = {
  key: string;
  names: MemoryName[];
  select?: Select;
  rename?: RenameMap;
  addedAt?: string;
};

function installed(sources: Installed[]): IndexedSource[] {
  return sources.map(({ key, names, select = "*", rename = {}, addedAt }, i) => ({
    key,
    addedAt: addedAt ?? `2026-09-${String(i + 1).padStart(2, "0")}T00:00:00Z`,
    intent: { select, rename },
    names,
  }));
}

describe("the worked example: two sources ship gate-exit-conditions-the-merge", () => {
  const skills: Installed = { key: SKILLS, names: [GATE, RUBBER_DUCK] };
  const dotfiles: Installed = { key: DOTFILES, names: [GATE, NO_PIPE] };

  test("the second source collides on the shared name and nothing resolves", () => {
    const index = buildNameIndex(installed([skills, dotfiles]));
    expect(index.get(GATE)).toBe(SKILLS);
    expect(
      resolveSourceCandidates({
        source: DOTFILES,
        memories: [candidate(GATE), candidate(NO_PIPE)],
        select: "*",
        rename: {},
        index,
        cap: DEFAULT_RULE_CAP,
      }),
    ).toEqual({
      ok: false,
      code: ExitCode.NameCollision,
      collisions: [{ name: GATE, ownedBy: SKILLS }],
    });
  });

  test("a recorded rename resolves it: two lines, two names, ordered by the name they carry", () => {
    const rename: RenameMap = { [GATE]: GATE_DOTFILES };
    const index = buildNameIndex(installed([skills, { ...dotfiles, rename }]));
    expect(index.get(GATE_DOTFILES)).toBe(DOTFILES);
    expect(index.get(GATE)).toBe(SKILLS);
    expect(
      resolveSourceCandidates({
        source: DOTFILES,
        memories: [candidate(NO_PIPE, HASH_B), candidate(GATE)],
        select: "*",
        rename,
        index,
        cap: DEFAULT_RULE_CAP,
      }),
    ).toEqual({
      ok: true,
      lines: [
        {
          name: GATE_DOTFILES,
          description: `about ${GATE}`,
          detailPath: `/store/${GATE}.md`,
          shortHash: "aaaaaaa",
        },
        {
          name: NO_PIPE,
          description: `about ${NO_PIPE}`,
          detailPath: `/store/${NO_PIPE}.md`,
          shortHash: "bbbbbbb",
        },
      ],
    });
  });

  test("the owning source keeps its own name, and an unowned name is free", () => {
    const index = buildNameIndex(
      installed([skills, { ...dotfiles, rename: { [GATE]: GATE_DOTFILES } }]),
    );
    const result = resolveSourceCandidates({
      source: SKILLS,
      memories: [candidate(GATE), candidate(RUBBER_DUCK), candidate(BRAND_NEW)],
      select: "*",
      rename: {},
      index,
      cap: DEFAULT_RULE_CAP,
    });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.lines.map((l) => l.name)).toEqual([BRAND_NEW, GATE, RUBBER_DUCK]);
  });

  test("installation order decides ownership by instant, not by timestamp text", () => {
    const index = buildNameIndex(
      installed([
        { ...dotfiles, addedAt: "2026-09-01T00:00:00.500Z" },
        { ...skills, addedAt: "2026-09-01T00:00:00Z" },
      ]),
    );
    expect(index.get(GATE)).toBe(SKILLS);
  });
});

describe("resolveSourceCandidates", () => {
  test("select narrows before anything else, so an unselected collision never fires", () => {
    const index = buildNameIndex(
      installed([
        { key: SKILLS, names: [GATE] },
        { key: DOTFILES, names: [GATE, NO_PIPE], select: [NO_PIPE] },
      ]),
    );
    const result = resolveSourceCandidates({
      source: DOTFILES,
      memories: [candidate(GATE), candidate(NO_PIPE)],
      select: [NO_PIPE],
      rename: {},
      index,
      cap: DEFAULT_RULE_CAP,
    });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.lines.map((l) => l.name)).toEqual([NO_PIPE]);
  });

  test("a rename onto a name the same source also ships is a collision with itself", () => {
    const rename: RenameMap = { [GATE]: RUBBER_DUCK };
    const index = buildNameIndex(installed([{ key: SKILLS, names: [GATE, RUBBER_DUCK], rename }]));
    expect(
      resolveSourceCandidates({
        source: SKILLS,
        memories: [candidate(GATE), candidate(RUBBER_DUCK)],
        select: "*",
        rename,
        index,
        cap: DEFAULT_RULE_CAP,
      }),
    ).toEqual({
      ok: false,
      code: ExitCode.NameCollision,
      collisions: [{ name: RUBBER_DUCK, ownedBy: SKILLS }],
    });
  });

  test("every collision is reported, not just the first", () => {
    const index = buildNameIndex(
      installed([
        { key: SKILLS, names: [GATE, RUBBER_DUCK] },
        { key: DOTFILES, names: [GATE, RUBBER_DUCK] },
      ]),
    );
    const result = resolveSourceCandidates({
      source: DOTFILES,
      memories: [candidate(RUBBER_DUCK), candidate(GATE)],
      select: "*",
      rename: {},
      index,
      cap: DEFAULT_RULE_CAP,
    });
    expect(result).toEqual({
      ok: false,
      code: ExitCode.NameCollision,
      collisions: [
        { name: GATE, ownedBy: SKILLS },
        { name: RUBBER_DUCK, ownedBy: SKILLS },
      ],
    });
  });

  test("26 survivors are refused whole at the default cap; 25 render", () => {
    const memories = Array.from({ length: 26 }, (_, i) =>
      candidate(`rule-${String(i).padStart(2, "0")}` as MemoryName),
    );
    const index = buildNameIndex(installed([{ key: SKILLS, names: memories.map((m) => m.name) }]));
    const resolve = (list: Candidate[]) =>
      resolveSourceCandidates({
        source: SKILLS,
        memories: list,
        select: "*",
        rename: {},
        index,
        cap: DEFAULT_RULE_CAP,
      });
    expect(resolve(memories)).toEqual({
      ok: false,
      code: ExitCode.RuleCapExceeded,
      count: 26,
      cap: 25,
      hint:
        "narrow the source with --memory <name>..., or raise the cap (currently 25) " +
        "with --cap <n>, which saves ruleCap to config.json as `maxims config set ruleCap <n>` does",
    });
    const under = resolve(memories.slice(1));
    expect(under.ok).toBe(true);
    if (under.ok) expect(under.lines).toHaveLength(25);
  });

  test("a memory named like an Object prototype member is a plain name, not a lookup hit", () => {
    const name = "constructor" as MemoryName;
    const index = buildNameIndex(installed([{ key: SKILLS, names: [name] }]));
    expect(index.get(name)).toBe(SKILLS);
    expect(
      resolveSourceCandidates({
        source: SKILLS,
        memories: [candidate(name)],
        select: "*",
        rename: {},
        index,
        cap: DEFAULT_RULE_CAP,
      }),
    ).toEqual({
      ok: true,
      lines: [
        {
          name,
          description: "about constructor",
          detailPath: "/store/constructor.md",
          shortHash: "aaaaaaa",
        },
      ],
    });
  });
});

describe("buildNameIndex", () => {
  test("only selected names are owned, under their renamed identity", () => {
    const index = buildNameIndex(
      installed([
        {
          key: SKILLS,
          names: [GATE, RUBBER_DUCK],
          select: [GATE],
          rename: { [GATE]: GATE_DOTFILES, [RUBBER_DUCK]: NO_PIPE },
        },
      ]),
    );
    expect([...index]).toEqual([[GATE_DOTFILES, SKILLS]]);
  });
});

describe("pruneRenames", () => {
  test("drops a mapping whose upstream name vanished and keeps the rest byte-identical", () => {
    const rename: RenameMap = { [GATE]: GATE_DOTFILES, [RUBBER_DUCK]: NO_PIPE };
    expect(pruneRenames(rename, [GATE])).toEqual({ [GATE]: GATE_DOTFILES });
    expect(pruneRenames(rename, [GATE, RUBBER_DUCK])).toEqual(rename);
    expect(pruneRenames(rename, [])).toEqual({});
  });
});
