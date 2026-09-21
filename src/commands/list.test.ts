// What would drift silently: a listing that reports what state asks for instead of what disk
// holds (a hook the user deleted still "ok", a tier the config demoted still 1, a rename kept
// after the collision it resolved is gone, a lock entry this machine never installed), and a
// `--json` document that hides any of those behind pre-rendered strings.
import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  configEditHarness,
  daysAgo,
  entryFor,
  fakeIo,
  fetchedEntry,
  fetchedFacts,
  githubFrom,
  gitSha,
  localFrom,
  memoryName,
  rulesDirHarness,
  seedStore,
  sharedBlockHarness,
  stateWith,
  writeSource,
  writeState,
} from "../../tests/engine/harness.ts";
import { TWO_MEMORIES, world } from "../../tests/engine/world.ts";
import type { HarnessDefinition } from "../harnesses/contract.ts";
import { ExitCode } from "../util/exit-codes.ts";
import { runList } from "./list.ts";
import { runSync } from "./sync.ts";
import type { ListReport, SyncOptions } from "./types.ts";

const SYNC: SyncOptions = { quiet: false, dryRun: false, json: false, fetch: "none" };
const NOW = new Date("2026-09-20T12:00:00.000Z");

describe("list", () => {
  test("re-derives tier, hook presence, staleness, renames and the lock-only sources", async () => {
    await world(async (w) => {
      const first = writeSource(join(w.dir, "first"), { shared: { description: "First." } });
      const second = writeSource(join(w.dir, "second"), {
        shared: { description: "Second." },
        solo: { description: "Solo." },
      });
      const remote = githubFrom("acme/rules");
      const upstream = writeSource(join(w.dir, "upstream"), TWO_MEMORIES);
      seedStore(w.home, remote, upstream);
      const stale = await fetchedFacts(upstream, daysAgo(NOW, 9), {
        kind: "ratelimit",
        message: "429",
        at: NOW.toISOString(),
      });
      const rename = {
        [memoryName("shared")]: memoryName("shared-second"),
        [memoryName("solo")]: memoryName("solo-local"),
      };
      writeState(
        w.home,
        stateWith(
          {
            [first]: entryFor(localFrom(first), { harnesses: ["claude-code", "codex"] }),
            [second]: {
              ...entryFor(localFrom(second), {
                rename,
                destination: { scope: "project", root: w.project },
              }),
              addedAt: "2026-08-02T00:00:00.000Z",
            },
            "@acme/rules": fetchedEntry(remote, stale),
          },
          { global: ["claude-code"] },
        ),
      );
      const demoted: HarnessDefinition = {
        ...sharedBlockHarness,
        tier: 2,
        achievedTier: async () => 2,
      };
      const io = fakeIo({ ...w, cwd: w.project, harnesses: [rulesDirHarness, demoted] });
      await runSync({ ...SYNC, fetch: "due" }, io);
      mkdirSync(join(w.project, ".agents"), { recursive: true });
      writeFileSync(
        join(w.project, ".agents", "maxims.lock"),
        JSON.stringify({
          version: 1,
          sources: {
            "@acme/other": {
              from: { type: "github", repo: "acme/other" },
              select: "*",
              rule: true,
              harnesses: ["claude-code"],
            },
          },
        }),
      );
      writeFileSync(join(w.userHome, ".fixture", "settings.json"), "{}\n");
      writeFileSync(join(w.home, "config.json"), JSON.stringify({ rule: true, cooldownDays: 3 }));
      io.out.length = 0;
      const report = await runList({ quiet: false, dryRun: false, json: true }, io);
      const document: ListReport = JSON.parse(io.out.join(""));
      expect(document).toEqual(report);
      const byKey = Object.fromEntries(report.sources.map((source) => [source.key, source]));
      expect(
        byKey[first]?.harnesses.map((harness) => [harness.id, harness.tier, harness.hook]),
      ).toEqual([
        ["claude-code", 1, "absent"],
        ["codex", 2, "not-wanted"],
      ]);
      expect(byKey[first]?.harnesses[1]?.tierNote).toBe("no hook");
      expect(byKey[second]?.renames).toEqual([
        { upstreamName: "shared", localName: "shared-second", verdict: "resolves", against: first },
        { upstreamName: "solo", localName: "solo-local", verdict: "unneeded", against: null },
      ]);
      expect(byKey[second]?.memories.map((memory) => memory.localName)).toEqual([
        "shared-second",
        "solo-local",
      ]);
      expect(byKey["@acme/rules"]?.stale).toEqual({
        since: daysAgo(NOW, 9),
        kind: "ratelimit",
        days: 9,
      });
      expect(byKey["@acme/rules"]?.sha).toBe(stale.sha);
      expect(byKey["@acme/rules"]?.tokens).toHaveLength(1);
      expect(report.lockOnly).toEqual(["@acme/other"]);
      expect(report.defaults).toEqual({ agents: null, rule: true, cooldownDays: 3, ruleCap: 25 });

      io.out.length = 0;
      await runList({ quiet: false, dryRun: false, json: false }, io);
      const text = io.out.join("");
      expect(text).toContain("Project memories\n");
      expect(text).toContain("Global memories\n");
      expect(text).toContain(
        `  rename shared -> shared-second still resolves a collision with ${first}\n`,
      );
      expect(text).toContain("  rename solo -> solo-local no longer needed (upstream renamed)\n");
      expect(text).toMatch(
        /@acme\/rules {2}[0-9a-f]{7} {2}fetched 2026-09-11 {2}stale 9d: ratelimit\n/,
      );
      expect(text).toContain(
        "  Agents: claude-code (tier 1, hook absent), codex (tier 2: no hook)  Rules: yes\n",
      );
      expect(text).toContain(
        "  @acme/other: in .agents/maxims.lock, not installed here (run maxims install)\n",
      );
      expect(text.endsWith("Defaults: agents=detected rule=true cooldownDays=3 ruleCap=25\n")).toBe(
        true,
      );
    });
  });

  // The mark and the waiting revision are read from state, and the text beside the source is the
  // one place a user learns what `accept` would apply; the `--json` fields carry the same facts.
  test("a reviewed source shows its mark, and a held revision the accept hint, in text and --json", async () => {
    await world(async (w) => {
      const upstream = writeSource(join(w.dir, "upstream"), TWO_MEMORIES);
      const held = githubFrom("acme/rules");
      const marked = githubFrom("acme/other");
      seedStore(w.home, held, upstream);
      seedStore(w.home, marked, upstream);
      const facts = await fetchedFacts(upstream, daysAgo(NOW, 1));
      const pending = {
        sha: gitSha("b".repeat(40)),
        at: NOW.toISOString(),
        summary: ["~ always-review (aaaaaaa -> bbbbbbb)", "+ new-rule"],
      };
      writeState(
        w.home,
        stateWith({
          "@acme/rules": fetchedEntry(held, facts, { review: true }, pending),
          "@acme/other": fetchedEntry(marked, facts, { review: true }),
        }),
      );
      const io = fakeIo({ ...w, cwd: w.dir });
      const report = await runList({ quiet: false, dryRun: false, json: true }, io);
      const byKey = Object.fromEntries(report.sources.map((source) => [source.key, source]));
      expect(byKey["@acme/rules"]).toMatchObject({ review: true, held: pending });
      expect(byKey["@acme/other"]).toMatchObject({ review: true, held: null });
      io.out.length = 0;
      await runList({ quiet: false, dryRun: false, json: false }, io);
      const text = io.out.join("");
      expect(text).toMatch(
        /@acme\/rules {2}[0-9a-f]{7} {2}fetched 2026-09-19 {2}ok {2}held \(2 changed lines; run maxims accept @acme\/rules\)\n/,
      );
      expect(text).toMatch(/@acme\/other {2}[0-9a-f]{7} {2}fetched 2026-09-19 {2}ok {2}review\n/);
    });
  });

  test("a hook is reported present when only its harness's config entry is pending", async () => {
    await world(async (w) => {
      const source = writeSource(join(w.dir, "src"), TWO_MEMORIES);
      writeState(
        w.home,
        stateWith(
          { [source]: entryFor(localFrom(source), { rule: false }) },
          { global: ["claude-code"] },
        ),
      );
      const io = fakeIo({ ...w, cwd: w.dir, harnesses: [configEditHarness] });
      await runSync(SYNC, io);
      expect(existsSync(join(w.userHome, ".fixture", "settings.json"))).toBe(true);
      expect(existsSync(join(w.userHome, ".fixture", "config.json"))).toBe(false);
      const report = await runList({ quiet: false, dryRun: false, json: true }, io);
      expect(report.sources[0]?.harnesses.map((harness) => harness.hook)).toEqual(["ok"]);
    });
  });

  test("a rename onto a name another source only hides is reported as no longer needed", async () => {
    await world(async (w) => {
      const hider = writeSource(join(w.dir, "hider"), {
        secret: { description: "Hidden.", internal: true },
        open: { description: "Open." },
      });
      const renamer = writeSource(join(w.dir, "renamer"), { secret: { description: "Mine." } });
      const rename = { [memoryName("secret")]: memoryName("secret-b") };
      writeState(
        w.home,
        stateWith({
          [hider]: entryFor(localFrom(hider)),
          [renamer]: {
            ...entryFor(localFrom(renamer), { rename }),
            addedAt: "2026-08-02T00:00:00.000Z",
          },
        }),
      );
      const io = fakeIo({ ...w, cwd: w.dir });
      await runSync({ ...SYNC, fetch: "due" }, io);
      const report = await runList({ quiet: false, dryRun: false, json: true }, io);
      expect(report.sources.find((source) => source.key === renamer)?.renames).toEqual([
        { upstreamName: "secret", localName: "secret-b", verdict: "unneeded", against: null },
      ]);
    });
  });

  test("a rename against an unreadable older source still reports the collision it resolves", async () => {
    await world(async (w) => {
      const older = writeSource(join(w.dir, "older"), { alpha: { description: "Older." } });
      const from = githubFrom("acme/older");
      const facts = await fetchedFacts(older, daysAgo(NOW, 1));
      const renamer = writeSource(join(w.dir, "renamer"), { alpha: { description: "Mine." } });
      const rename = { [memoryName("alpha")]: memoryName("alpha-local") };
      writeState(
        w.home,
        stateWith({
          "@acme/older": fetchedEntry(from, facts),
          [renamer]: {
            ...entryFor(localFrom(renamer), { rename }),
            addedAt: "2026-08-02T00:00:00.000Z",
          },
        }),
      );
      seedStore(w.home, localFrom(renamer), renamer);
      const io = fakeIo({ ...w, cwd: w.dir });
      const report = await runList({ quiet: false, dryRun: false, json: true }, io);
      expect(report.sources.find((source) => source.key === renamer)?.renames).toEqual([
        {
          upstreamName: "alpha",
          localName: "alpha-local",
          verdict: "resolves",
          against: "@acme/older",
        },
      ]);
    });
  });

  test("a rename against an unreadable older live source still reads as resolving", async () => {
    await world(async (w) => {
      const older = writeSource(join(w.dir, "older"), { alpha: { description: "Older." } });
      const renamer = writeSource(join(w.dir, "renamer"), { alpha: { description: "Mine." } });
      const rename = { [memoryName("alpha")]: memoryName("alpha-local") };
      writeState(
        w.home,
        stateWith({
          [older]: entryFor(localFrom(older, true)),
          [renamer]: {
            ...entryFor(localFrom(renamer), { rename }),
            addedAt: "2026-08-02T00:00:00.000Z",
          },
        }),
      );
      const io = fakeIo({ ...w, cwd: w.dir });
      await runSync({ ...SYNC, fetch: "due" }, io);
      const { rmSync } = await import("node:fs");
      rmSync(older, { recursive: true });
      const report = await runList({ quiet: false, dryRun: false, json: true }, io);
      expect(report.sources.find((source) => source.key === renamer)?.renames).toEqual([
        { upstreamName: "alpha", localName: "alpha-local", verdict: "resolves", against: older },
      ]);
    });
  });

  test("an unreadable source's selection and renames count once, as the local names it holds", async () => {
    await world(async (w) => {
      const older = writeSource(join(w.dir, "older"), {
        alpha: { description: "Older alpha." },
        gamma: { description: "Older gamma." },
      });
      const from = githubFrom("acme/older");
      const facts = await fetchedFacts(older, daysAgo(NOW, 1));
      const olderEntry = fetchedEntry(from, facts, {
        select: [memoryName("alpha")],
        rename: { [memoryName("alpha")]: memoryName("beta") },
      });
      const renamer = writeSource(join(w.dir, "renamer"), { beta: { description: "Mine." } });
      const rename = { [memoryName("beta")]: memoryName("beta-local") };
      writeState(
        w.home,
        stateWith({
          "@acme/older": olderEntry,
          [renamer]: {
            ...entryFor(localFrom(renamer), { rename }),
            addedAt: "2026-08-02T00:00:00.000Z",
          },
        }),
      );
      seedStore(w.home, localFrom(renamer), renamer);
      const io = fakeIo({ ...w, cwd: w.dir });
      const report = await runList({ quiet: false, dryRun: false, json: true }, io);
      expect(report.sources.find((source) => source.key === renamer)?.renames).toEqual([
        {
          upstreamName: "beta",
          localName: "beta-local",
          verdict: "resolves",
          against: "@acme/older",
        },
      ]);
    });
  });

  test("a fresh clone with a lock and no state still lists the lock's sources", async () => {
    await world(async (w) => {
      mkdirSync(join(w.project, ".agents"), { recursive: true });
      writeFileSync(
        join(w.project, ".agents", "maxims.lock"),
        JSON.stringify({
          version: 1,
          sources: {
            "@acme/team": {
              from: { type: "github", repo: "acme/team" },
              select: "*",
              rule: true,
              harnesses: ["claude-code"],
            },
          },
        }),
      );
      const io = fakeIo({ ...w, cwd: w.project });
      const report = await runList({ quiet: false, dryRun: false, json: false }, io);
      expect(report.lockOnly).toEqual(["@acme/team"]);
      expect(io.out.join("")).toContain(
        "  @acme/team: in .agents/maxims.lock, not installed here (run maxims install)\n",
      );
      // A shared entry of this project carries its marker; one recorded for a project whose
      // folder is gone is listed with that root and never resolved against this one.
      const shared = writeSource(join(w.dir, "shared"), TWO_MEMORIES);
      const gone = join(w.dir, "gone-project");
      writeState(
        w.home,
        stateWith({
          [shared]: entryFor(localFrom(shared), {
            destination: { scope: "project", root: w.project },
            shared: true,
          }),
          "@acme/lost": entryFor(githubFrom("acme/lost"), {
            destination: { scope: "project", root: gone },
          }),
        }),
      );
      io.out.length = 0;
      const listed = await runList({ quiet: false, dryRun: false, json: false }, io);
      const byKey = Object.fromEntries(listed.sources.map((source) => [source.key, source]));
      expect(byKey[shared]?.shared).toBe(true);
      expect(byKey[shared]?.project).toEqual({ root: w.project, here: true, rootMissing: false });
      expect(byKey["@acme/lost"]?.project).toEqual({ root: gone, here: false, rootMissing: true });
      expect(byKey["@acme/lost"]?.harnesses.map((harness) => harness.skipped)).toEqual([
        "another project",
      ]);
      const text = io.out.join("");
      expect(text).toContain(`${shared}  -  not fetched yet  shared\n`);
      expect(text).toContain(`  installed for ${gone} (project folder missing)\n`);
      // A project entry's switched-off names are its own project's, and a lock entry state holds
      // only for another project is still not installed here.
      const otherProject = join(w.dir, "other-project");
      const theirs = writeSource(join(w.dir, "theirs"), TWO_MEMORIES);
      mkdirSync(join(otherProject, ".git"), { recursive: true });
      writeState(
        w.home,
        stateWith(
          {
            [theirs]: entryFor(localFrom(theirs, true), {
              destination: { scope: "project", root: otherProject },
            }),
            "@acme/team": entryFor(githubFrom("acme/team"), {
              destination: { scope: "project", root: otherProject },
            }),
          },
          undefined,
          { project: { [otherProject]: [memoryName("always-review")] } },
        ),
      );
      const away = await runList({ quiet: false, dryRun: false, json: false }, io);
      const theirsListed = away.sources.find((source) => source.key === theirs);
      expect(theirsListed?.memories.map((memory) => [memory.localName, memory.disabled])).toEqual([
        ["keep-tests-green", false],
        ["always-review", true],
      ]);
      expect(away.lockOnly).toEqual(["@acme/team"]);
      // A rename resolves a collision only against entries that apply together with the source.
      const mine = writeSource(join(w.dir, "mine"), { alpha: { description: "Mine." } });
      const rival = writeSource(join(w.dir, "rival"), { alpha: { description: "Rival." } });
      writeState(
        w.home,
        stateWith({
          [mine]: entryFor(localFrom(mine, true), {
            destination: { scope: "project", root: w.project },
            rename: { [memoryName("alpha")]: memoryName("alpha-mine") },
          }),
          [rival]: entryFor(localFrom(rival, true), {
            destination: { scope: "project", root: otherProject },
          }),
        }),
      );
      const renamed = await runList({ quiet: false, dryRun: false, json: false }, io);
      expect(renamed.sources.find((source) => source.key === mine)?.renames).toEqual([
        { upstreamName: "alpha", localName: "alpha-mine", verdict: "unneeded", against: null },
      ]);
      // Another project's rename is judged against that project's own entries, wherever the
      // listing runs.
      const theirFirst = writeSource(join(w.dir, "their-first"), {
        alpha: { description: "First." },
      });
      const theirSecond = writeSource(join(w.dir, "their-second"), {
        alpha: { description: "Second." },
      });
      writeState(
        w.home,
        stateWith({
          [theirFirst]: entryFor(localFrom(theirFirst, true), {
            destination: { scope: "project", root: otherProject },
          }),
          [theirSecond]: {
            ...entryFor(localFrom(theirSecond, true), {
              destination: { scope: "project", root: otherProject },
              rename: { [memoryName("alpha")]: memoryName("alpha-second") },
            }),
            addedAt: "2026-08-02T00:00:00.000Z",
          },
        }),
      );
      const elsewhere = await runList({ quiet: false, dryRun: false, json: false }, io);
      expect(elsewhere.sources.find((source) => source.key === theirSecond)?.renames).toEqual([
        {
          upstreamName: "alpha",
          localName: "alpha-second",
          verdict: "resolves",
          against: theirFirst,
        },
      ]);
    });
  });

  test("a remote source never fetched is not called live", async () => {
    await world(async (w) => {
      const from = githubFrom("acme/rules");
      writeState(w.home, stateWith({ "@acme/rules": entryFor(from) }));
      const io = fakeIo({ ...w, cwd: w.dir });
      const report = await runList({ quiet: false, dryRun: false, json: false }, io);
      expect(report.sources[0]?.live).toBe(false);
      expect(io.out.join("")).toContain("@acme/rules  -  not fetched yet\n");
    });
  });

  test("a harness whose project folder is a file is listed as skipped, hook unprobed", async () => {
    await world(async (w) => {
      const { rmSync } = await import("node:fs");
      rmSync(join(w.project, ".fixture"), { recursive: true });
      writeFileSync(join(w.project, ".fixture"), "legacy single file");
      const source = writeSource(join(w.dir, "src"), TWO_MEMORIES);
      const entry = entryFor(localFrom(source), {
        destination: { scope: "project", root: w.project },
      });
      writeState(
        w.home,
        stateWith({ [source]: entry }, { project: { [w.project]: ["claude-code"] } }),
      );
      const io = fakeIo({ ...w, cwd: w.project });
      const report = await runList({ quiet: false, dryRun: false, json: true }, io);
      const [harness] = report.sources[0]?.harnesses ?? [];
      expect(harness?.skipped).toContain("is a file, not the directory");
      expect(harness?.hook).toBe("not-wanted");
    });
  });

  // `--json` is one document or nothing to a caller parsing stdout, a lock path that cannot be
  // read included; the read that could not look is exit 4, never a usage error.
  test("--json prints one ok:false document when the lock path is a directory", async () => {
    await world(async ({ home, dir, userHome, project }) => {
      const source = writeSource(join(dir, "src"), TWO_MEMORIES);
      writeState(home, stateWith({ [source]: entryFor(localFrom(source)) }));
      mkdirSync(join(project, ".agents", "maxims.lock"), { recursive: true });
      const io = fakeIo({ home, userHome, cwd: project });
      const thrown = await runList({ quiet: false, dryRun: false, json: true }, io).then(
        () => null,
        (error: unknown) => error,
      );
      expect(thrown).toBeInstanceOf(Error);
      expect(io.out).toHaveLength(1);
      const document = JSON.parse(io.out[0] ?? "");
      expect(document).toEqual({
        ok: false,
        code: ExitCode.DestinationWriteFailed,
        message: expect.stringContaining("EISDIR"),
        hint: null,
      });
    });
  });

  test("nothing installed prints the same line sync does", async () => {
    await world(async (w) => {
      const io = fakeIo({ ...w, cwd: w.dir });
      const report = await runList({ quiet: false, dryRun: false, json: false }, io);
      expect(report.sources).toEqual([]);
      expect(io.out.join("")).toBe(
        "maxims: nothing installed\nDefaults: agents=detected rule=false cooldownDays=7 ruleCap=25\n",
      );
    });
  });
});
