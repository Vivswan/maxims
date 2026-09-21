// What would drift silently: a sync that rewrites byte-identical files (mtime churn, a hook that
// never settles), a wiped destination that is not restored from intent alone, a body link that
// points anywhere but the store, a shared file whose user text is not preserved, and a harness
// written into a project that has none of its config.
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
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { isAbsolute, join } from "node:path";
import {
  configEditHarness,
  daysAgo,
  entryFor,
  FIXTURE_CONFIG_CONTENT,
  FIXTURE_DIR,
  fakeIo,
  fakeResolvers,
  fetchedEntry,
  fetchedFacts,
  githubFrom,
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
import {
  budgetedReader,
  DAY_MS,
  fetchedOf,
  heldHint,
  NOW,
  QUIET,
  SYNC,
} from "../../tests/shared/sync_support.ts";
import { type HarnessDefinition, type HarnessId, HOOK_COMMAND } from "../harnesses/contract.ts";
import { HARNESSES } from "../harnesses/registry.ts";
import { parseBlocks } from "../rulefile/block.ts";
import { ExitCode } from "../util/exit-codes.ts";
import { homePaths, storePathFor } from "../util/home.ts";
import { sourceSlug } from "./shared/slug.ts";
import { runSync } from "./sync.ts";

describe("idempotency and convergence", () => {
  test("the second sync plans nothing and leaves every file, and state, untouched", async () => {
    await world(async ({ home, dir, userHome }) => {
      const source = writeSource(join(dir, "src"), TWO_MEMORIES);
      writeState(home, stateWith({ [source]: entryFor(localFrom(source)) }, ["claude-code"]));
      const io = fakeIo({ home, userHome, cwd: dir });
      const first = await runSync(SYNC, io);
      expect(first.rules).toBe(2);
      expect(first.memories).toBe(2);
      const before = treeDigest(userHome);
      const stateMtime = statSync(homePaths(home).state).mtimeMs;
      io.clock.now = new Date(NOW.getTime() + 1000);
      const second = await runSync(SYNC, io);
      expect(second.plan.changes).toEqual([]);
      expect(treeDigest(userHome)).toBe(before);
      expect(statSync(homePaths(home).state).mtimeMs).toBe(stateMtime);
    });
  });

  test("a change planned every run but landing nothing is not reported: the run says up to date, a hook run says nothing", async () => {
    await world(async ({ home, dir, userHome }) => {
      const source = writeSource(join(dir, "src"), TWO_MEMORIES);
      writeState(home, stateWith({ [source]: entryFor(localFrom(source)) }, ["claude-code"]));
      const io = fakeIo({ home, userHome, cwd: dir, harnesses: [configEditHarness] });
      await runSync(SYNC, io);
      const config = join(userHome, FIXTURE_DIR, "config.json");
      expect(readFileSync(config, "utf8")).toBe(FIXTURE_CONFIG_CONTENT);
      io.out.length = 0;
      io.clock.now = new Date(NOW.getTime() + 1000);
      const second = await runSync(SYNC, io);
      expect(second.plan.changes.map((change) => String(change.path))).toEqual([config]);
      expect(second.changed).toEqual([]);
      expect(io.out.join("")).toBe("o  Up to date: 2 memories, 2 rule lines\n");
      io.out.length = 0;
      io.clock.now = new Date(NOW.getTime() + 120_000);
      const hook = await runSync(QUIET, io);
      expect(hook.changed).toEqual([]);
      expect(io.out.join("")).toBe("");
      const logged = readFileSync(homePaths(home).log, "utf8")
        .split("\n")
        .filter((line) => line.endsWith(`write ${config}`));
      expect(logged).toHaveLength(1);
    });
  });

  test("with the shipped registry a second sync plans nothing, says up to date, and a hook run prints nothing", async () => {
    await world(async ({ home, dir, userHome }) => {
      const source = writeSource(join(dir, "src"), TWO_MEMORIES);
      writeState(home, stateWith({ [source]: entryFor(localFrom(source)) }, ["claude-code"]));
      const io = fakeIo({ home, userHome, cwd: dir, harnesses: HARNESSES });
      await runSync(SYNC, io);
      io.out.length = 0;
      io.clock.now = new Date(NOW.getTime() + 1000);
      const second = await runSync(SYNC, io);
      expect(second.plan.changes).toEqual([]);
      expect(second.changed).toEqual([]);
      expect(io.out.join("")).toBe("o  Up to date: 2 memories, 2 rule lines\n");
      io.out.length = 0;
      await runSync({ ...SYNC, dryRun: true }, io);
      expect(io.out.join("")).toBe("nothing to change\n");
      io.out.length = 0;
      io.clock.now = new Date(NOW.getTime() + 120_000);
      await runSync(QUIET, io);
      expect(io.out.join("")).toBe("");
      expect(readFileSync(homePaths(home).log, "utf8")).not.toContain("deferred");
    });
  });

  test("wiped rule files and a hand-edited hook come back byte-identical from intent and store", async () => {
    await world(async ({ home, dir, userHome }) => {
      const source = writeSource(join(dir, "src"), TWO_MEMORIES);
      writeState(home, stateWith({ [source]: entryFor(localFrom(source)) }, ["claude-code"]));
      const io = fakeIo({ home, userHome, cwd: dir });
      await runSync(SYNC, io);
      const rules = join(userHome, ".fixture", "rules");
      const digest = treeDigest(rules);
      rmSync(rules, { recursive: true });
      const settings = join(userHome, ".fixture", "settings.json");
      const stale = { type: "command", command: "npx -y @vivswan/maxims sync --old" };
      writeFileSync(settings, JSON.stringify({ hooks: { SessionStart: [{ hooks: [stale] }] } }));
      await runSync(SYNC, io);
      expect(treeDigest(rules)).toBe(digest);
      expect(readFileSync(settings, "utf8")).toContain(HOOK_COMMAND);
      expect(readFileSync(settings, "utf8")).not.toContain("--old");
      writeFileSync(settings, "{}\n");
      await runSync(SYNC, io);
      expect(readFileSync(settings, "utf8")).toContain(HOOK_COMMAND);
    });
  });

  test("a github source with a store copy inside its cooldown never touches the resolver", async () => {
    await world(async ({ home, dir, userHome }) => {
      const upstream = writeSource(join(dir, "upstream"), TWO_MEMORIES);
      const from = githubFrom("acme/rules");
      seedStore(home, from, upstream);
      const facts = await fetchedFacts(upstream, daysAgo(NOW, 2));
      writeState(home, stateWith({ "@acme/rules": fetchedEntry(from, facts) }));
      const fake = fakeResolvers();
      fake.set(from, { kind: "dir", dir: upstream });
      const io = fakeIo({ home, userHome, cwd: dir, resolvers: fake.resolvers });
      const report = await runSync(SYNC, io);
      expect(fake.calls).toEqual([]);
      expect(report.fetched).toEqual([]);
      expect(existsSync(globalRulesFile(userHome, "acme-rules"))).toBe(true);
    });
  });

  test("past the cooldown an unchanged remote refreshes the timestamp and writes no file", async () => {
    await world(async ({ home, dir, userHome }) => {
      const upstream = writeSource(join(dir, "upstream"), TWO_MEMORIES);
      const from = githubFrom("acme/rules");
      seedStore(home, from, upstream);
      const facts = await fetchedFacts(upstream, daysAgo(NOW, 9));
      writeState(home, stateWith({ "@acme/rules": fetchedEntry(from, facts) }));
      const fake = fakeResolvers();
      fake.set(from, { kind: "dir", dir: upstream });
      const io = fakeIo({ home, userHome, cwd: dir, resolvers: fake.resolvers });
      await runSync(SYNC, io);
      const before = treeDigest(userHome);
      io.clock.now = new Date(NOW.getTime() + 8 * DAY_MS);
      const report = await runSync(SYNC, io);
      expect(fake.calls).toEqual(["resolveRef @acme/rules", "resolveRef @acme/rules"]);
      expect(report.fetched).toEqual([]);
      expect(fetchedOf(home, "@acme/rules")?.at).toBe(io.clock.now.toISOString());
      expect(treeDigest(userHome)).toBe(before);
    });
  });

  test("a changed remote lands its new lines and reports the diff, never the local-edit notice", async () => {
    await world(async ({ home, dir, userHome }) => {
      const upstream = writeSource(join(dir, "upstream"), TWO_MEMORIES);
      const from = githubFrom("acme/rules");
      seedStore(home, from, upstream);
      const facts = await fetchedFacts(upstream, daysAgo(NOW, 1), null, "a".repeat(40));
      writeState(home, stateWith({ "@acme/rules": fetchedEntry(from, facts) }));
      const fake = fakeResolvers();
      fake.set(from, { kind: "dir", dir: upstream, sha: "a".repeat(40) });
      const io = fakeIo({ home, userHome, cwd: dir, resolvers: fake.resolvers });
      await runSync(SYNC, io);
      const memories = join(upstream, "memories");
      const changed = memoryFile("always-review", { description: "Review before every push." });
      writeFileSync(join(memories, "always-review.md"), changed);
      writeFileSync(join(memories, "new-rule.md"), memoryFile("new-rule", { description: "New." }));
      rmSync(join(memories, "keep-tests-green.md"));
      fake.set(from, { kind: "dir", dir: upstream, sha: "b".repeat(40) });
      io.clock.now = new Date(NOW.getTime() + 10 * DAY_MS);
      const report = await runSync(SYNC, io);
      expect(report.fetched).toEqual(["@acme/rules"]);
      const diff = report.notices.filter((line) => /^[+~-] /.test(line));
      expect(diff).toHaveLength(3);
      expect(diff[0]).toMatch(/^~ always-review \([0-9a-f]{7} -> [0-9a-f]{7}\)$/);
      expect(diff.slice(1)).toEqual(["- keep-tests-green", "+ new-rule"]);
      expect(report.notices.some((line) => line.includes("local edit"))).toBe(false);
      const text = readFileSync(globalRulesFile(userHome, "acme-rules"), "utf8");
      expect(text).toContain("Review before every push.");
      expect(text).not.toContain("Never merge red.");
      const gone = join(storePathFor(home, from), "memories", "keep-tests-green.md");
      expect(existsSync(gone)).toBe(false);
    });
  });

  test("an edit inside the block is discarded with one notice; text outside a shared block survives", async () => {
    await world(async ({ home, dir, userHome }) => {
      const source = writeSource(join(dir, "src"), TWO_MEMORIES);
      const both = entryFor(localFrom(source), { harnesses: ["claude-code", "codex"] });
      writeState(home, stateWith({ [source]: both }));
      const shared = join(userHome, ".fixture", "FIXTURE.md");
      writeFileSync(shared, "# Mine\n\nKeep this.\n");
      const io = fakeIo({ home, userHome, cwd: dir });
      await runSync(SYNC, io);
      const rules = globalRulesFile(userHome, sourceSlug(localFrom(source)));
      const original = readFileSync(rules, "utf8");
      writeFileSync(rules, original.replace("Never merge red.", "Never merge anything."));
      const report = await runSync(SYNC, io);
      expect(report.notices).toContain(
        `maxims: local edit in ${rules} discarded (the block is regenerated from ${source})`,
      );
      expect(readFileSync(rules, "utf8")).toBe(original);
      const sharedText = readFileSync(shared, "utf8");
      expect(sharedText.startsWith("# Mine\n\nKeep this.\n\n<!-- maxims:begin ")).toBe(true);
    });
  });

  const handEdits: [string, (block: string) => string][] = [
    [
      "a line of the user's own inside the markers",
      (block) => block.replace("<!-- maxims:end", "- My own rule.\n<!-- maxims:end"),
    ],
    [
      "an edited rule whose description opens like the staleness notice",
      (block) => block.replace("upstream need review.", "upstream need no review."),
    ],
    [
      "an edited tail of the provenance comment",
      (block) => block.replace("edits will be overwritten -->", "edits will be preserved -->"),
    ],
    [
      "a line of the user's own that opens like the staleness notice",
      (block) =>
        block.replace(
          "<!-- maxims:end",
          "- maxims: the rules below from upstream are mine.\n<!-- maxims:end",
        ),
    ],
  ];
  test.each(handEdits)("%s is a local edit, discarded with the notice", async (_label, edit) => {
    await world(async ({ home, dir, userHome }) => {
      const source = writeSource(join(dir, "src"), TWO_MEMORIES);
      writeFileSync(
        join(source, "memories", "review-upstream.md"),
        memoryFile("review-upstream", { description: "Review upstream." }).replace(
          "description: Review upstream.",
          'description: "maxims: the rules below from upstream need review."',
        ),
      );
      writeState(home, stateWith({ [source]: entryFor(localFrom(source)) }));
      const io = fakeIo({ home, userHome, cwd: dir });
      await runSync(SYNC, io);
      const rules = globalRulesFile(userHome, sourceSlug(localFrom(source)));
      const original = readFileSync(rules, "utf8");
      const edited = edit(original);
      expect(edited).not.toBe(original);
      writeFileSync(rules, edited);
      const report = await runSync(SYNC, io);
      expect(report.notices).toContain(
        `maxims: local edit in ${rules} discarded (the block is regenerated from ${source})`,
      );
      expect(readFileSync(rules, "utf8")).toBe(original);
    });
  });

  test("a memory disabled, then enabled, between two syncs changes the block without a local-edit notice", async () => {
    await world(async ({ home, dir, userHome }) => {
      const source = writeSource(join(dir, "src"), TWO_MEMORIES);
      // Live, so no run refreshes it: the block changes with the intent alone, as after `disable`.
      const entry = entryFor(localFrom(source, true));
      writeState(home, stateWith({ [source]: entry }));
      const io = fakeIo({ home, userHome, cwd: dir });
      await runSync(SYNC, io);
      const rules = globalRulesFile(userHome, sourceSlug(localFrom(source, true)));
      const original = readFileSync(rules, "utf8");
      writeState(
        home,
        stateWith({ [source]: entry }, [], { global: [memoryName("keep-tests-green")] }),
      );
      const disabled = await runSync(SYNC, io);
      expect(disabled.notices.filter((line) => line.includes("local edit"))).toEqual([]);
      expect(readFileSync(rules, "utf8")).not.toContain("Never merge red.");
      writeState(home, stateWith({ [source]: entry }));
      const enabled = await runSync(SYNC, io);
      expect(enabled.notices.filter((line) => line.includes("local edit"))).toEqual([]);
      expect(readFileSync(rules, "utf8")).toBe(original);
    });
  });
});

describe("project scope", () => {
  test("bodies link relatively into the store and rule lines carry the project-relative path", async () => {
    await world(async ({ home, dir, userHome, project }) => {
      const source = writeSource(join(dir, "src"), TWO_MEMORIES);
      const entry = entryFor(localFrom(source), {
        destination: { scope: "project", root: project },
      });
      writeState(home, stateWith({ [source]: entry }));
      const io = fakeIo({ home, userHome, cwd: project });
      await runSync(SYNC, io);
      const link = join(project, ".agents", "memories", "always-review.md");
      expect(lstatSync(link).isSymbolicLink()).toBe(true);
      expect(isAbsolute(readlinkSync(link))).toBe(false);
      const stored = join(storePathFor(home, localFrom(source)), "memories", "always-review.md");
      expect(realpathSync(link)).toBe(realpathSync(stored));
      const rulesFile = join(
        project,
        ".fixture",
        "rules",
        `maxims-${sourceSlug(localFrom(source))}.md`,
      );
      expect(readFileSync(rulesFile, "utf8")).toContain(
        "(detail: .agents/memories/always-review.md, ",
      );
      expect(existsSync(join(userHome, ".fixture", "rules"))).toBe(false);
    });
  });

  test("--copy and a machine without symlinks both write real bodies, the latter with a hint", async () => {
    await world(async ({ home, dir, userHome, project }) => {
      const source = writeSource(join(dir, "src"), TWO_MEMORIES);
      const body = join(project, ".agents", "memories", "always-review.md");
      const cases = [
        { copy: true, symlink: { ok: true } as const },
        { copy: false, symlink: { ok: false, reason: "EPERM" } as const },
      ];
      for (const { copy, symlink } of cases) {
        rmSync(join(project, ".agents"), { recursive: true, force: true });
        const entry = entryFor(localFrom(source), {
          destination: { scope: "project", root: project },
          copy,
        });
        writeState(home, stateWith({ [source]: entry }));
        const io = fakeIo({ home, userHome, cwd: project });
        io.symlink = symlink;
        const report = await runSync(SYNC, io);
        expect(lstatSync(body).isFile()).toBe(true);
        const expected = memoryFile("always-review", TWO_MEMORIES["always-review"]);
        expect(readFileSync(body, "utf8")).toBe(expected);
        const hinted = report.notices.some((line) => line.includes("enable Developer Mode"));
        expect(hinted).toBe(!copy);
      }
    });
  });

  test("a project without the harness's config folder is skipped, and refused with -a", async () => {
    await world(async ({ home, dir, userHome, project }) => {
      rmSync(join(project, ".fixture"), { recursive: true });
      const source = writeSource(join(dir, "src"), TWO_MEMORIES);
      const entry = entryFor(localFrom(source), {
        destination: { scope: "project", root: project },
      });
      writeState(home, stateWith({ [source]: entry }));
      const io = fakeIo({ home, userHome, cwd: project });
      const report = await runSync(SYNC, io);
      const folder = join(project, ".fixture");
      expect(report.notices).toContain(
        `maxims: ${source}: skipped claude-code (Fixture Rules: ${folder} does not exist)`,
      );
      expect(existsSync(folder)).toBe(false);
      const explicit = runSync({ ...SYNC, agents: ["claude-code"] }, io);
      await expectExit(explicit, ExitCode.DestinationWriteFailed);
      writeFileSync(folder, "legacy single file");
      const conflict = await runSync(SYNC, io);
      expect(conflict.notices.some((line) => line.includes("is a file, not the directory"))).toBe(
        true,
      );
      expect(readFileSync(folder, "utf8")).toBe("legacy single file");
    });
  });

  test("a harness with no user-scope target is skipped at -g with a notice", async () => {
    await world(async ({ home, dir, userHome }) => {
      const projectOnly: HarnessDefinition = {
        ...rulesDirHarness,
        id: "cursor",
        displayName: "Project Only",
        targets: { project: rulesDirHarness.targets.project, global: null },
        hook: { kind: "none" },
      };
      const source = writeSource(join(dir, "src"), TWO_MEMORIES);
      writeState(
        home,
        stateWith({ [source]: entryFor(localFrom(source), { harnesses: ["cursor"] }) }),
      );
      const io = fakeIo({ home, userHome, cwd: dir, harnesses: [projectOnly] });
      const report = await runSync(SYNC, io);
      expect(report.notices).toContain(`maxims: ${source}: skipped cursor (no global target)`);
      expect(report.rules).toBe(0);
    });
  });
});

describe("a project rooted at the home directory", () => {
  // Its rules directory is the global one, which every run reaches: a run in another checkout
  // plans nothing for the entry and would sweep its files as orphans.
  test("keeps its rule files through a run in another checkout", async () => {
    await world(async ({ home, userHome, project }) => {
      mkdirSync(join(userHome, ".git"));
      const source = writeSource(join(userHome, "memories"), TWO_MEMORIES);
      const entry = entryFor(localFrom(source, true), {
        destination: { scope: "project", root: userHome },
      });
      writeState(home, stateWith({ [source]: entry }));
      const file = globalRulesFile(userHome, sourceSlug(entry.intent.from));
      const run = (cwd: string) =>
        runSync(SYNC, fakeIo({ home, userHome, cwd, harnesses: [rulesDirHarness] }));
      await run(userHome);
      const written = readFileSync(file, "utf8");
      expect(written).toContain("keep-tests-green");
      const report = await run(project);
      expect(report.plan.changes.filter((change) => change.kind === "delete")).toEqual([]);
      expect(readFileSync(file, "utf8")).toBe(written);
    });
  });

  // Another project's rules directory this run never writes is resolved only to be kept off the
  // sweep; one that project cannot resolve, its config folder a symlink out of the checkout or its
  // root without search permission, is that project's failure.
  test("another project's unresolvable rules folder does not fail a run here", async () => {
    await world(async ({ home, userHome, dir, project }) => {
      const other = join(dir, "other");
      mkdirSync(join(other, ".git"), { recursive: true });
      mkdirSync(join(dir, "dotfiles"));
      symlinkSync(join(dir, "dotfiles"), join(other, ".fixture"));
      const source = writeSource(join(other, "memories"), TWO_MEMORIES);
      const entry = entryFor(localFrom(source, true), {
        destination: { scope: "project", root: other },
      });
      writeState(home, stateWith({ [source]: entry }));
      const io = fakeIo({ home, userHome, cwd: project, harnesses: [rulesDirHarness] });
      const symlinked = await runSync(SYNC, io);
      expect(["symlinked", symlinked.failed, symlinked.plan.changes]).toEqual([
        "symlinked",
        [],
        [],
      ]);
      chmodSync(other, 0o000);
      try {
        const sealed = await runSync(SYNC, io);
        expect(["sealed", sealed.failed, sealed.plan.changes]).toEqual(["sealed", [], []]);
      } finally {
        chmodSync(other, 0o700);
      }
    });
  });

  // One harness's destination failing to resolve there costs the entry that harness's targets
  // only: the other harness's rule file stays off the sweep.
  test("keeps one harness's rule file when another harness's folder cannot be resolved", async () => {
    await world(async ({ home, userHome, dir, project }) => {
      mkdirSync(join(userHome, ".git"));
      const asideDir = { kind: "rules-dir" as const, dir: ".aside/rules", fileName: ruleFileName };
      const aside: HarnessDefinition = {
        ...rulesDirHarness,
        id: "codex",
        displayName: "Fixture Aside",
        targets: { project: asideDir, global: asideDir },
      };
      const harnesses = [rulesDirHarness, aside];
      const source = writeSource(join(userHome, "memories"), TWO_MEMORIES);
      const entry = entryFor(localFrom(source, true), {
        destination: { scope: "project", root: userHome },
        harnesses: ["claude-code", "codex"],
      });
      writeState(home, stateWith({ [source]: entry }));
      mkdirSync(join(userHome, ".aside"));
      await runSync(SYNC, fakeIo({ home, userHome, cwd: userHome, harnesses }));
      const file = globalRulesFile(userHome, sourceSlug(entry.intent.from));
      const written = readFileSync(file, "utf8");
      expect(existsSync(join(userHome, ".aside", "rules"))).toBe(true);
      rmSync(join(userHome, ".aside"), { recursive: true });
      mkdirSync(join(dir, "dotfiles"));
      symlinkSync(join(dir, "dotfiles"), join(userHome, ".aside"));
      const report = await runSync(SYNC, fakeIo({ home, userHome, cwd: project, harnesses }));
      expect(report.plan.changes.filter((change) => change.kind === "delete")).toEqual([]);
      expect(readFileSync(file, "utf8")).toBe(written);
    });
  });
});

function ruleFileName(slug: string): string {
  return `maxims-${slug}.md`;
}

describe("shared files and dedupe", () => {
  test("two definitions reading one file get one block per source, with the user's text intact", async () => {
    await world(async ({ home, dir, userHome }) => {
      const twin: HarnessDefinition = {
        ...sharedBlockHarness,
        id: "gemini-cli",
        displayName: "Twin",
      };
      const source = writeSource(join(dir, "src"), TWO_MEMORIES);
      const entry = entryFor(localFrom(source), { harnesses: ["codex", "gemini-cli"] });
      writeState(home, stateWith({ [source]: entry }));
      const shared = join(userHome, ".fixture", "FIXTURE.md");
      writeFileSync(shared, "# Mine\n");
      const io = fakeIo({ home, userHome, cwd: dir, harnesses: [sharedBlockHarness, twin] });
      await runSync(SYNC, io);
      const text = readFileSync(shared, "utf8");
      expect(parseBlocks(text).blocks.map((block) => block.source)).toEqual([source]);
      expect(text.startsWith("# Mine\n\n")).toBe(true);
      expect(text).not.toContain("managed by maxims");
    });
  });

  test("a name two sources ship is a collision: exit 6, the newer source's block is not written", async () => {
    await world(async ({ home, dir, userHome }) => {
      const first = writeSource(join(dir, "first"), { shared: { description: "First." } });
      const second = writeSource(join(dir, "second"), { shared: { description: "Second." } });
      const later = { ...entryFor(localFrom(second)), addedAt: "2026-08-02T00:00:00.000Z" };
      writeState(home, stateWith({ [first]: entryFor(localFrom(first)), [second]: later }));
      const io = fakeIo({ home, userHome, cwd: dir });
      const error = await expectExit(runSync(SYNC, io), ExitCode.NameCollision);
      expect(error.message).toBe(`${second}: name collision on shared`);
      expect(existsSync(globalRulesFile(userHome, sourceSlug(localFrom(first))))).toBe(true);
      expect(existsSync(globalRulesFile(userHome, sourceSlug(localFrom(second))))).toBe(false);
      io.clock.now = new Date(NOW.getTime() + 120_000);
      const quiet = await runSync(QUIET, io);
      expect(quiet.notices.some((line) => line.includes("is owned by"))).toBe(true);
    });
  });

  test("a rename resolves the collision, and retires with the upstream name", async () => {
    await world(async ({ home, dir, userHome }) => {
      const first = writeSource(join(dir, "first"), { shared: { description: "First." } });
      const second = writeSource(join(dir, "second"), { shared: { description: "Second." } });
      const rename = { [memoryName("shared")]: memoryName("shared-second") };
      const later = {
        ...entryFor(localFrom(second), { rename }),
        addedAt: "2026-08-02T00:00:00.000Z",
      };
      writeState(home, stateWith({ [first]: entryFor(localFrom(first)), [second]: later }));
      const io = fakeIo({ home, userHome, cwd: dir });
      const report = await runSync(SYNC, io);
      expect(report.rules).toBe(2);
      rmSync(join(second, "memories", "shared.md"));
      const renamed = memoryFile("renamed", { description: "Renamed." });
      writeFileSync(join(second, "memories", "renamed.md"), renamed);
      io.clock.now = new Date(NOW.getTime() + 8 * DAY_MS);
      await runSync(SYNC, io);
      expect(readStateFile(home).sources[second]?.intent.rename).toEqual({});
      const text = readFileSync(globalRulesFile(userHome, sourceSlug(localFrom(second))), "utf8");
      expect(text).toContain("Renamed.");
      expect(text).not.toContain("Second.");
    });
  });

  test("over the cap or over a harness byte budget, the whole source is refused with exit 8", async () => {
    await world(async ({ home, dir, userHome }) => {
      const many = Object.fromEntries(
        Array.from({ length: 26 }, (_, index) => [
          `rule-${index}`,
          { description: `Rule ${index}.` },
        ]),
      );
      const source = writeSource(join(dir, "src"), many);
      writeState(home, stateWith({ [source]: entryFor(localFrom(source)) }));
      const io = fakeIo({ home, userHome, cwd: dir });
      const error = await expectExit(runSync(SYNC, io), ExitCode.RuleCapExceeded);
      expect(error.hint).toContain("--cap");
      expect(existsSync(join(userHome, ".fixture", "rules"))).toBe(false);
      const tiny: HarnessDefinition = { ...rulesDirHarness, byteBudget: 64 };
      writeFileSync(homePaths(home).config, JSON.stringify({ ruleCap: 30 }));
      const budgeted = fakeIo({ home, userHome, cwd: dir, harnesses: [tiny] });
      const held = await expectExit(runSync(SYNC, budgeted), ExitCode.RuleCapExceeded);
      const file = globalRulesFile(userHome, sourceSlug(localFrom(source)));
      expect(held.message).toStartWith(`${source} is `);
      expect(held.message).toEndWith(` bytes over the budget for ${file}`);
      expect(held.hint).toBe(heldHint(source, "claude-code"));
      expect(existsSync(join(userHome, ".fixture", "rules"))).toBe(false);
    });
  });

  const readerOrders: HarnessId[][] = [
    ["codex", "dsh"],
    ["dsh", "codex"],
  ];
  for (const harnesses of readerOrders) {
    test(`a shared file over one reader's byte budget is refused with readers ${harnesses.join(",")}`, async () => {
      await world(async ({ home, dir, userHome }) => {
        const source = writeSource(join(dir, "src"), TWO_MEMORIES);
        writeState(home, stateWith({ [source]: entryFor(localFrom(source), { harnesses }) }));
        const io = fakeIo({
          home,
          userHome,
          cwd: dir,
          harnesses: [sharedBlockHarness, budgetedReader(64)],
        });
        const error = await expectExit(runSync(SYNC, io), ExitCode.RuleCapExceeded);
        const shared = join(userHome, ".fixture", "FIXTURE.md");
        expect(error.message).toStartWith(`${source} is `);
        expect(error.message).toEndWith(` bytes over the budget for ${shared}`);
        expect(error.hint).toBe(heldHint(source));
        expect(existsSync(shared)).toBe(false);
      });
    });
  }

  test("a reader only a later source brings to a shared file still judges the whole file", async () => {
    await world(async ({ home, dir, userHome }) => {
      const first = writeSource(join(dir, "first"), { one: { description: "One." } });
      const second = writeSource(join(dir, "second"), { two: { description: "Two." } });
      writeState(
        home,
        stateWith({
          [first]: entryFor(localFrom(first), { harnesses: ["codex"] }),
          [second]: entryFor(localFrom(second), { harnesses: ["codex", "dsh"] }),
        }),
      );
      const io = fakeIo({
        home,
        userHome,
        cwd: dir,
        harnesses: [sharedBlockHarness, budgetedReader(64)],
      });
      const error = await expectExit(runSync(SYNC, io), ExitCode.RuleCapExceeded);
      const shared = join(userHome, ".fixture", "FIXTURE.md");
      expect(error.message).toStartWith(`${second} is `);
      expect(error.message).toEndWith(` bytes over the budget for ${shared}`);
      expect(error.hint).toBe(heldHint(second));
      expect(existsSync(shared)).toBe(false);
    });
  });

  // A live source's store entry is a link its rule lines and bodies resolve through; a source the
  // cap refuses lands nothing, the link included, so the store stays as the last run left it.
  test("a live source refused by the cap leaves the store untouched", async () => {
    await world(async ({ home, dir, userHome }) => {
      const many = Object.fromEntries(
        Array.from({ length: 26 }, (_, index) => [
          `rule-${index}`,
          { description: `Rule ${index}.` },
        ]),
      );
      const live = writeSource(join(dir, "live"), many);
      writeState(home, stateWith({ [live]: entryFor(localFrom(live, true)) }));
      const io = fakeIo({ home, userHome, cwd: dir });
      await expectExit(runSync(SYNC, io), ExitCode.RuleCapExceeded);
      expect(existsSync(homePaths(home).store)).toBe(false);
    });
  });

  test("internal memories hide under `*`, install when named or under MAXIMS_INSTALL_INTERNAL", async () => {
    await world(async ({ home, dir, userHome }) => {
      const source = writeSource(join(dir, "src"), {
        public: { description: "Public." },
        secret: { description: "Secret.", internal: true },
      });
      const rules = () =>
        readFileSync(globalRulesFile(userHome, sourceSlug(localFrom(source))), "utf8");
      writeState(home, stateWith({ [source]: entryFor(localFrom(source)) }));
      const io = fakeIo({ home, userHome, cwd: dir });
      const report = await runSync(SYNC, io);
      expect(report.notices).toContain(`maxims: ${source}: 1 internal, hidden`);
      expect(rules()).not.toContain("Secret.");
      const named = entryFor(localFrom(source), { select: [memoryName("secret")] });
      writeState(home, stateWith({ [source]: named }));
      await runSync(SYNC, io);
      expect(rules()).toContain("Secret.");
      expect(rules()).not.toContain("Public.");
      writeState(home, stateWith({ [source]: entryFor(localFrom(source)) }));
      const opted = fakeIo({ home, userHome, cwd: dir, env: { MAXIMS_INSTALL_INTERNAL: "1" } });
      await runSync(SYNC, opted);
      expect(rules()).toContain("Secret.");
    });
  });
});
