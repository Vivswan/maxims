// What would drift silently: a removal that leaves a rule file, a body link, a store entry or a
// hook behind; one that deletes a user's own line from a shared file or a live source's files; a
// bare name that silently picks one of two owners; a `*` selection that lets the removed memory
// return on the next refresh; a refused (unconfirmed) removal that still changes something; and a
// project-scope removal that leaves the committed lock naming the source.
import { describe, expect, test } from "bun:test";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import {
  ADDED_AT,
  entryFor,
  fakeIo,
  fakeResolvers,
  fetchedEntry,
  fetchedFacts,
  githubFrom,
  localFrom,
  memoryFile,
  memoryName,
  readStateFile,
  seedStore,
  stateWith,
  treeDigest,
  writeSource,
  writeState,
} from "../../tests/engine/harness.ts";
import { expectExit, globalRulesFile, TWO_MEMORIES, world } from "../../tests/engine/world.ts";
import { HOOK_COMMAND } from "../harnesses/contract.ts";
import { ExitCode } from "../util/exit-codes.ts";
import { homePaths, storePathFor } from "../util/home.ts";
import { runRemove } from "./remove.ts";
import { sourceSlug } from "./shared/slug.ts";
import { runSync } from "./sync.ts";
import type { RemoveOptions, SyncOptions } from "./types.ts";

const SYNC: SyncOptions = {
  quiet: false,
  dryRun: false,
  json: false,
  fetch: "due",
};
const REMOVE: RemoveOptions = {
  quiet: false,
  dryRun: false,
  json: false,
  targets: [],
  all: false,
  confirmed: true,
};

describe("remove", () => {
  test("a dry run on a corrupt state file refuses and leaves the file byte-identical", async () => {
    await world(async ({ home, dir, userHome }) => {
      const path = homePaths(home).state;
      mkdirSync(home, { recursive: true });
      writeFileSync(path, "{not json");
      const io = fakeIo({ home, userHome, cwd: dir });
      const error = await expectExit(
        runRemove({ ...REMOVE, dryRun: true, targets: ["anything"] }, io),
        ExitCode.Usage,
      );
      expect(error.message).toMatch(
        /^maxims: state\.json is corrupt: .*; run maxims sync to quarantine it$/,
      );
      expect(readFileSync(path, "utf8")).toBe("{not json");
      expect(existsSync(homePaths(home).lock)).toBe(false);
    });
  });

  test("removing the last source returns the user home to its pre-add bytes and clears the hook", async () => {
    await world(async ({ home, dir, userHome }) => {
      const source = writeSource(join(dir, "src"), TWO_MEMORIES);
      const shared = join(userHome, ".fixture", "FIXTURE.md");
      writeFileSync(shared, "# Mine\n\nKeep this.\n");
      const before = treeDigest(userHome);
      const entry = entryFor(localFrom(source), { harnesses: ["claude-code", "codex"] });
      writeState(home, stateWith({ [source]: entry }, ["claude-code", "codex"]));
      const io = fakeIo({ home, userHome, cwd: dir });
      await runSync(SYNC, io);
      expect(treeDigest(userHome)).not.toBe(before);
      const report = await runRemove({ ...REMOVE, targets: [source] }, io);
      expect(io.out.join("")).toContain(
        "Memories to remove:\n  - always-review\n  - keep-tests-green\n",
      );
      expect(report.notices).toContain("Removed 2 memories");
      expect(readFileSync(shared, "utf8")).toBe("# Mine\n\nKeep this.\n");
      expect(existsSync(join(userHome, ".fixture", "rules"))).toBe(false);
      expect(readFileSync(join(userHome, ".fixture", "settings.json"), "utf8")).not.toContain(
        HOOK_COMMAND,
      );
      expect(existsSync(join(userHome, ".fixture", "hooks", "start"))).toBe(false);
      expect(existsSync(storePathFor(home, localFrom(source)))).toBe(false);
      expect(readStateFile(home)).toEqual(expect.objectContaining({ hooks: [], sources: {} }));
    });
  });

  test("a bare name materializes the rest of a `*` selection, so a refresh cannot bring it back", async () => {
    await world(async ({ home, dir, userHome }) => {
      const source = writeSource(join(dir, "src"), TWO_MEMORIES);
      writeState(home, stateWith({ [source]: entryFor(localFrom(source)) }));
      const io = fakeIo({ home, userHome, cwd: dir });
      await runSync(SYNC, io);
      await runRemove({ ...REMOVE, targets: ["keep-tests-green"] }, io);
      expect(readStateFile(home).sources[source]?.intent.select).toEqual([
        memoryName("always-review"),
      ]);
      const text = readFileSync(globalRulesFile(userHome, sourceSlug(localFrom(source))), "utf8");
      expect(text).toContain("Review before every commit.");
      expect(text).not.toContain("Never merge red.");
      io.clock.now = new Date(io.clock.now.getTime() + 9 * 24 * 60 * 60 * 1000);
      await runSync(SYNC, io);
      expect(readFileSync(globalRulesFile(userHome, sourceSlug(localFrom(source))), "utf8")).toBe(
        text,
      );
    });
  });

  test("a bare name two sources provide is refused with both qualified forms and no change", async () => {
    await world(async ({ home, dir, userHome }) => {
      const first = writeSource(join(dir, "first"), { shared: { description: "First." } });
      const second = writeSource(join(dir, "second"), { shared: { description: "Second." } });
      const rename = { [memoryName("shared")]: memoryName("shared-second") };
      const later = {
        ...entryFor(localFrom(second), { rename }),
        addedAt: "2026-08-02T00:00:00.000Z",
      };
      const third = writeSource(join(dir, "third"), { shared: { description: "Third." } });
      const rival = {
        ...entryFor(localFrom(third), { rename: { [memoryName("shared")]: memoryName("shared") } }),
        addedAt: "2026-08-03T00:00:00.000Z",
      };
      writeState(
        home,
        stateWith({ [first]: entryFor(localFrom(first)), [second]: later, [third]: rival }),
      );
      for (const source of [first, second, third]) seedStore(home, localFrom(source), source);
      const io = fakeIo({ home, userHome, cwd: dir });
      const digest = treeDigest(userHome);
      const error = await expectExit(
        runRemove({ ...REMOVE, targets: ["shared"] }, io),
        ExitCode.Usage,
      );
      expect(error.message).toBe(
        `shared is provided by more than one source: ${first}/shared, ${third}/shared`,
      );
      expect(treeDigest(userHome)).toBe(digest);
    });
  });

  test("-a drops one harness's artifacts and keeps the entry, and the bodies, the other uses", async () => {
    await world(async ({ home, dir, userHome, project }) => {
      const source = writeSource(join(dir, "src"), TWO_MEMORIES);
      const entry = entryFor(localFrom(source), {
        harnesses: ["claude-code", "codex"],
        destination: { scope: "project" },
      });
      writeState(home, stateWith({ [source]: entry }));
      const io = fakeIo({ home, userHome, cwd: project });
      await runSync(SYNC, io);
      const body = join(project, ".agents", "memories", "always-review.md");
      await runRemove({ ...REMOVE, targets: [source], agents: ["claude-code"] }, io);
      expect(readStateFile(home).sources[source]?.intent.harnesses).toEqual(["codex"]);
      expect(existsSync(join(project, ".fixture", "rules"))).toBe(false);
      expect(readFileSync(join(project, "FIXTURE.md"), "utf8")).toContain("Never merge red.");
      expect(lstatSync(body).isSymbolicLink()).toBe(true);
      await runRemove({ ...REMOVE, targets: [source], agents: ["codex"] }, io);
      expect(readStateFile(home).sources[source]).toBeUndefined();
      expect(existsSync(join(project, "FIXTURE.md"))).toBe(false);
      expect(lstatSync(body, { throwIfNoEntry: false })).toBeUndefined();
    });
  });

  test("--all removes every source; an unconfirmed removal aborts with exit 1 and changes nothing", async () => {
    await world(async ({ home, dir, userHome }) => {
      const first = writeSource(join(dir, "first"), { one: { description: "One." } });
      const second = writeSource(join(dir, "second"), { two: { description: "Two." } });
      writeState(
        home,
        stateWith({ [first]: entryFor(localFrom(first)), [second]: entryFor(localFrom(second)) }),
      );
      const io = fakeIo({ home, userHome, cwd: dir });
      await runSync(SYNC, io);
      const digest = treeDigest(userHome);
      const stateBefore = readFileSync(homePaths(home).state, "utf8");
      const refused = runRemove({ ...REMOVE, targets: [first], confirmed: false }, io);
      const error = await expectExit(refused, ExitCode.Usage);
      expect(error.message).toBe("Removal cancelled");
      expect(io.out.join("")).toContain("Memories to remove:\n  - one\nRemoval cancelled\n");
      expect(treeDigest(userHome)).toBe(digest);
      expect(readFileSync(homePaths(home).state, "utf8")).toBe(stateBefore);
      await runRemove({ ...REMOVE, all: true }, io);
      expect(readStateFile(home).sources).toEqual({});
      expect(existsSync(join(userHome, ".fixture", "rules"))).toBe(false);
    });
  });

  test("a live source loses its link and rule file while its own directory stays byte-identical", async () => {
    await world(async ({ home, dir, userHome }) => {
      const live = writeSource(join(dir, "live"), TWO_MEMORIES);
      const digest = treeDigest(live);
      writeState(home, stateWith({ [live]: entryFor(localFrom(live, true)) }));
      const io = fakeIo({ home, userHome, cwd: dir });
      await runSync(SYNC, io);
      expect(existsSync(storePathFor(home, localFrom(live, true)))).toBe(true);
      await runRemove({ ...REMOVE, targets: [live] }, io);
      expect(existsSync(storePathFor(home, localFrom(live, true)))).toBe(false);
      expect(existsSync(join(userHome, ".fixture", "rules"))).toBe(false);
      expect(treeDigest(live)).toBe(digest);
    });
  });

  test("a live source's project bodies link into the store, stay put on resync, and leave on removal", async () => {
    await world(async ({ home, dir, userHome, project }) => {
      const live = writeSource(join(dir, "live"), TWO_MEMORIES);
      const entry = entryFor(localFrom(live, true), { destination: { scope: "project" } });
      writeState(home, stateWith({ [live]: entry }));
      const io = fakeIo({ home, userHome, cwd: project });
      await runSync(SYNC, io);
      const second = await runSync(SYNC, io);
      expect(second.plan.changes).toEqual([]);
      const link = join(project, ".agents", "memories", "always-review.md");
      const target = resolve(dirname(link), readlinkSync(link));
      expect(target.startsWith(realpathSync(homePaths(home).store))).toBe(true);
      await runRemove({ ...REMOVE, all: true }, io);
      expect(lstatSync(link, { throwIfNoEntry: false })).toBeUndefined();
    });
  });

  test("a project-scope removal unlinks bodies, deletes copies it wrote, and rewrites the lock", async () => {
    await world(async ({ home, userHome, project }) => {
      const source = writeSource(join(project, "src"), TWO_MEMORIES);
      const other = writeSource(join(project, "other"), { three: { description: "Three." } });
      const projectEntry = (path: string, copy: boolean) =>
        entryFor(localFrom(path), { destination: { scope: "project" }, copy });
      writeState(
        home,
        stateWith({ [source]: projectEntry(source, true), [other]: projectEntry(other, false) }),
      );
      const io = fakeIo({ home, userHome, cwd: project });
      await runSync(SYNC, io);
      const bodies = join(project, ".agents", "memories");
      writeFileSync(join(bodies, "mine.md"), "the user's own note\n");
      mkdirSync(join(project, ".agents"), { recursive: true });
      await runRemove({ ...REMOVE, targets: [source] }, io);
      expect(existsSync(join(bodies, "always-review.md"))).toBe(false);
      expect(existsSync(join(bodies, "three.md"))).toBe(true);
      expect(readFileSync(join(bodies, "mine.md"), "utf8")).toBe("the user's own note\n");
      const lock = JSON.parse(readFileSync(join(project, ".agents", "maxims.lock"), "utf8"));
      expect(Object.keys(lock.sources)).toEqual(["./other"]);
      expect(lock.sources["./other"].from).toEqual({ type: "local", path: "./other" });
      await runRemove({ ...REMOVE, targets: [other] }, io);
      expect(existsSync(join(project, ".agents", "maxims.lock"))).toBe(false);
      expect(existsSync(join(bodies, "three.md"))).toBe(false);
    });
  });

  test("two names removed in one call both leave, and an internal memory kept by opt-in survives", async () => {
    await world(async ({ home, dir, userHome }) => {
      const source = writeSource(join(dir, "src"), {
        alpha: { description: "A." },
        beta: { description: "B." },
        gamma: { description: "G." },
        secret: { description: "S.", internal: true },
      });
      writeState(home, stateWith({ [source]: entryFor(localFrom(source)) }));
      const io = fakeIo({ home, userHome, cwd: dir, env: { MAXIMS_INSTALL_INTERNAL: "1" } });
      await runSync(SYNC, io);
      await runRemove({ ...REMOVE, targets: ["alpha", "beta"] }, io);
      expect(readStateFile(home).sources[source]?.intent.select).toEqual([
        memoryName("gamma"),
        memoryName("secret"),
      ]);
      await runRemove({ ...REMOVE, targets: ["gamma"] }, io);
      expect(readStateFile(home).sources[source]?.intent.select).toEqual([memoryName("secret")]);
    });
  });

  test("a GitHub source matches its key case-insensitively, but a pin is compared as typed", async () => {
    await world(async ({ home, dir, userHome }) => {
      const upstream = writeSource(join(dir, "upstream"), TWO_MEMORIES);
      const entries: Record<string, ReturnType<typeof fetchedEntry>> = {};
      for (const ref of ["Release", "release"]) {
        const from = githubFrom("Acme/Rules", ref);
        seedStore(home, from, upstream);
        entries[`@Acme/Rules#${ref}`] = fetchedEntry(from, await fetchedFacts(upstream, ADDED_AT));
      }
      writeState(home, stateWith(entries));
      const io = fakeIo({ home, userHome, cwd: dir });
      await runRemove({ ...REMOVE, targets: ["https://github.com/acme/rules/tree/release"] }, io);
      expect(Object.keys(readStateFile(home).sources)).toEqual(["@Acme/Rules#Release"]);
      await runRemove({ ...REMOVE, targets: ["@acme/rules#Release", "@acme/rules#Release"] }, io);
      expect(readStateFile(home).sources).toEqual({});
    });
  });

  test("removing the last project source and an -o source takes their bodies and files with them", async () => {
    await world(async ({ home, dir, userHome, project }) => {
      const source = writeSource(join(dir, "src"), TWO_MEMORIES);
      const team = writeSource(join(dir, "team"), { "team-rule": { description: "Team." } });
      const out = join(dir, "out");
      mkdirSync(out);
      writeState(
        home,
        stateWith({
          [source]: entryFor(localFrom(source), { destination: { scope: "project" } }),
          "@acme/team": entryFor(githubFrom("acme/team"), {
            destination: { scope: "out", path: out },
          }),
        }),
      );
      const fake = fakeResolvers();
      fake.set(githubFrom("acme/team"), { kind: "dir", dir: team });
      const io = fakeIo({ home, userHome, cwd: project, resolvers: fake.resolvers });
      await runSync(SYNC, io);
      const link = join(project, ".agents", "memories", "always-review.md");
      expect(lstatSync(link).isSymbolicLink()).toBe(true);
      expect(existsSync(join(out, "maxims-acme-team.md"))).toBe(true);
      expect(lstatSync(join(out, "memories", "team-rule.md")).isSymbolicLink()).toBe(true);
      await runRemove({ ...REMOVE, all: true }, io);
      expect(lstatSync(link, { throwIfNoEntry: false })).toBeUndefined();
      expect(existsSync(join(out, "maxims-acme-team.md"))).toBe(false);
      expect(
        lstatSync(join(out, "memories", "team-rule.md"), { throwIfNoEntry: false }),
      ).toBeUndefined();
    });
  });

  // The `-o` rule file's name is derived, so a user may have a file of their own at it once the
  // rules are switched off; only a file carrying maxims markers is ours to take away.
  test("removing an -o source leaves a marker-less file at its rule file's name alone", async () => {
    await world(async ({ home, dir, userHome }) => {
      const source = writeSource(join(dir, "src"), TWO_MEMORIES);
      const out = join(dir, "out");
      mkdirSync(out);
      const entry = entryFor(localFrom(source), {
        destination: { scope: "out", path: out },
        rule: false,
      });
      writeState(home, stateWith({ [source]: entry }));
      const io = fakeIo({ home, userHome, cwd: dir });
      await runSync(SYNC, io);
      const own = join(out, `maxims-${sourceSlug(localFrom(source))}.md`);
      writeFileSync(own, "# My notes\n");
      await runRemove({ ...REMOVE, all: true }, io);
      expect(readFileSync(own, "utf8")).toBe("# My notes\n");
    });
  });

  test("a bare name is found by its installed local name even when the rename map is stale", async () => {
    await world(async ({ home, dir, userHome }) => {
      const live = writeSource(join(dir, "live"), {
        alpha: { description: "Alpha." },
        gamma: { description: "Gamma." },
      });
      const rename = { [memoryName("alpha")]: memoryName("beta") };
      writeState(home, stateWith({ [live]: entryFor(localFrom(live, true), { rename }) }));
      const io = fakeIo({ home, userHome, cwd: dir });
      await runSync(SYNC, io);
      rmSync(join(live, "memories", "alpha.md"));
      writeFileSync(
        join(live, "memories", "beta.md"),
        memoryFile("beta", { description: "Beta." }),
      );
      await runRemove({ ...REMOVE, targets: ["beta"] }, io);
      expect(readStateFile(home).sources[live]?.intent.select).toEqual([memoryName("gamma")]);
      const text = readFileSync(
        globalRulesFile(userHome, sourceSlug(localFrom(live, true))),
        "utf8",
      );
      expect(text).not.toContain("Beta.");
      expect(text).toContain("Gamma.");
    });
  });

  test("a bare name of a source whose store copy is gone is refused, not silently kept", async () => {
    await world(async ({ home, dir, userHome }) => {
      const upstream = writeSource(join(dir, "upstream"), TWO_MEMORIES);
      const from = githubFrom("acme/rules");
      const entry = fetchedEntry(from, await fetchedFacts(upstream, ADDED_AT));
      writeState(home, stateWith({ "@acme/rules": entry }));
      const io = fakeIo({ home, userHome, cwd: dir });
      const refused = runRemove({ ...REMOVE, targets: ["always-review"] }, io);
      const error = await expectExit(refused, ExitCode.SourceUnresolvable);
      expect(error.message).toBe(
        "@acme/rules cannot be read here, so always-review cannot be removed on its own",
      );
      expect(readStateFile(home).sources["@acme/rules"]?.intent.select).toBe("*");
      await runRemove({ ...REMOVE, targets: ["@acme/rules"] }, io);
      expect(readStateFile(home).sources).toEqual({});
    });
  });

  test("a bare name of an unreadable live source is refused, its retained block naming the owner", async () => {
    await world(async ({ home, dir, userHome, project }) => {
      const live = writeSource(join(dir, "live"), { alpha: { description: "Alpha." } });
      const entry = entryFor(localFrom(live, true), {
        destination: { scope: "project" },
        copy: true,
      });
      writeState(home, stateWith({ [live]: entry }));
      const io = fakeIo({ home, userHome, cwd: project });
      await runSync(SYNC, io);
      rmSync(live, { recursive: true });
      const refused = runRemove({ ...REMOVE, targets: ["alpha"] }, io);
      const error = await expectExit(refused, ExitCode.SourceUnresolvable);
      expect(error.message).toBe(
        `${live} cannot be read here, so alpha cannot be removed on its own`,
      );
    });
  });

  test("-a on an unreadable source still strips that harness's block", async () => {
    await world(async ({ home, dir, userHome }) => {
      const upstream = writeSource(join(dir, "upstream"), TWO_MEMORIES);
      const from = githubFrom("acme/rules");
      seedStore(home, from, upstream);
      const facts = await fetchedFacts(upstream, ADDED_AT);
      writeState(
        home,
        stateWith({
          "@acme/rules": fetchedEntry(from, facts, { harnesses: ["claude-code", "codex"] }),
        }),
      );
      const io = fakeIo({ home, userHome, cwd: dir });
      await runSync({ ...SYNC, fetch: "none" }, io);
      const shared = join(userHome, ".fixture", "FIXTURE.md");
      expect(readFileSync(shared, "utf8")).toContain("Never merge red.");
      rmSync(storePathFor(home, from), { recursive: true });
      await runRemove({ ...REMOVE, targets: ["@acme/rules"], agents: ["codex"] }, io);
      expect(existsSync(shared)).toBe(false);
      expect(existsSync(globalRulesFile(userHome, "acme-rules"))).toBe(true);
    });
  });

  test("-a leaves a source alone when it never listed that harness, lock included", async () => {
    await world(async ({ home, dir, userHome, project }) => {
      const none = writeSource(join(dir, "none"), { one: { description: "One." } });
      const some = writeSource(join(dir, "some"), { two: { description: "Two." } });
      writeState(
        home,
        stateWith({
          [none]: entryFor(localFrom(none), { destination: { scope: "project" }, harnesses: [] }),
          [some]: entryFor(localFrom(some), { harnesses: ["codex"] }),
        }),
      );
      const io = fakeIo({ home, userHome, cwd: project });
      await runSync(SYNC, io);
      // A lock entry another machine committed must survive a removal that changed no
      // project-scoped intent, so the lock is written only when one did.
      const lockPath = join(project, ".agents", "maxims.lock");
      const lockBefore = `${JSON.stringify(
        {
          version: 1,
          sources: {
            "@acme/rules": {
              from: { type: "github", repo: "acme/rules" },
              select: "*",
              rule: true,
              harnesses: ["codex"],
            },
          },
        },
        null,
        2,
      )}\n`;
      mkdirSync(join(project, ".agents"), { recursive: true });
      writeFileSync(lockPath, lockBefore);
      await runRemove({ ...REMOVE, targets: [none, some], agents: ["codex"] }, io);
      const state = readStateFile(home);
      expect(Object.keys(state.sources)).toEqual([none]);
      expect(io.out.join("")).toContain(`${none} is not installed for codex\n`);
      expect(readFileSync(lockPath, "utf8")).toBe(lockBefore);
    });
  });

  test("-a with a bare memory name is refused, since a memory has no per-harness half", async () => {
    await world(async ({ home, dir, userHome }) => {
      const source = writeSource(join(dir, "src"), TWO_MEMORIES);
      writeState(home, stateWith({ [source]: entryFor(localFrom(source)) }));
      const io = fakeIo({ home, userHome, cwd: dir });
      await runSync(SYNC, io);
      const refused = runRemove(
        { ...REMOVE, targets: ["always-review"], agents: ["claude-code"] },
        io,
      );
      const error = await expectExit(refused, ExitCode.Usage);
      expect(error.message).toBe("-a applies to a source, not to the memory always-review");
      expect(readStateFile(home).sources[source]?.intent.select).toBe("*");
    });
  });

  test("--json prints one document even when a native error interrupts the removal", async () => {
    await world(async ({ home, dir, userHome }) => {
      const live = writeSource(join(dir, "live"), TWO_MEMORIES);
      writeState(home, stateWith({ [live]: entryFor(localFrom(live, true)) }));
      const io = fakeIo({ home, userHome, cwd: dir });
      await runSync(SYNC, io);
      const rules = globalRulesFile(userHome, sourceSlug(localFrom(live, true)));
      rmSync(live, { recursive: true });
      chmodSync(rules, 0o000);
      try {
        io.out.length = 0;
        await runRemove({ ...REMOVE, json: true, targets: ["always-review"] }, io).catch(
          () => undefined,
        );
        const document = JSON.parse(io.out.join(""));
        expect(document.ok).toBe(false);
        expect(document.message).toContain("EACCES");
      } finally {
        chmodSync(rules, 0o644);
      }
    });
  });

  test("nothing installed, or a name nobody provides, is a clean exit with the mirrored line", async () => {
    await world(async ({ home, dir, userHome }) => {
      const io = fakeIo({ home, userHome, cwd: dir });
      await runRemove({ ...REMOVE, targets: ["anything"] }, io);
      expect(io.out.join("")).toBe("No memories found to remove.\n");
      const source = writeSource(join(dir, "src"), TWO_MEMORIES);
      writeState(home, stateWith({ [source]: entryFor(localFrom(source)) }));
      io.out.length = 0;
      await runRemove({ ...REMOVE, targets: ["nobody-has-this"] }, io);
      expect(io.out.join("")).toBe(
        "nobody-has-this is not installed\nNo memories found to remove.\n",
      );
    });
  });
});
