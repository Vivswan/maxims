// What would drift silently: a reviewed source whose refresh applies at once, a hold that empties
// or rewrites the block, a held revision the sweep deletes or a removed source's revision that
// survives, a hold the hook path cannot hear or that goes unsaid once it stands, a remote standing
// at the held sha fetched again, a hold kept after upstream returned to the installed revision,
// an up-to-date line printed beside a standing hold, and an unmarked source that stops applying
// at once.
import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { runRemove } from "../../src/commands/remove.ts";
import { renderHookStdout } from "../../src/commands/shared/stdin.ts";
import { runSync } from "../../src/commands/sync.ts";
import type { SyncOptions } from "../../src/commands/types.ts";
import { heldForReview } from "../../src/console/strings.ts";
import type { SourceEntry } from "../../src/state/schema.ts";
import { homePaths, pendingPathFor, storePathFor } from "../../src/util/home.ts";
import {
  daysAgo,
  fakeIo,
  fakeResolvers,
  fetchedEntry,
  fetchedFacts,
  githubFrom,
  readStateFile,
  seedStore,
  stateWith,
  treeDigest,
  writeSource,
  writeState,
} from "../engine/harness.ts";
import { globalRulesFile, TWO_MEMORIES, type World, world } from "../engine/world.ts";

const SYNC: SyncOptions = { quiet: false, dryRun: false, json: false, fetch: "due" };
const NOW = new Date("2026-09-20T12:00:00.000Z");
const DAY_MS = 24 * 60 * 60 * 1000;
const FROM = githubFrom("acme/rules");
const KEY = "@acme/rules";
const SLUG = "acme-rules";

// Upstream's next revision: one description changed, one memory added.
const REVISION_B = {
  ...TWO_MEMORIES,
  "always-review": { description: "Review before every push." },
  "new-rule": { description: "New." },
};

function pendingOf(home: string): Extract<SourceEntry, { pending?: unknown }>["pending"] {
  const entry = readStateFile(home).sources[KEY];
  return entry !== undefined && "pending" in entry ? entry.pending : undefined;
}

function fetchedAt(home: string): string | undefined {
  const entry = readStateFile(home).sources[KEY];
  return entry !== undefined && "fetched" in entry ? entry.fetched?.at : undefined;
}

// Directory A installed from a fetch one day old, recorded as reviewed or not; the first sync
// lands its block and touches no resolver, since the source is inside its cooldown.
async function installed(w: World, review: boolean) {
  const a = writeSource(join(w.dir, "a"), TWO_MEMORIES);
  const b = writeSource(join(w.dir, "b"), REVISION_B);
  seedStore(w.home, FROM, a);
  const facts = await fetchedFacts(a, daysAgo(NOW, 1));
  writeState(
    w.home,
    stateWith({ [KEY]: fetchedEntry(FROM, facts, review ? { review: true } : {}) }),
  );
  const fake = fakeResolvers();
  fake.set(FROM, { kind: "dir", dir: a });
  const io = fakeIo({ home: w.home, userHome: w.userHome, cwd: w.dir, resolvers: fake.resolvers });
  await runSync(SYNC, io);
  const rules = globalRulesFile(w.userHome, SLUG);
  const block = readFileSync(rules, "utf8");
  fake.set(FROM, { kind: "dir", dir: b });
  io.clock.now = new Date(NOW.getTime() + 8 * DAY_MS);
  io.out.length = 0;
  return { a, b, fake, io, rules, block };
}

describe("a reviewed source", () => {
  test("has its refresh held: last-good stays installed, the revision waits under pending", async () => {
    await world(async (w) => {
      const { a, b, io, rules, block } = await installed(w, true);
      const pendingEntry = pendingPathFor(w.home, FROM);
      const dry = await runSync({ ...SYNC, dryRun: true }, io);
      expect(
        dry.plan.changes.some(
          (change) => change.kind === "write" && change.path.startsWith(pendingEntry),
        ),
      ).toBe(true);
      expect(existsSync(pendingEntry)).toBe(false);
      io.out.length = 0;
      const report = await runSync(SYNC, io);
      expect(report.held).toEqual([KEY]);
      expect(report.fetched).toEqual([]);
      expect(readFileSync(rules, "utf8")).toBe(block);
      expect(treeDigest(storePathFor(w.home, FROM))).toBe(treeDigest(a));
      expect(treeDigest(pendingEntry)).toBe(treeDigest(b));
      const now = io.clock.now.toISOString();
      const pending = pendingOf(w.home);
      expect(pending?.sha).toBe((await fetchedFacts(b, now)).sha);
      expect(pending?.at).toBe(now);
      expect(pending?.summary).toEqual([
        expect.stringMatching(/^~ always-review \([0-9a-f]{7} -> [0-9a-f]{7}\)$/),
        "+ new-rule",
      ]);
      expect(fetchedAt(w.home)).toBe(now);
      expect(io.out.join("")).toBe(`!  ${heldForReview(KEY, 2)}\n`);
      const log = readFileSync(homePaths(w.home).log, "utf8");
      expect(log).toContain(`${KEY}: held + new-rule\n`);
      expect(log).toMatch(/@acme\/rules: held ~ always-review \([0-9a-f]{7} -> [0-9a-f]{7}\)\n/);
    });
  });

  test("tells a hook run about the hold in its harness's protocol, and changes no rule", async () => {
    await world(async (w) => {
      const { b, io, rules, block } = await installed(w, true);
      const report = await runSync({ ...SYNC, quiet: true }, io);
      expect(report.held).toEqual([KEY]);
      expect(io.out.join("")).toBe(renderHookStdout("plain", [heldForReview(KEY, 2)]));
      expect(readFileSync(rules, "utf8")).toBe(block);
      expect(treeDigest(pendingPathFor(w.home, FROM))).toBe(treeDigest(b));
    });
  });

  test("replaces a hold with the next revision, reminds while the remote stands at it, and withdraws it when upstream returns to the installed revision", async () => {
    await world(async (w) => {
      const { a, fake, io, rules, block } = await installed(w, true);
      await runSync(SYNC, io);
      const c = writeSource(join(w.dir, "c"), {
        ...TWO_MEMORIES,
        "third-rule": { description: "Third." },
      });
      fake.set(FROM, { kind: "dir", dir: c });
      const second = await runSync({ ...SYNC, fetch: "force" }, io);
      expect(second.held).toEqual([KEY]);
      expect(second.upstreamChanges).toEqual({ [KEY]: ["+ third-rule"] });
      const pending = pendingOf(w.home);
      expect(pending?.sha).toBe((await fetchedFacts(c, "")).sha);
      expect(pending?.summary).toEqual(["+ third-rule"]);
      expect(treeDigest(pendingPathFor(w.home, FROM))).toBe(treeDigest(c));
      expect(readFileSync(rules, "utf8")).toBe(block);
      const stateBytes = readFileSync(homePaths(w.home).state, "utf8");
      fake.calls.length = 0;
      io.out.length = 0;
      const third = await runSync({ ...SYNC, fetch: "force" }, io);
      expect(fake.calls).toEqual([`resolveRef ${KEY}`]);
      expect(third.held).toEqual([KEY]);
      expect(third.upstreamChanges).toEqual({ [KEY]: ["+ third-rule"] });
      expect(io.out.join("")).toBe(`!  ${heldForReview(KEY, 1)}\n`);
      expect(readFileSync(homePaths(w.home).state, "utf8")).toBe(stateBytes);
      fake.set(FROM, { kind: "dir", dir: a });
      fake.calls.length = 0;
      io.out.length = 0;
      const back = await runSync({ ...SYNC, fetch: "force" }, io);
      expect(fake.calls).toEqual([`resolveRef ${KEY}`]);
      expect(back.held).toEqual([]);
      expect(io.out.join("")).not.toContain("held for review");
      expect(pendingOf(w.home)).toBeUndefined();
      expect(existsSync(pendingPathFor(w.home, FROM))).toBe(false);
      expect(readFileSync(rules, "utf8")).toBe(block);
      expect(readFileSync(homePaths(w.home).log, "utf8")).toContain(
        `${KEY}: held revision withdrawn upstream\n`,
      );
    });
  });

  test("keeps saying a standing hold when the cap refuses its last-good block", async () => {
    await world(async (w) => {
      const { io } = await installed(w, true);
      await runSync(SYNC, io);
      writeFileSync(homePaths(w.home).config, JSON.stringify({ ruleCap: 1 }));
      io.clock.now = new Date(io.clock.now.getTime() + 2 * 60 * 1000);
      io.out.length = 0;
      const report = await runSync({ ...SYNC, quiet: true, fetch: "none" }, io);
      expect(report.held).toEqual([KEY]);
      expect(report.upstreamChanges[KEY]).toHaveLength(2);
      expect(io.out.join("")).toContain(heldForReview(KEY, 2));
    });
  });

  test("loses its held revision with its store entry when it is removed", async () => {
    await world(async (w) => {
      const { io } = await installed(w, true);
      await runSync(SYNC, io);
      expect(existsSync(pendingPathFor(w.home, FROM))).toBe(true);
      await runRemove(
        { quiet: false, dryRun: false, json: false, targets: [KEY], all: false, confirmed: true },
        io,
      );
      expect(existsSync(pendingPathFor(w.home, FROM))).toBe(false);
      expect(existsSync(storePathFor(w.home, FROM))).toBe(false);
    });
  });
});

// The control: the same script on an unmarked source applies at once, so the flag is what gates it.
test("an unmarked source applies the same revision at once and holds nothing", async () => {
  await world(async (w) => {
    const { b, io, rules } = await installed(w, false);
    const report = await runSync(SYNC, io);
    expect(report.fetched).toEqual([KEY]);
    expect(report.held).toEqual([]);
    expect(readFileSync(rules, "utf8")).toContain("Review before every push.");
    expect(treeDigest(storePathFor(w.home, FROM))).toBe(treeDigest(b));
    expect(existsSync(pendingPathFor(w.home, FROM))).toBe(false);
    expect(pendingOf(w.home)).toBeUndefined();
    expect(io.out.join("")).not.toContain("held for review");
  });
});
