// What would drift silently: a collision or an over-cap source that half-installs instead of
// refusing, a refused or unreadable source that loses the bodies and names it already owns, a sweep
// that takes a file this run recreates or reaches through a symlink, and a vanished source's
// destination that a sync visits when it has nothing to render there.
import { describe, expect, test } from "bun:test";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import {
  daysAgo,
  entryFor,
  fakeIo,
  fakeResolvers,
  fetchedEntry,
  fetchedFacts,
  githubFrom,
  gitSha,
  localFrom,
  memoryFile,
  memoryName,
  readStateFile,
  rulesDirHarness,
  seedStore,
  sharedBlockHarness,
  stateWith,
  treeDigest,
  writeSource,
  writeState,
} from "../../tests/engine/harness.ts";
import { expectExit, globalRulesFile, TWO_MEMORIES, world } from "../../tests/engine/world.ts";
import { DAY_MS, fetchedOf, NOW, QUIET, SYNC } from "../../tests/shared/sync_support.ts";
import type { HarnessDefinition } from "../harnesses/contract.ts";
import { parseBlocks } from "../rulefile/block.ts";
import { ExitCode } from "../util/exit-codes.ts";
import { homePaths, storePathFor } from "../util/home.ts";
import { runRemove } from "./remove.ts";
import { sourceSlug } from "./shared/slug.ts";
import { runSync } from "./sync.ts";

// A run that refuses several sources exits with the first failure in key order. A local source's
// key is its path, which sorts before "@acme/rules" on POSIX and after it on Windows, where the
// drive letter leads.
function firstRefusal(localKey: string): ExitCode {
  return localKey < "@acme/rules" ? ExitCode.NameCollision : ExitCode.RuleCapExceeded;
}

describe("what a refused or departed source leaves behind", () => {
  test("a colliding source lands neither block nor bodies, so the owner's body stays its own", async () => {
    await world(async ({ home, dir, userHome, project }) => {
      const first = writeSource(join(dir, "first"), { shared: { description: "First." } });
      const second = writeSource(join(dir, "second"), { shared: { description: "Second." } });
      const project_ = { destination: { scope: "project" as const, root: project } };
      const later = {
        ...entryFor(localFrom(second), project_),
        addedAt: "2026-08-02T00:00:00.000Z",
      };
      writeState(
        home,
        stateWith({ [first]: entryFor(localFrom(first), project_), [second]: later }),
      );
      const io = fakeIo({ home, userHome, cwd: project });
      await expectExit(runSync(SYNC, io), ExitCode.NameCollision);
      const body = join(project, ".agents", "memories", "shared.md");
      expect(realpathSync(body)).toBe(
        realpathSync(join(storePathFor(home, localFrom(first)), "memories", "shared.md")),
      );
    });
  });

  test("the sweep of a rules directory never takes a file this run recreates", async () => {
    await world(async ({ home, dir, userHome }) => {
      const first = writeSource(join(dir, "first"), { one: { description: "One." } });
      const second = writeSource(join(dir, "second"), { two: { description: "Two." } });
      writeState(
        home,
        stateWith({ [first]: entryFor(localFrom(first)), [second]: entryFor(localFrom(second)) }),
      );
      const io = fakeIo({ home, userHome, cwd: dir });
      await runSync(SYNC, io);
      const secondFile = globalRulesFile(userHome, sourceSlug(localFrom(second)));
      rmSync(secondFile);
      writeState(home, stateWith({ [second]: entryFor(localFrom(second)) }));
      await runSync(SYNC, io);
      expect(existsSync(secondFile)).toBe(true);
      expect(existsSync(globalRulesFile(userHome, sourceSlug(localFrom(first))))).toBe(false);
    });
  });

  test("a symlink where a rule file belongs is replaced by a real file even when its bytes match", async () => {
    await world(async ({ home, dir, userHome }) => {
      const source = writeSource(join(dir, "src"), TWO_MEMORIES);
      writeState(home, stateWith({ [source]: entryFor(localFrom(source)) }));
      const io = fakeIo({ home, userHome, cwd: dir });
      await runSync(SYNC, io);
      const rules = globalRulesFile(userHome, sourceSlug(localFrom(source)));
      const aside = join(dir, "elsewhere.md");
      writeFileSync(aside, readFileSync(rules, "utf8"));
      rmSync(rules);
      symlinkSync(aside, rules);
      await runSync(SYNC, io);
      expect(lstatSync(rules).isFile()).toBe(true);
    });
  });

  test("a body copied while symlinks were unavailable becomes a link once they are", async () => {
    await world(async ({ home, dir, userHome, project }) => {
      const source = writeSource(join(dir, "src"), TWO_MEMORIES);
      const entry = entryFor(localFrom(source), {
        destination: { scope: "project", root: project },
      });
      writeState(home, stateWith({ [source]: entry }));
      const io = fakeIo({ home, userHome, cwd: project });
      io.symlink = { ok: false, reason: "EPERM" };
      await runSync(SYNC, io);
      const body = join(project, ".agents", "memories", "always-review.md");
      expect(lstatSync(body).isFile()).toBe(true);
      io.symlink = { ok: true };
      await runSync(SYNC, io);
      expect(lstatSync(body).isSymbolicLink()).toBe(true);
      rmSync(body);
      writeFileSync(body, "the user's own text\n");
      const report = await runSync(SYNC, io);
      expect(lstatSync(body).isFile()).toBe(true);
      expect(report.notices.some((line) => line.endsWith("is not a link; left alone"))).toBe(true);
    });
  });

  test("a source refused by the cap or a byte budget keeps its bodies and lands none anew", async () => {
    await world(async ({ home, dir, userHome, project }) => {
      const source = writeSource(join(dir, "src"), TWO_MEMORIES);
      const entry = entryFor(localFrom(source), {
        destination: { scope: "project", root: project },
      });
      writeState(home, stateWith({ [source]: entry }));
      const io = fakeIo({ home, userHome, cwd: project });
      await runSync(SYNC, io);
      const body = join(project, ".agents", "memories", "always-review.md");
      expect(lstatSync(body).isSymbolicLink()).toBe(true);
      writeFileSync(homePaths(home).config, JSON.stringify({ ruleCap: 1 }));
      await expectExit(runSync({ ...SYNC, fetch: "none" }, io), ExitCode.RuleCapExceeded);
      expect(lstatSync(body).isSymbolicLink()).toBe(true);
      rmSync(join(project, ".agents"), { recursive: true });
      rmSync(join(project, ".fixture", "rules"), { recursive: true });
      writeFileSync(homePaths(home).config, "{}");
      const tiny: HarnessDefinition = { ...rulesDirHarness, byteBudget: 64 };
      const budgeted = fakeIo({ home, userHome, cwd: project, harnesses: [tiny] });
      await expectExit(runSync({ ...SYNC, fetch: "none" }, budgeted), ExitCode.RuleCapExceeded);
      expect(existsSync(join(project, ".agents", "memories"))).toBe(false);
    });
  });

  test("a project-scoped source is not fetched outside a project, so its facts and store agree", async () => {
    await world(async ({ home, dir, userHome, project }) => {
      const upstream = writeSource(join(dir, "upstream"), TWO_MEMORIES);
      const from = githubFrom("acme/rules");
      seedStore(home, from, upstream);
      const facts = await fetchedFacts(upstream, daysAgo(NOW, 9), null, "a".repeat(40));
      const entry = fetchedEntry(from, facts, { destination: { scope: "project", root: project } });
      writeState(home, stateWith({ "@acme/rules": entry }));
      const fake = fakeResolvers();
      fake.set(from, { kind: "dir", dir: upstream, sha: "b".repeat(40) });
      const io = fakeIo({ home, userHome, cwd: dir, resolvers: fake.resolvers });
      const report = await runSync(SYNC, io);
      expect(fake.calls).toEqual([]);
      expect(report.fetched).toEqual([]);
      expect(fetchedOf(home, "@acme/rules")?.sha).toBe(gitSha("a".repeat(40)));
      // From another project the entry is equally not this run's: nothing is fetched or written
      // there, and the entry stays as it is.
      const other = join(dir, "other-project");
      mkdirSync(join(other, ".git"), { recursive: true });
      mkdirSync(join(other, ".fixture"), { recursive: true });
      const elsewhere = fakeIo({ home, userHome, cwd: other, resolvers: fake.resolvers });
      const before = treeDigest(other);
      const away = await runSync(SYNC, elsewhere);
      expect(fake.calls).toEqual([]);
      expect(away.sources).toBe(0);
      expect(treeDigest(other)).toBe(before);
      expect(fetchedOf(home, "@acme/rules")?.sha).toBe(gitSha("a".repeat(40)));
      // The project reached through an alias symlink is the same project: its entries apply.
      const alias = join(dir, "alias");
      symlinkSync(project, alias);
      const viaAlias = fakeIo({ home, userHome, cwd: alias, resolvers: fake.resolvers });
      expect((await runSync({ ...SYNC, fetch: "none" }, viaAlias)).sources).toBe(1);
    });
  });

  test("a refused refresh keeps the bodies its preserved rules point at", async () => {
    await world(async ({ home, dir, userHome, project }) => {
      const upstream = writeSource(join(dir, "upstream"), { alpha: { description: "Alpha." } });
      const from = githubFrom("acme/rules");
      seedStore(home, from, upstream);
      const facts = await fetchedFacts(upstream, daysAgo(NOW, 9), null, "a".repeat(40));
      const entry = fetchedEntry(from, facts, { destination: { scope: "project", root: project } });
      writeState(home, stateWith({ "@acme/rules": entry }));
      const fake = fakeResolvers();
      fake.set(from, { kind: "dir", dir: upstream, sha: "a".repeat(40) });
      const io = fakeIo({ home, userHome, cwd: project, resolvers: fake.resolvers });
      await runSync(SYNC, io);
      const body = join(project, ".agents", "memories", "alpha.md");
      expect(lstatSync(body).isSymbolicLink()).toBe(true);
      const many = Object.fromEntries(
        Array.from({ length: 26 }, (_, index) => [
          `rule-${index}`,
          { description: `Rule ${index}.` },
        ]),
      );
      fake.set(from, {
        kind: "dir",
        dir: writeSource(join(dir, "grown"), many),
        sha: "b".repeat(40),
      });
      io.clock.now = new Date(NOW.getTime() + 10 * DAY_MS);
      await expectExit(runSync(SYNC, io), ExitCode.RuleCapExceeded);
      expect(lstatSync(body).isSymbolicLink()).toBe(true);
    });
  });

  test("a refused refresh keeps owning the names its retained rules use", async () => {
    await world(async ({ home, dir, userHome, project }) => {
      const upstream = writeSource(join(dir, "upstream"), { alpha: { description: "Alpha." } });
      const from = githubFrom("acme/rules");
      seedStore(home, from, upstream);
      const facts = await fetchedFacts(upstream, daysAgo(NOW, 9), null, "a".repeat(40));
      const rival = writeSource(join(dir, "rival"), { alpha: { description: "Rival alpha." } });
      writeState(
        home,
        stateWith({
          "@acme/rules": fetchedEntry(from, facts, {
            destination: { scope: "project", root: project },
          }),
          [rival]: {
            ...entryFor(localFrom(rival), { destination: { scope: "project", root: project } }),
            addedAt: "2026-08-02T00:00:00.000Z",
          },
        }),
      );
      const fake = fakeResolvers();
      const many = Object.fromEntries(
        Array.from({ length: 26 }, (_, index) => [
          `rule-${index}`,
          { description: `Rule ${index}.` },
        ]),
      );
      fake.set(from, {
        kind: "dir",
        dir: writeSource(join(dir, "grown"), many),
        sha: "b".repeat(40),
      });
      const io = fakeIo({ home, userHome, cwd: project, resolvers: fake.resolvers });
      // Both refusals are reported: the rival's first install collides with the retained alpha,
      // and the refresh is over the cap.
      await expectExit(runSync({ ...SYNC, json: true }, io), firstRefusal(rival));
      const notices: string[] = JSON.parse(io.out.join("")).report.notices;
      expect(notices.some((line) => line.includes("26 rule lines exceed the cap"))).toBe(true);
      expect(notices.some((line) => line.includes("alpha is owned by @acme/rules"))).toBe(true);
      const body = join(project, ".agents", "memories", "alpha.md");
      expect(realpathSync(body)).toBe(
        realpathSync(join(storePathFor(home, from), "memories", "alpha.md")),
      );
      expect(
        existsSync(join(project, ".fixture", "rules", `maxims-${sourceSlug(localFrom(rival))}.md`)),
      ).toBe(false);
      expect(fetchedOf(home, "@acme/rules")?.sha).toBe(gitSha("a".repeat(40)));
    });
  });

  test("an unreadable older source still owns its recorded names against a newer one", async () => {
    await world(async ({ home, dir, userHome, project }) => {
      const upstream = writeSource(join(dir, "upstream"), { alpha: { description: "Alpha." } });
      const from = githubFrom("acme/rules");
      const facts = await fetchedFacts(upstream, daysAgo(NOW, 1));
      const rival = writeSource(join(dir, "rival"), { alpha: { description: "Rival alpha." } });
      writeState(
        home,
        stateWith({
          "@acme/rules": fetchedEntry(from, facts, {
            destination: { scope: "project", root: project },
          }),
          [rival]: {
            ...entryFor(localFrom(rival), { destination: { scope: "project", root: project } }),
            addedAt: "2026-08-02T00:00:00.000Z",
          },
        }),
      );
      const fake = fakeResolvers();
      fake.set(from, { kind: "fail", failure: "network" });
      const io = fakeIo({ home, userHome, cwd: project, resolvers: fake.resolvers });
      const error = await expectExit(runSync(SYNC, io), ExitCode.NameCollision);
      expect(error.message).toBe(`${rival}: name collision on alpha`);
      expect(existsSync(join(project, ".agents", "memories", "alpha.md"))).toBe(false);
    });
  });

  test("a run limited to some harnesses leaves the store alone", async () => {
    await world(async ({ home, dir, userHome }) => {
      const upstream = writeSource(join(dir, "upstream"), TWO_MEMORIES);
      const from = githubFrom("acme/rules");
      seedStore(home, from, upstream);
      const facts = await fetchedFacts(upstream, daysAgo(NOW, 9), null, "a".repeat(40));
      writeState(home, stateWith({ "@acme/rules": fetchedEntry(from, facts) }));
      const fake = fakeResolvers();
      fake.set(from, { kind: "dir", dir: upstream, sha: "b".repeat(40) });
      const io = fakeIo({ home, userHome, cwd: dir, resolvers: fake.resolvers });
      const report = await runSync({ ...SYNC, agents: ["claude-code"] }, io);
      expect(fake.calls).toEqual([]);
      expect(report.fetched).toEqual([]);
      expect(fetchedOf(home, "@acme/rules")?.sha).toBe(gitSha("a".repeat(40)));
    });
  });

  test("an -o source whose rules are switched off loses its rule file and keeps its bodies", async () => {
    await world(async ({ home, dir, userHome }) => {
      const source = writeSource(join(dir, "src"), TWO_MEMORIES);
      const out = join(dir, "out");
      mkdirSync(out);
      const withRules = entryFor(localFrom(source), { destination: { scope: "out", path: out } });
      writeState(home, stateWith({ [source]: withRules }));
      const io = fakeIo({ home, userHome, cwd: dir });
      await runSync(SYNC, io);
      const ruleFile = join(out, `maxims-${sourceSlug(localFrom(source))}.md`);
      expect(existsSync(ruleFile)).toBe(true);
      const rulesOff = entryFor(localFrom(source), {
        destination: { scope: "out", path: out },
        rule: false,
      });
      writeState(home, stateWith({ [source]: rulesOff }));
      await runSync(SYNC, io);
      expect(existsSync(ruleFile)).toBe(false);
      expect(lstatSync(join(out, "memories", "always-review.md")).isSymbolicLink()).toBe(true);
    });
  });

  test("switching rules off removes an -o rule file even when the source cannot be read", async () => {
    await world(async ({ home, dir, userHome }) => {
      const source = writeSource(join(dir, "src"), TWO_MEMORIES);
      const out = join(dir, "out");
      mkdirSync(out);
      const destination = { scope: "out" as const, path: out };
      writeState(home, stateWith({ [source]: entryFor(localFrom(source, true), { destination }) }));
      const io = fakeIo({ home, userHome, cwd: dir });
      await runSync(SYNC, io);
      const ruleFile = join(out, `maxims-${sourceSlug(localFrom(source, true))}.md`);
      expect(existsSync(ruleFile)).toBe(true);
      rmSync(source, { recursive: true });
      writeState(
        home,
        stateWith({ [source]: entryFor(localFrom(source, true), { destination, rule: false }) }),
      );
      const report = await runSync(SYNC, io);
      expect(report.notices.some((line) => line.includes("kept whatever is installed"))).toBe(true);
      expect(existsSync(ruleFile)).toBe(false);
    });
  });

  test("a refused refresh does not make an unrelated collision report twice", async () => {
    await world(async ({ home, dir, userHome }) => {
      const upstream = writeSource(join(dir, "upstream"), { alpha: { description: "Alpha." } });
      const from = githubFrom("acme/rules");
      seedStore(home, from, upstream);
      const facts = await fetchedFacts(upstream, daysAgo(NOW, 9), null, "a".repeat(40));
      const first = writeSource(join(dir, "first"), { shared: { description: "First." } });
      const second = writeSource(join(dir, "second"), { shared: { description: "Second." } });
      writeState(
        home,
        stateWith({
          "@acme/rules": fetchedEntry(from, facts),
          [first]: entryFor(localFrom(first)),
          [second]: { ...entryFor(localFrom(second)), addedAt: "2026-08-02T00:00:00.000Z" },
        }),
      );
      const many = Object.fromEntries(
        Array.from({ length: 26 }, (_, index) => [
          `rule-${index}`,
          { description: `Rule ${index}.` },
        ]),
      );
      const fake = fakeResolvers();
      fake.set(from, {
        kind: "dir",
        dir: writeSource(join(dir, "grown"), many),
        sha: "b".repeat(40),
      });
      const io = fakeIo({ home, userHome, cwd: dir, resolvers: fake.resolvers });
      await expectExit(runSync({ ...SYNC, json: true }, io), firstRefusal(first));
      const document = JSON.parse(io.out.join(""));
      const collisions = document.report.notices.filter((line: string) =>
        line.includes("is owned by"),
      );
      expect(collisions).toHaveLength(1);
      const caps = document.report.notices.filter((line: string) =>
        line.includes("exceed the cap"),
      );
      expect(caps).toHaveLength(1);
    });
  });

  test("an unreadable live source keeps owning the names its retained block points at", async () => {
    await world(async ({ home, dir, userHome, project }) => {
      const live = writeSource(join(dir, "live"), { alpha: { description: "Alpha." } });
      const liveEntry = entryFor(localFrom(live, true), {
        destination: { scope: "project", root: project },
      });
      writeState(home, stateWith({ [live]: liveEntry }));
      const io = fakeIo({ home, userHome, cwd: project });
      await runSync(SYNC, io);
      const body = join(project, ".agents", "memories", "alpha.md");
      const target = readlinkSync(body);
      rmSync(live, { recursive: true });
      const rival = writeSource(join(dir, "rival"), { alpha: { description: "Rival alpha." } });
      writeState(
        home,
        stateWith({
          [live]: liveEntry,
          [rival]: {
            ...entryFor(localFrom(rival), { destination: { scope: "project", root: project } }),
            addedAt: "2026-08-02T00:00:00.000Z",
          },
        }),
      );
      const error = await expectExit(runSync(SYNC, io), ExitCode.NameCollision);
      expect(error.message).toBe(`${rival}: name collision on alpha`);
      expect(readlinkSync(body)).toBe(target);
    });
  });

  test("copies written before upstream changed are still ours: relinked, or swept when retired", async () => {
    await world(async ({ home, dir, userHome, project }) => {
      const upstream = writeSource(join(dir, "upstream"), {
        alpha: { description: "Alpha." },
        beta: { description: "Beta." },
      });
      const from = githubFrom("acme/rules");
      const entry = fetchedEntry(
        from,
        await fetchedFacts(upstream, daysAgo(NOW, 9), null, "a".repeat(40)),
        {
          destination: { scope: "project", root: project },
        },
      );
      seedStore(home, from, upstream);
      writeState(home, stateWith({ "@acme/rules": entry }));
      const fake = fakeResolvers();
      fake.set(from, { kind: "dir", dir: upstream, sha: "a".repeat(40) });
      const io = fakeIo({ home, userHome, cwd: project, resolvers: fake.resolvers });
      io.symlink = { ok: false, reason: "EPERM" };
      await runSync(SYNC, io);
      const alpha = join(project, ".agents", "memories", "alpha.md");
      const beta = join(project, ".agents", "memories", "beta.md");
      expect(lstatSync(alpha).isFile()).toBe(true);
      const changed = writeSource(join(dir, "changed"), {
        beta: { description: "Beta, revised." },
      });
      fake.set(from, { kind: "dir", dir: changed, sha: "b".repeat(40) });
      io.symlink = { ok: true };
      io.clock.now = new Date(NOW.getTime() + 10 * DAY_MS);
      await runSync(SYNC, io);
      expect(lstatSync(alpha, { throwIfNoEntry: false })).toBeUndefined();
      expect(lstatSync(beta).isSymbolicLink()).toBe(true);
    });
  });

  test("a collision naming the refused source as owner is reported once after the retry", async () => {
    await world(async ({ home, dir, userHome }) => {
      const upstream = writeSource(join(dir, "upstream"), { alpha: { description: "Alpha." } });
      const from = githubFrom("acme/rules");
      seedStore(home, from, upstream);
      const facts = await fetchedFacts(upstream, daysAgo(NOW, 9), null, "a".repeat(40));
      const rival = writeSource(join(dir, "rival"), { alpha: { description: "Rival." } });
      writeState(
        home,
        stateWith({
          "@acme/rules": fetchedEntry(from, facts),
          [rival]: { ...entryFor(localFrom(rival)), addedAt: "2026-08-02T00:00:00.000Z" },
        }),
      );
      const grownNames = Object.fromEntries(
        Array.from({ length: 25 }, (_, index) => [
          `rule-${index}`,
          { description: `Rule ${index}.` },
        ]),
      );
      const grown = writeSource(join(dir, "grown"), {
        ...grownNames,
        alpha: { description: "Alpha." },
      });
      const fake = fakeResolvers();
      fake.set(from, { kind: "dir", dir: grown, sha: "b".repeat(40) });
      const io = fakeIo({ home, userHome, cwd: dir, resolvers: fake.resolvers });
      await expectExit(runSync({ ...SYNC, json: true }, io), firstRefusal(rival));
      const document = JSON.parse(io.out.join(""));
      const notices: string[] = document.report.notices;
      expect(notices.filter((line) => line.includes("alpha is owned by @acme/rules"))).toHaveLength(
        1,
      );
      expect(notices.filter((line) => line.includes("exceed the cap"))).toHaveLength(1);
    });
  });

  test("a copy retired by a hook run is swept by the next interactive sync", async () => {
    await world(async ({ home, dir, userHome, project }) => {
      const upstream = writeSource(join(dir, "upstream"), {
        alpha: { description: "Alpha." },
        beta: { description: "Beta." },
      });
      const from = githubFrom("acme/rules");
      seedStore(home, from, upstream);
      const facts = await fetchedFacts(upstream, daysAgo(NOW, 9), null, "a".repeat(40));
      const entry = fetchedEntry(from, facts, {
        destination: { scope: "project", root: project },
        copy: true,
      });
      writeState(home, stateWith({ "@acme/rules": entry }));
      const fake = fakeResolvers();
      fake.set(from, { kind: "dir", dir: upstream, sha: "a".repeat(40) });
      const io = fakeIo({ home, userHome, cwd: project, resolvers: fake.resolvers });
      await runSync(SYNC, io);
      const alpha = join(project, ".agents", "memories", "alpha.md");
      writeFileSync(join(project, ".agents", "memories", "note.md"), "# my own note\n");
      const changed = writeSource(join(dir, "changed"), {
        beta: { description: "Beta, revised." },
      });
      fake.set(from, { kind: "dir", dir: changed, sha: "b".repeat(40) });
      io.clock.now = new Date(NOW.getTime() + 10 * DAY_MS);
      await runSync(QUIET, io);
      expect(existsSync(alpha)).toBe(true);
      await runSync(SYNC, io);
      expect(existsSync(alpha)).toBe(false);
      expect(existsSync(join(project, ".agents", "memories", "note.md"))).toBe(true);
    });
  });

  test("an unreadable source reserves only the names its selection and rename map install", async () => {
    await world(async ({ home, dir, userHome, project }) => {
      const upstream = writeSource(join(dir, "upstream"), {
        alpha: { description: "Alpha." },
        beta: { description: "Beta." },
      });
      const from = githubFrom("acme/rules");
      const facts = await fetchedFacts(upstream, daysAgo(NOW, 1));
      const older = fetchedEntry(from, facts, {
        destination: { scope: "project", root: project },
        select: [memoryName("alpha")],
      });
      const newer = writeSource(join(dir, "newer"), { beta: { description: "Newer beta." } });
      writeState(
        home,
        stateWith({
          "@acme/rules": older,
          [newer]: {
            ...entryFor(localFrom(newer), { destination: { scope: "project", root: project } }),
            addedAt: "2026-08-02T00:00:00.000Z",
          },
        }),
      );
      const fake = fakeResolvers();
      fake.set(from, { kind: "fail", failure: "network" });
      const io = fakeIo({ home, userHome, cwd: project, resolvers: fake.resolvers });
      const report = await runSync(SYNC, io);
      expect(report.rules).toBe(1);
      expect(lstatSync(join(project, ".agents", "memories", "beta.md")).isSymbolicLink()).toBe(
        true,
      );
    });
  });

  test("a live source under a path with a space, renamed and unreadable, reserves its local name", async () => {
    await world(async ({ home, dir, userHome }) => {
      const live = writeSource(join(dir, "my memories"), { alpha: { description: "Alpha." } });
      const rename = { [memoryName("alpha")]: memoryName("beta") };
      writeState(home, stateWith({ [live]: entryFor(localFrom(live, true), { rename }) }));
      const io = fakeIo({ home, userHome, cwd: dir });
      await runSync(SYNC, io);
      rmSync(live, { recursive: true });
      const rivalBeta = writeSource(join(dir, "rival-beta"), { beta: { description: "Rival." } });
      const rivalAlpha = writeSource(join(dir, "rival-alpha"), { alpha: { description: "Free." } });
      writeState(
        home,
        stateWith({
          [live]: entryFor(localFrom(live, true), { rename }),
          [rivalBeta]: { ...entryFor(localFrom(rivalBeta)), addedAt: "2026-08-02T00:00:00.000Z" },
          [rivalAlpha]: { ...entryFor(localFrom(rivalAlpha)), addedAt: "2026-08-03T00:00:00.000Z" },
        }),
      );
      const error = await expectExit(runSync(SYNC, io), ExitCode.NameCollision);
      expect(error.message).toBe(`${rivalBeta}: name collision on beta`);
      expect(existsSync(globalRulesFile(userHome, sourceSlug(localFrom(rivalAlpha))))).toBe(true);
    });
  });

  // Both sources are github ones so that "@aaa/first" sorts ahead of "@acme/rules" on every
  // platform; a local path key would sort after it on Windows, where the drive letter leads.
  test("a shared-file budget refusal keeps its reason when only the second source was fresh", async () => {
    await world(async ({ home, dir, userHome }) => {
      const first = writeSource(join(dir, "first"), { one: { description: "One." } });
      const upstream = writeSource(join(dir, "upstream"), { two: { description: "Two." } });
      const fromFirst = githubFrom("aaa/first");
      const from = githubFrom("acme/rules");
      seedStore(home, fromFirst, first);
      const firstFacts = await fetchedFacts(first, daysAgo(NOW, 1), null, "c".repeat(40));
      const firstEntry = fetchedEntry(fromFirst, firstFacts, { harnesses: ["codex"] });
      const fake = fakeResolvers();
      fake.set(fromFirst, { kind: "dir", dir: first, sha: "c".repeat(40) });
      writeState(home, stateWith({ "@aaa/first": firstEntry }));
      const plain = fakeIo({
        home,
        userHome,
        cwd: dir,
        resolvers: fake.resolvers,
        harnesses: [sharedBlockHarness],
      });
      await runSync(SYNC, plain);
      const shared = join(userHome, ".fixture", "FIXTURE.md");
      const tiny: HarnessDefinition = {
        ...sharedBlockHarness,
        byteBudget: Buffer.byteLength(readFileSync(shared)) + 16,
      };
      const facts = await fetchedFacts(upstream, daysAgo(NOW, 9), null, "a".repeat(40));
      writeState(
        home,
        stateWith({
          "@aaa/first": firstEntry,
          "@acme/rules": fetchedEntry(from, facts, { harnesses: ["codex"] }),
        }),
      );
      fake.set(from, { kind: "dir", dir: upstream, sha: "b".repeat(40) });
      const io = fakeIo({ home, userHome, cwd: dir, resolvers: fake.resolvers, harnesses: [tiny] });
      await expectExit(runSync({ ...SYNC, json: true }, io), ExitCode.RuleCapExceeded);
      const document = JSON.parse(io.out.join(""));
      const reasons = document.report.notices.filter((line: string) =>
        line.includes(" bytes over the budget for "),
      );
      expect(reasons).toHaveLength(1);
      expect(readFileSync(shared, "utf8")).toContain("One.");
      expect(existsSync(storePathFor(home, from))).toBe(false);
    });
  });

  test("copy mode leaves a user's own file where a body would go, with a notice", async () => {
    await world(async ({ home, dir, userHome, project }) => {
      const source = writeSource(join(dir, "src"), TWO_MEMORIES);
      const entry = entryFor(localFrom(source), {
        destination: { scope: "project", root: project },
        copy: true,
      });
      writeState(home, stateWith({ [source]: entry }));
      const body = join(project, ".agents", "memories", "always-review.md");
      mkdirSync(join(project, ".agents", "memories"), { recursive: true });
      writeFileSync(body, "# my own note\n");
      const io = fakeIo({ home, userHome, cwd: project });
      const report = await runSync(SYNC, io);
      expect(readFileSync(body, "utf8")).toBe("# my own note\n");
      expect(report.notices).toContain(`maxims: ${body} exists and is not a link; left alone`);
    });
  });

  test("a renamed copy is still ours after a hook refresh replaced the hash it was written from", async () => {
    await world(async ({ home, dir, userHome, project }) => {
      const upstream = writeSource(join(dir, "upstream"), { alpha: { description: "Alpha." } });
      const from = githubFrom("acme/rules");
      seedStore(home, from, upstream);
      const facts = await fetchedFacts(upstream, daysAgo(NOW, 9), null, "a".repeat(40));
      const rename = { [memoryName("alpha")]: memoryName("beta") };
      const entry = fetchedEntry(from, facts, {
        destination: { scope: "project", root: project },
        rename,
      });
      writeState(home, stateWith({ "@acme/rules": entry }));
      const fake = fakeResolvers();
      fake.set(from, { kind: "dir", dir: upstream, sha: "a".repeat(40) });
      const io = fakeIo({ home, userHome, cwd: project, resolvers: fake.resolvers });
      io.symlink = { ok: false, reason: "EPERM" };
      await runSync(SYNC, io);
      const beta = join(project, ".agents", "memories", "beta.md");
      expect(lstatSync(beta).isFile()).toBe(true);
      const changed = writeSource(join(dir, "changed"), {
        alpha: { description: "Alpha, revised." },
      });
      fake.set(from, { kind: "dir", dir: changed, sha: "b".repeat(40) });
      io.symlink = { ok: true };
      io.clock.now = new Date(NOW.getTime() + 10 * DAY_MS);
      await runSync(QUIET, io);
      expect(lstatSync(beta).isFile()).toBe(true);
      await runSync(SYNC, io);
      expect(lstatSync(beta).isSymbolicLink()).toBe(true);
    });
  });

  test("an unreadable live source under a path with an at sign still reserves its name", async () => {
    await world(async ({ home, dir, userHome }) => {
      const live = writeSource(join(dir, "rules@work"), { alpha: { description: "Alpha." } });
      writeState(home, stateWith({ [live]: entryFor(localFrom(live, true)) }));
      const io = fakeIo({ home, userHome, cwd: dir });
      await runSync(SYNC, io);
      rmSync(live, { recursive: true });
      const rival = writeSource(join(dir, "rival"), { alpha: { description: "Rival." } });
      writeState(
        home,
        stateWith({
          [live]: entryFor(localFrom(live, true)),
          [rival]: { ...entryFor(localFrom(rival)), addedAt: "2026-08-02T00:00:00.000Z" },
        }),
      );
      await expectExit(runSync(SYNC, io), ExitCode.NameCollision);
    });
  });

  test("a renamed copy whose frontmatter quotes its name is still recognised as ours", async () => {
    await world(async ({ home, dir, userHome, project }) => {
      const upstream = join(dir, "upstream");
      mkdirSync(join(upstream, "memories"), { recursive: true });
      const quoted = `---\nname: "alpha" # upstream name\ndescription: Alpha.\n---\n\nBody.\n`;
      writeFileSync(join(upstream, "memories", "alpha.md"), quoted);
      const from = githubFrom("acme/rules");
      seedStore(home, from, upstream);
      const facts = await fetchedFacts(upstream, daysAgo(NOW, 9), null, "a".repeat(40));
      const rename = { [memoryName("alpha")]: memoryName("beta") };
      const entry = fetchedEntry(from, facts, {
        destination: { scope: "project", root: project },
        rename,
      });
      writeState(home, stateWith({ "@acme/rules": entry }));
      const fake = fakeResolvers();
      fake.set(from, { kind: "dir", dir: upstream, sha: "a".repeat(40) });
      const io = fakeIo({ home, userHome, cwd: project, resolvers: fake.resolvers });
      io.symlink = { ok: false, reason: "EPERM" };
      await runSync(SYNC, io);
      const beta = join(project, ".agents", "memories", "beta.md");
      const changed = join(dir, "changed");
      mkdirSync(join(changed, "memories"), { recursive: true });
      writeFileSync(join(changed, "memories", "alpha.md"), quoted.replace("Body.", "Revised."));
      fake.set(from, { kind: "dir", dir: changed, sha: "b".repeat(40) });
      io.symlink = { ok: true };
      io.clock.now = new Date(NOW.getTime() + 10 * DAY_MS);
      await runSync(QUIET, io);
      expect(lstatSync(beta).isFile()).toBe(true);
      await runSync(SYNC, io);
      expect(lstatSync(beta).isSymbolicLink()).toBe(true);
    });
  });

  test("a retained block written on another platform still yields its names when unreadable", async () => {
    await world(async ({ home, dir, userHome }) => {
      const live = join(dir, "gone");
      const key = live;
      writeState(home, stateWith({ [key]: entryFor(localFrom(live, true)) }));
      const rulesDir = join(userHome, ".fixture", "rules");
      mkdirSync(rulesDir, { recursive: true });
      const detail = "`&#92;home&#92;user&#92;rules@work&#92;memories&#92;alpha.md,` 1234567";
      writeFileSync(
        join(rulesDir, `maxims-${sourceSlug(localFrom(live, true))}.md`),
        `<!-- maxims:begin ${key} sha=sha256:0 -->\n- Alpha. (detail: ${detail})\n<!-- maxims:end ${key} -->\n`,
      );
      const rival = writeSource(join(dir, "rival"), { alpha: { description: "Rival." } });
      writeState(
        home,
        stateWith({
          [key]: entryFor(localFrom(live, true)),
          [rival]: { ...entryFor(localFrom(rival)), addedAt: "2026-08-02T00:00:00.000Z" },
        }),
      );
      const io = fakeIo({ home, userHome, cwd: dir });
      const error = await expectExit(runSync(SYNC, io), ExitCode.NameCollision);
      expect(error.message).toBe(`${rival}: name collision on alpha`);
    });
  });

  test("a live source refused by the cap keeps owning the names its retained block points at", async () => {
    await world(async ({ home, dir, userHome, project }) => {
      const live = writeSource(join(dir, "live"), { alpha: { description: "Alpha." } });
      const liveEntry = entryFor(localFrom(live, true), {
        destination: { scope: "project", root: project },
        copy: true,
      });
      writeState(home, stateWith({ [live]: liveEntry }));
      const io = fakeIo({ home, userHome, cwd: project });
      await runSync(SYNC, io);
      const body = join(project, ".agents", "memories", "alpha.md");
      const original = readFileSync(body, "utf8");
      rmSync(join(live, "memories", "alpha.md"));
      for (let index = 0; index < 26; index += 1) {
        writeFileSync(
          join(live, "memories", `rule-${index}.md`),
          memoryFile(`rule-${index}`, { description: `Rule ${index}.` }),
        );
      }
      const rival = writeSource(join(dir, "rival"), { alpha: { description: "Rival alpha." } });
      writeState(
        home,
        stateWith({
          [live]: liveEntry,
          [rival]: {
            ...entryFor(localFrom(rival), { destination: { scope: "project", root: project } }),
            addedAt: "2026-08-02T00:00:00.000Z",
          },
        }),
      );
      await expectExit(runSync(SYNC, io), ExitCode.RuleCapExceeded);
      expect(readFileSync(body, "utf8")).toBe(original);
    });
  });

  test("a kept block survives when another harness reaches the same file through a symlink", async () => {
    await world(async ({ home, dir, userHome }) => {
      const linked: HarnessDefinition = {
        ...sharedBlockHarness,
        id: "gemini-cli",
        displayName: "Linked",
        targets: {
          project: { kind: "shared-block", file: "FIXTURE.md" },
          global: { kind: "shared-block", file: join(".fixture-link", "FIXTURE.md") },
        },
        hook: { kind: "none" },
      };
      symlinkSync(join(userHome, ".fixture"), join(userHome, ".fixture-link"));
      const upstream = writeSource(join(dir, "upstream"), { alpha: { description: "Alpha." } });
      const from = githubFrom("acme/rules");
      seedStore(home, from, upstream);
      const facts = await fetchedFacts(upstream, daysAgo(NOW, 1));
      const other = writeSource(join(dir, "other"), { beta: { description: "Beta." } });
      writeState(
        home,
        stateWith({
          "@acme/rules": fetchedEntry(from, facts, { harnesses: ["codex"] }),
          [other]: entryFor(localFrom(other), { harnesses: ["gemini-cli"] }),
        }),
      );
      const io = fakeIo({ home, userHome, cwd: dir, harnesses: [sharedBlockHarness, linked] });
      await runSync(SYNC, io);
      const shared = join(userHome, ".fixture", "FIXTURE.md");
      expect(parseBlocks(readFileSync(shared, "utf8")).blocks).toHaveLength(2);
      rmSync(storePathFor(home, from), { recursive: true });
      await runSync({ ...SYNC, fetch: "none" }, io);
      const sources = parseBlocks(readFileSync(shared, "utf8")).blocks.map((block) => block.source);
      expect(sources.sort()).toEqual(["@acme/rules", other].sort());
    });
  });

  test("a rules directory reached through a symlink is not swept of the file it shares", async () => {
    await world(async ({ home, dir, userHome }) => {
      const aliased: HarnessDefinition = {
        ...rulesDirHarness,
        id: "cline",
        displayName: "Aliased",
        targets: {
          project: rulesDirHarness.targets.project,
          global: {
            kind: "rules-dir",
            dir: join(".fixture-link", "rules"),
            fileName: (slug) => `maxims-${slug}.md`,
          },
        },
        hook: { kind: "none" },
      };
      symlinkSync(join(userHome, ".fixture"), join(userHome, ".fixture-link"));
      const source = writeSource(join(dir, "src"), TWO_MEMORIES);
      writeState(
        home,
        stateWith({
          [source]: entryFor(localFrom(source), { harnesses: ["claude-code", "cline"] }),
        }),
      );
      const io = fakeIo({ home, userHome, cwd: dir, harnesses: [rulesDirHarness, aliased] });
      await runSync(SYNC, io);
      const rules = globalRulesFile(userHome, sourceSlug(localFrom(source)));
      writeFileSync(join(userHome, ".fixture", "rules", "note.md"), "# mine\n");
      const second = await runSync(SYNC, io);
      expect(second.plan.changes).toEqual([]);
      expect(existsSync(rules)).toBe(true);
    });
  });

  test("two -o folders that are one directory through a symlink share one bodies sweep", async () => {
    await world(async ({ home, dir, userHome }) => {
      const outA = join(dir, "out-a");
      mkdirSync(outA);
      const outB = join(dir, "out-b");
      symlinkSync(outA, outB);
      const first = writeSource(join(dir, "first"), { one: { description: "One." } });
      const second = writeSource(join(dir, "second"), { two: { description: "Two." } });
      writeState(
        home,
        stateWith({
          [first]: entryFor(localFrom(first), {
            destination: { scope: "out", path: outA },
            copy: true,
          }),
          [second]: entryFor(localFrom(second), {
            destination: { scope: "out", path: outB },
            copy: true,
          }),
        }),
      );
      const io = fakeIo({ home, userHome, cwd: dir });
      await runSync(SYNC, io);
      const again = await runSync(SYNC, io);
      expect(again.plan.changes).toEqual([]);
      expect(existsSync(join(outA, "memories", "one.md"))).toBe(true);
      expect(existsSync(join(outA, "memories", "two.md"))).toBe(true);
    });
  });

  test("a body linked through a symlinked folder resolves into the store and is swept from it", async () => {
    await world(async ({ home, dir, userHome }) => {
      const real = join(dir, "nested", "out");
      mkdirSync(real, { recursive: true });
      const alias = join(dir, "out");
      symlinkSync(real, alias);
      const source = writeSource(join(dir, "src"), TWO_MEMORIES);
      writeState(
        home,
        stateWith({
          [source]: entryFor(localFrom(source), { destination: { scope: "out", path: alias } }),
        }),
      );
      const io = fakeIo({ home, userHome, cwd: dir });
      await runSync(SYNC, io);
      const link = join(alias, "memories", "always-review.md");
      expect(realpathSync(link)).toBe(
        realpathSync(join(storePathFor(home, localFrom(source)), "memories", "always-review.md")),
      );
      expect((await runSync(SYNC, io)).plan.changes).toEqual([]);
      const remove = { quiet: false, dryRun: false, json: false, targets: [], confirmed: true };
      await runRemove({ ...remove, all: true }, io);
      expect(lstatSync(link, { throwIfNoEntry: false })).toBeUndefined();
    });
  });

  test("two rule-file links pointing at one stale file each become a real file", async () => {
    await world(async ({ home, dir, userHome }) => {
      const other: HarnessDefinition = {
        ...rulesDirHarness,
        id: "cline",
        displayName: "Other",
        targets: {
          project: rulesDirHarness.targets.project,
          global: {
            kind: "rules-dir",
            dir: join(".fixture", "rules"),
            fileName: (slug) => `maxims-${slug}.other.md`,
          },
        },
        hook: { kind: "none" },
      };
      const source = writeSource(join(dir, "src"), TWO_MEMORIES);
      writeState(
        home,
        stateWith({
          [source]: entryFor(localFrom(source), { harnesses: ["claude-code", "cline"] }),
        }),
      );
      const rules = join(userHome, ".fixture", "rules");
      mkdirSync(rules, { recursive: true });
      const stale = join(dir, "stale.md");
      writeFileSync(stale, "old rules\n");
      const slug = sourceSlug(localFrom(source));
      symlinkSync(stale, join(rules, `maxims-${slug}.md`));
      symlinkSync(stale, join(rules, `maxims-${slug}.other.md`));
      const io = fakeIo({ home, userHome, cwd: dir, harnesses: [rulesDirHarness, other] });
      await runSync(SYNC, io);
      for (const name of [`maxims-${slug}.md`, `maxims-${slug}.other.md`]) {
        expect(lstatSync(join(rules, name)).isFile()).toBe(true);
        expect(readFileSync(join(rules, name), "utf8")).toContain("Never merge red.");
      }
      expect(readFileSync(stale, "utf8")).toBe("old rules\n");
    });
  });

  test("a name a newer source has installed stays its own when an older source ships it later", async () => {
    await world(async ({ home, dir, userHome, project }) => {
      const older = writeSource(join(dir, "older"), { alpha: { description: "Alpha." } });
      const newer = writeSource(join(dir, "newer"), { beta: { description: "Newer beta." } });
      const projectScope = { destination: { scope: "project" as const, root: project } };
      writeState(
        home,
        stateWith({
          [older]: entryFor(localFrom(older, true), projectScope),
          [newer]: {
            ...entryFor(localFrom(newer, true), projectScope),
            addedAt: "2026-08-02T00:00:00.000Z",
          },
        }),
      );
      const io = fakeIo({ home, userHome, cwd: project });
      await runSync(SYNC, io);
      const body = join(project, ".agents", "memories", "beta.md");
      const target = readlinkSync(body);
      writeFileSync(
        join(older, "memories", "beta.md"),
        memoryFile("beta", { description: "Older beta." }),
      );
      const error = await expectExit(runSync(SYNC, io), ExitCode.NameCollision);
      expect(error.message).toBe(`${older}: name collision on beta`);
      expect(readlinkSync(body)).toBe(target);
    });
  });

  for (const copy of [false, true]) {
    test(`bodies alone (${copy ? "copies" : "links"}) record what a live source without rules installed`, async () => {
      await world(async ({ home, dir, userHome, project }) => {
        const older = writeSource(join(dir, "older"), { alpha: { description: "Alpha." } });
        const newer = writeSource(join(dir, "newer"), { beta: { description: "Newer beta." } });
        const noRules = {
          destination: { scope: "project" as const, root: project },
          rule: false,
          copy,
        };
        writeState(
          home,
          stateWith({
            [older]: entryFor(localFrom(older, true), noRules),
            [newer]: {
              ...entryFor(localFrom(newer, true), noRules),
              addedAt: "2026-08-02T00:00:00.000Z",
            },
          }),
        );
        const io = fakeIo({ home, userHome, cwd: project });
        await runSync(SYNC, io);
        const body = join(project, ".agents", "memories", "beta.md");
        const before = copy ? readFileSync(body, "utf8") : readlinkSync(body);
        writeFileSync(
          join(older, "memories", "beta.md"),
          memoryFile("beta", { description: "Older beta." }),
        );
        await expectExit(runSync(SYNC, io), ExitCode.NameCollision);
        expect(copy ? readFileSync(body, "utf8") : readlinkSync(body)).toBe(before);
      });
    });
  }

  test("two sources shipping identical bytes as copies do not claim each other's names", async () => {
    await world(async ({ home, dir, userHome, project }) => {
      const first = writeSource(join(dir, "first"), { shared: { description: "Same." } });
      const second = writeSource(join(dir, "second"), { shared: { description: "Same." } });
      const noRules = {
        destination: { scope: "project" as const, root: project },
        rule: false,
        copy: true,
      };
      writeState(
        home,
        stateWith({
          [first]: entryFor(localFrom(first, true), noRules),
          [second]: {
            ...entryFor(localFrom(second, true), {
              ...noRules,
              rename: { [memoryName("shared")]: memoryName("shared-second") },
            }),
            addedAt: "2026-08-02T00:00:00.000Z",
          },
        }),
      );
      const io = fakeIo({ home, userHome, cwd: project });
      await runSync(SYNC, io);
      const second_ = await runSync(SYNC, io);
      expect(second_.plan.changes).toEqual([]);
      expect(second_.memories).toBe(2);
    });
  });

  test("a refusal retry judges copy ownership from the same installed snapshot", async () => {
    await world(async ({ home, dir, userHome, project }) => {
      const first = writeSource(join(dir, "first"), { shared: { description: "Same." } });
      const second = writeSource(join(dir, "second"), { shared: { description: "Same." } });
      const noRules = {
        destination: { scope: "project" as const, root: project },
        rule: false,
        copy: true,
      };
      const rename = { [memoryName("shared")]: memoryName("shared-second") };
      writeState(
        home,
        stateWith({
          [first]: entryFor(localFrom(first, true), { ...noRules, rule: true }),
          [second]: {
            ...entryFor(localFrom(second, true), { ...noRules, rename }),
            addedAt: "2026-08-02T00:00:00.000Z",
          },
        }),
      );
      const io = fakeIo({ home, userHome, cwd: project });
      await runSync(SYNC, io);
      writeFileSync(
        join(first, "memories", "extra.md"),
        memoryFile("extra", { description: "Extra." }),
      );
      writeFileSync(homePaths(home).config, JSON.stringify({ ruleCap: 1 }));
      io.out.length = 0;
      const error = await expectExit(
        runSync({ ...SYNC, json: true }, io),
        ExitCode.RuleCapExceeded,
      );
      expect(error.message).toContain("2 rule lines exceed the cap of 1");
      const document = JSON.parse(io.out.join(""));
      expect(document.report.memories).toBe(1);
      expect(document.report.notices.some((line: string) => line.includes("collision"))).toBe(
        false,
      );
    });
  });

  test("a hidden internal memory reserves nothing on the next sync", async () => {
    await world(async ({ home, dir, userHome }) => {
      const hider = writeSource(join(dir, "a-hider"), {
        open: { description: "Open." },
        secret: { description: "Hidden.", internal: true },
      });
      const owner = writeSource(join(dir, "z-owner"), {
        secret: { description: "Public secret." },
      });
      writeState(
        home,
        stateWith({
          [hider]: entryFor(localFrom(hider)),
          [owner]: { ...entryFor(localFrom(owner)), addedAt: "2026-08-02T00:00:00.000Z" },
        }),
      );
      const io = fakeIo({ home, userHome, cwd: dir });
      const first = await runSync(SYNC, io);
      expect(first.rules).toBe(2);
      const second = await runSync(SYNC, io);
      expect(second.plan.changes).toEqual([]);
      expect(second.rules).toBe(2);
    });
  });

  test("a shared file left inside an open fence gets the fence closed, once, before the block", async () => {
    await world(async ({ home, dir, userHome }) => {
      const source = writeSource(join(dir, "src"), TWO_MEMORIES);
      writeState(
        home,
        stateWith({ [source]: entryFor(localFrom(source), { harnesses: ["codex"] }) }),
      );
      const shared = join(userHome, ".fixture", "FIXTURE.md");
      writeFileSync(shared, "# Mine\n\n```sh\necho open\n");
      const io = fakeIo({ home, userHome, cwd: dir });
      await runSync(SYNC, io);
      const first = readFileSync(shared, "utf8");
      expect(parseBlocks(first).blocks).toHaveLength(1);
      expect(first.startsWith("# Mine\n\n```sh\necho open\n```\n\n<!-- maxims:begin ")).toBe(true);
      const second = await runSync(SYNC, io);
      expect(second.plan.changes).toEqual([]);
    });
  });

  test("a byte budget hit in one file retracts the source's blocks from every other file too", async () => {
    await world(async ({ home, dir, userHome }) => {
      const source = writeSource(join(dir, "src"), TWO_MEMORIES);
      const entry = entryFor(localFrom(source), { harnesses: ["claude-code", "codex"] });
      writeState(home, stateWith({ [source]: entry }));
      const tiny: HarnessDefinition = { ...rulesDirHarness, byteBudget: 64 };
      const io = fakeIo({ home, userHome, cwd: dir, harnesses: [tiny, sharedBlockHarness] });
      await expectExit(runSync(SYNC, io), ExitCode.RuleCapExceeded);
      expect(existsSync(join(userHome, ".fixture", "FIXTURE.md"))).toBe(false);
      expect(existsSync(join(userHome, ".fixture", "rules"))).toBe(false);
      expect(existsSync(storePathFor(home, localFrom(source)))).toBe(false);
    });
  });

  test("a refused refresh keeps the last-good store copy and fetch facts", async () => {
    await world(async ({ home, dir, userHome }) => {
      const upstream = writeSource(join(dir, "upstream"), { alpha: { description: "Alpha." } });
      const from = githubFrom("acme/rules");
      seedStore(home, from, upstream);
      const facts = await fetchedFacts(upstream, daysAgo(NOW, 9), null, "a".repeat(40));
      writeState(home, stateWith({ "@acme/rules": fetchedEntry(from, facts) }));
      const many = Object.fromEntries(
        Array.from({ length: 26 }, (_, index) => [
          `rule-${index}`,
          { description: `Rule ${index}.` },
        ]),
      );
      const grown = writeSource(join(dir, "grown"), many);
      const fake = fakeResolvers();
      fake.set(from, { kind: "dir", dir: grown, sha: "b".repeat(40) });
      const io = fakeIo({ home, userHome, cwd: dir, resolvers: fake.resolvers });
      await expectExit(runSync(SYNC, io), ExitCode.RuleCapExceeded);
      expect(existsSync(join(storePathFor(home, from), "memories", "alpha.md"))).toBe(true);
      expect(existsSync(join(storePathFor(home, from), "memories", "rule-0.md"))).toBe(false);
      expect(fetchedOf(home, "@acme/rules")?.sha).toBe(gitSha("a".repeat(40)));
    });
  });

  test("a hook run leaves a copied body as it is when links become possible", async () => {
    await world(async ({ home, dir, userHome, project }) => {
      const source = writeSource(join(dir, "src"), TWO_MEMORIES);
      const entry = entryFor(localFrom(source), {
        destination: { scope: "project", root: project },
      });
      writeState(home, stateWith({ [source]: entry }));
      const io = fakeIo({ home, userHome, cwd: project });
      io.symlink = { ok: false, reason: "EPERM" };
      await runSync(SYNC, io);
      io.symlink = { ok: true };
      io.clock.now = new Date(NOW.getTime() + 120_000);
      io.out.length = 0;
      await runSync(QUIET, io);
      const body = join(project, ".agents", "memories", "always-review.md");
      expect(lstatSync(body).isFile()).toBe(true);
      expect(io.out.join("")).toBe("");
    });
  });

  test("a shared file the user keeps as a symlink is skipped with a notice, never replaced", async () => {
    await world(async ({ home, dir, userHome }) => {
      const source = writeSource(join(dir, "src"), TWO_MEMORIES);
      writeState(
        home,
        stateWith({ [source]: entryFor(localFrom(source), { harnesses: ["codex"] }) }),
      );
      const real = join(dir, "dotfiles-AGENTS.md");
      writeFileSync(real, "# From dotfiles\n");
      const shared = join(userHome, ".fixture", "FIXTURE.md");
      symlinkSync(real, shared);
      const io = fakeIo({ home, userHome, cwd: dir });
      const report = await runSync(SYNC, io);
      expect(lstatSync(shared).isSymbolicLink()).toBe(true);
      expect(readFileSync(real, "utf8")).toBe("# From dotfiles\n");
      expect(report.notices).toContain(
        `maxims: ${shared} is a symlink; managed blocks are not written through links`,
      );
    });
  });

  test("a hook run leaves a departed source's block in a shared file; an interactive run strips it", async () => {
    await world(async ({ home, dir, userHome }) => {
      const source = writeSource(join(dir, "src"), TWO_MEMORIES);
      const shared = join(userHome, ".fixture", "FIXTURE.md");
      writeFileSync(shared, "# Mine\n");
      writeState(
        home,
        stateWith({ [source]: entryFor(localFrom(source), { harnesses: ["codex"] }) }),
      );
      const io = fakeIo({ home, userHome, cwd: dir });
      await runSync(SYNC, io);
      writeState(home, stateWith({}));
      io.clock.now = new Date(NOW.getTime() + 120_000);
      await runSync(QUIET, io);
      expect(parseBlocks(readFileSync(shared, "utf8")).blocks).toHaveLength(1);
      await runSync(SYNC, io);
      expect(readFileSync(shared, "utf8")).toBe("# Mine\n");
    });
  });
});

describe("a vanished source's destination", () => {
  // Its rule file has that source as its only writer and nothing to render this run, so the
  // destination is not visited: a parent that became a regular file is a write failure for a
  // readable source, never a stop for a run that only keeps the file. The shared fixture's hook
  // file lives in the same folder and would be reported as its own failure, so it is left out.
  const parents: [string, HarnessDefinition, string][] = [
    ["a rules directory", rulesDirHarness, join(".fixture", "rules")],
    [
      "the folder holding a shared file",
      { ...sharedBlockHarness, hook: { kind: "none" } },
      ".fixture",
    ],
  ];
  for (const [label, def, parent] of parents) {
    test(`${label} is not visited, even once it has become a regular file`, async () => {
      await world(async ({ home, dir, userHome }) => {
        const live = writeSource(join(dir, "live"), TWO_MEMORIES);
        writeState(
          home,
          stateWith({ [live]: entryFor(localFrom(live, true), { harnesses: [def.id] }) }),
        );
        const io = fakeIo({ home, userHome, cwd: dir, harnesses: [def] });
        await runSync(SYNC, io);
        rmSync(live, { recursive: true });
        const path = join(userHome, parent);
        rmSync(path, { recursive: true });
        writeFileSync(path, "not a directory\n");
        const report = await runSync(SYNC, io);
        expect(report.failed.map((failure) => failure.key)).toEqual([live]);
        expect(readFileSync(path, "utf8")).toBe("not a directory\n");
      });
    });
  }
});

// A user's BEGIN and END left around the only block of a shared file are text while the block
// stands between them; removing it would pair them into a block the next sweep takes. The grammar
// refuses that removal, and the refusal holds that one file: every other write of the run lands,
// a hook run stays exit 0 and says so on stdout, and only the verb asked for the removal exits 4.
describe("a shared file whose block a stray marker pair wraps", () => {
  const STRAY_BEGIN = "<!-- maxims:begin @stray/notes sha=old -->\nKEEP ME\n";
  const STRAY_END = "<!-- maxims:end @stray/notes -->\n";
  const hint =
    'edit or delete the stray "maxims:begin" and "maxims:end" lines around the block, then retry';
  const refusal = (key: string): string =>
    `removing the ${key} block would pair the stray maxims markers for @stray/notes around it into a managed block`;

  // Two sources, one per fixture harness: the wrapped block is the shared file's only one, and the
  // rules-dir source has a pending refresh the hold must not take with it.
  async function wrapped(
    fn: (world: {
      io: ReturnType<typeof fakeIo>;
      home: string;
      wrappedKey: string;
      otherKey: string;
      shared: string;
      sharedBefore: string;
      rulesFile: string;
    }) => Promise<void>,
  ): Promise<void> {
    await world(async ({ home, dir, userHome }) => {
      const wrappedKey = writeSource(join(dir, "wrapped"), { one: { description: "One." } });
      const otherKey = writeSource(join(dir, "other"), { two: { description: "Two." } });
      writeState(
        home,
        stateWith({
          [wrappedKey]: entryFor(localFrom(wrappedKey, true), { harnesses: ["codex"] }),
          [otherKey]: entryFor(localFrom(otherKey, true), { harnesses: ["claude-code"] }),
        }),
      );
      const io = fakeIo({ home, userHome, cwd: dir });
      await runSync(SYNC, io);
      const shared = join(userHome, ".fixture", "FIXTURE.md");
      const sharedBefore = `${STRAY_BEGIN}${readFileSync(shared, "utf8")}${STRAY_END}`;
      writeFileSync(shared, sharedBefore);
      writeFileSync(
        join(otherKey, "memories", "two.md"),
        memoryFile("two", { description: "Two, revised." }),
      );
      const rulesFile = globalRulesFile(userHome, sourceSlug(localFrom(otherKey, true)));
      await fn({ io, home, wrappedKey, otherKey, shared, sharedBefore, rulesFile });
    });
  }

  test("a hook run holds the file, lands the other write, exits 0 and logs the refusal as a line", async () => {
    await wrapped(async ({ io, home, wrappedKey, otherKey, shared, sharedBefore, rulesFile }) => {
      writeState(
        home,
        stateWith({
          [otherKey]: entryFor(localFrom(otherKey, true), { harnesses: ["claude-code"] }),
        }),
      );
      io.clock.now = new Date(NOW.getTime() + DAY_MS);
      io.out.length = 0;
      const report = await runSync(QUIET, io);
      expect(report.notices).toEqual(
        expect.arrayContaining([`maxims: ${refusal(wrappedKey)}`, `maxims: ${hint}`]),
      );
      expect(io.out.join("")).toBe(
        `maxims: ${refusal(wrappedKey)}\nmaxims: ${hint}\nmaxims: rules refreshed (1 file updated)\n`,
      );
      expect(readFileSync(shared, "utf8")).toBe(sharedBefore);
      expect(readFileSync(rulesFile, "utf8")).toContain("Two, revised.");
      const log = readFileSync(homePaths(home).log, "utf8");
      expect(log).not.toContain("crashed");
      expect(log).toContain(`sync --quiet: maxims: ${refusal(wrappedKey)}`);
    });
  });

  test("an interactive sync prints the refusal and exits 0; a removal of that source exits 4", async () => {
    await wrapped(async ({ io, home, wrappedKey, otherKey, shared, sharedBefore, rulesFile }) => {
      const remove = { quiet: false, dryRun: false, json: false, all: false, confirmed: true };
      const error = await expectExit(
        runRemove({ ...remove, targets: [wrappedKey] }, io),
        ExitCode.DestinationWriteFailed,
      );
      expect({ message: error.message, hint: error.hint }).toEqual({
        message: refusal(wrappedKey),
        hint,
      });
      expect(Object.keys(readStateFile(home).sources)).toEqual([otherKey]);
      expect(readFileSync(shared, "utf8")).toBe(sharedBefore);
      expect(readFileSync(rulesFile, "utf8")).toContain("Two, revised.");
      io.out.length = 0;
      const report = await runSync(SYNC, io);
      expect(report.notices).toEqual(
        expect.arrayContaining([`maxims: ${refusal(wrappedKey)}`, `maxims: ${hint}`]),
      );
      expect(io.out.join("")).toContain(`!  maxims: ${refusal(wrappedKey)}\n!  maxims: ${hint}\n`);
      // The hold is the run's outcome: no up-to-date line is printed beside it.
      expect(io.out.join("")).not.toContain("Up to date");
      expect(report.heldFiles).toEqual([shared]);
      expect(readFileSync(shared, "utf8")).toBe(sharedBefore);
    });
  });

  test("the --json document of the removal carries the refusal as its failure", async () => {
    await wrapped(async ({ io, wrappedKey, shared, sharedBefore }) => {
      const remove = { quiet: false, dryRun: false, json: true, all: false, confirmed: true };
      io.out.length = 0;
      await expectExit(
        runRemove({ ...remove, targets: [wrappedKey] }, io),
        ExitCode.DestinationWriteFailed,
      );
      const document = JSON.parse(io.out.join(""));
      expect({
        ok: document.ok,
        code: document.code,
        message: document.message,
        hint: document.hint,
      }).toEqual({
        ok: false,
        code: ExitCode.DestinationWriteFailed,
        message: refusal(wrappedKey),
        hint,
      });
      expect(document.report.notices).toEqual(
        expect.arrayContaining([`maxims: ${refusal(wrappedKey)}`, `maxims: ${hint}`]),
      );
      expect(readFileSync(shared, "utf8")).toBe(sharedBefore);
    });
  });
});
