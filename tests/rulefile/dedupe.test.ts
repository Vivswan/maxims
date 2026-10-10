// Guards the identity rules a user cannot see from the file: a name owned by another source that
// silently became a skip, a rename that stopped applying, a 26th rule truncated instead of refused,
// a later-installed source winning a shared name because timestamps sorted as text, or a memory
// named like an Object prototype member reading a function out of the rename map.
import { describe, expect, test } from "bun:test";
import { contentHashLiteral, type MemoryName } from "../../src/memory/contract.ts";
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

const RULES = "@Octocat/rules";
const DOTFILES = "@Octocat/dotfiles";
const SMALL_COMMITS = "commit-small-and-often" as MemoryName;
const SMALL_COMMITS_DOTFILES = "commit-small-and-often-dotfiles" as MemoryName;
const TIMEOUTS = "prefer-timeouts-to-hangs" as MemoryName;
const ONE_TOPIC = "one-topic-per-pull-request" as MemoryName;
const BRAND_NEW = "brand-new" as MemoryName;

const HASH_A = contentHashLiteral(`sha256:${"a".repeat(64)}`);
const HASH_B = contentHashLiteral(`sha256:${"b".repeat(7)}${"0".repeat(57)}`);

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

describe("the worked example: two sources ship commit-small-and-often", () => {
  const rules: Installed = { key: RULES, names: [SMALL_COMMITS, TIMEOUTS] };
  const dotfiles: Installed = { key: DOTFILES, names: [SMALL_COMMITS, ONE_TOPIC] };

  test("the second source collides on the shared name and nothing resolves", () => {
    const index = buildNameIndex(installed([rules, dotfiles]));
    expect(index.get(SMALL_COMMITS)).toBe(RULES);
    expect(
      resolveSourceCandidates({
        source: DOTFILES,
        memories: [candidate(SMALL_COMMITS), candidate(ONE_TOPIC)],
        select: "*",
        rename: {},
        index,
        cap: DEFAULT_RULE_CAP,
      }),
    ).toEqual({
      ok: false,
      code: ExitCode.NameCollision,
      collisions: [{ name: SMALL_COMMITS, ownedBy: RULES }],
    });
  });

  test("a recorded rename resolves it: two lines, two names, ordered by the name they carry", () => {
    const rename: RenameMap = { [SMALL_COMMITS]: SMALL_COMMITS_DOTFILES };
    const index = buildNameIndex(installed([rules, { ...dotfiles, rename }]));
    expect(index.get(SMALL_COMMITS_DOTFILES)).toBe(DOTFILES);
    expect(index.get(SMALL_COMMITS)).toBe(RULES);
    expect(
      resolveSourceCandidates({
        source: DOTFILES,
        memories: [candidate(ONE_TOPIC, HASH_B), candidate(SMALL_COMMITS)],
        select: "*",
        rename,
        index,
        cap: DEFAULT_RULE_CAP,
      }),
    ).toEqual({
      ok: true,
      lines: [
        {
          name: SMALL_COMMITS_DOTFILES,
          description: `about ${SMALL_COMMITS}`,
          detailPath: `/store/${SMALL_COMMITS}.md`,
          shortHash: "aaaaaaa",
        },
        {
          name: ONE_TOPIC,
          description: `about ${ONE_TOPIC}`,
          detailPath: `/store/${ONE_TOPIC}.md`,
          shortHash: "bbbbbbb",
        },
      ],
    });
  });

  test("the owning source keeps its own name, and an unowned name is free", () => {
    const index = buildNameIndex(
      installed([rules, { ...dotfiles, rename: { [SMALL_COMMITS]: SMALL_COMMITS_DOTFILES } }]),
    );
    const result = resolveSourceCandidates({
      source: RULES,
      memories: [candidate(SMALL_COMMITS), candidate(TIMEOUTS), candidate(BRAND_NEW)],
      select: "*",
      rename: {},
      index,
      cap: DEFAULT_RULE_CAP,
    });
    expect(result.ok).toBe(true);
    if (result.ok)
      expect(result.lines.map((l) => l.name)).toEqual([BRAND_NEW, SMALL_COMMITS, TIMEOUTS]);
  });

  test("installation order decides ownership by instant, not by timestamp text", () => {
    const index = buildNameIndex(
      installed([
        { ...dotfiles, addedAt: "2026-09-01T00:00:00.500Z" },
        { ...rules, addedAt: "2026-09-01T00:00:00Z" },
      ]),
    );
    expect(index.get(SMALL_COMMITS)).toBe(RULES);
  });
});

describe("resolveSourceCandidates", () => {
  test("select narrows before anything else, so an unselected collision never fires", () => {
    const index = buildNameIndex(
      installed([
        { key: RULES, names: [SMALL_COMMITS] },
        { key: DOTFILES, names: [SMALL_COMMITS, ONE_TOPIC], select: [ONE_TOPIC] },
      ]),
    );
    const result = resolveSourceCandidates({
      source: DOTFILES,
      memories: [candidate(SMALL_COMMITS), candidate(ONE_TOPIC)],
      select: [ONE_TOPIC],
      rename: {},
      index,
      cap: DEFAULT_RULE_CAP,
    });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.lines.map((l) => l.name)).toEqual([ONE_TOPIC]);
  });

  test("a rename onto a name the same source also ships is a collision with itself", () => {
    const rename: RenameMap = { [SMALL_COMMITS]: TIMEOUTS };
    const index = buildNameIndex(
      installed([{ key: RULES, names: [SMALL_COMMITS, TIMEOUTS], rename }]),
    );
    expect(
      resolveSourceCandidates({
        source: RULES,
        memories: [candidate(SMALL_COMMITS), candidate(TIMEOUTS)],
        select: "*",
        rename,
        index,
        cap: DEFAULT_RULE_CAP,
      }),
    ).toEqual({
      ok: false,
      code: ExitCode.NameCollision,
      collisions: [{ name: TIMEOUTS, ownedBy: RULES }],
    });
  });

  test("every collision is reported, not just the first", () => {
    const index = buildNameIndex(
      installed([
        { key: RULES, names: [SMALL_COMMITS, TIMEOUTS] },
        { key: DOTFILES, names: [SMALL_COMMITS, TIMEOUTS] },
      ]),
    );
    const result = resolveSourceCandidates({
      source: DOTFILES,
      memories: [candidate(TIMEOUTS), candidate(SMALL_COMMITS)],
      select: "*",
      rename: {},
      index,
      cap: DEFAULT_RULE_CAP,
    });
    expect(result).toEqual({
      ok: false,
      code: ExitCode.NameCollision,
      collisions: [
        { name: SMALL_COMMITS, ownedBy: RULES },
        { name: TIMEOUTS, ownedBy: RULES },
      ],
    });
  });

  test("26 survivors are refused whole at the default cap; 25 render", () => {
    const memories = Array.from({ length: 26 }, (_, i) =>
      candidate(`rule-${String(i).padStart(2, "0")}` as MemoryName),
    );
    const index = buildNameIndex(installed([{ key: RULES, names: memories.map((m) => m.name) }]));
    const resolve = (list: Candidate[]) =>
      resolveSourceCandidates({
        source: RULES,
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
    const index = buildNameIndex(installed([{ key: RULES, names: [name] }]));
    expect(index.get(name)).toBe(RULES);
    expect(
      resolveSourceCandidates({
        source: RULES,
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
          key: RULES,
          names: [SMALL_COMMITS, TIMEOUTS],
          select: [SMALL_COMMITS],
          rename: { [SMALL_COMMITS]: SMALL_COMMITS_DOTFILES, [TIMEOUTS]: ONE_TOPIC },
        },
      ]),
    );
    expect([...index]).toEqual([[SMALL_COMMITS_DOTFILES, RULES]]);
  });
});

describe("pruneRenames", () => {
  test("drops a mapping whose upstream name vanished and keeps the rest byte-identical", () => {
    const rename: RenameMap = { [SMALL_COMMITS]: SMALL_COMMITS_DOTFILES, [TIMEOUTS]: ONE_TOPIC };
    expect(pruneRenames(rename, [SMALL_COMMITS])).toEqual({
      [SMALL_COMMITS]: SMALL_COMMITS_DOTFILES,
    });
    expect(pruneRenames(rename, [SMALL_COMMITS, TIMEOUTS])).toEqual(rename);
    expect(pruneRenames(rename, [])).toEqual({});
  });
});
