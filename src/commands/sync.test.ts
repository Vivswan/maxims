// What would drift silently: a sync that rewrites byte-identical files (mtime churn, a hook that
// never settles), a wiped destination that is not restored from intent alone, a body link that
// points anywhere but the store, a shared file whose user text is not preserved, a collision or
// an over-cap source that half-installs instead of refusing, a harness written into a project
// that has none of its config, and a `--dry-run` or `--json` that touches disk.
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
import { type HarnessDefinition, type HarnessId, HOOK_COMMAND } from "../harnesses/contract.ts";
import { parseBlocks } from "../rulefile/block.ts";
import { type LocalSourceFrom, materializeLocal } from "../sources/local.ts";
import { readMemoryTree } from "../sources/tree.ts";
import { renderPlan } from "../util/change.ts";
import { ExitCode } from "../util/exit-codes.ts";
import { homePaths, storePathFor } from "../util/home.ts";
import { runRemove } from "./remove.ts";
import { sourceSlug } from "./shared/slug.ts";
import { runSync } from "./sync.ts";
import type { SyncOptions } from "./types.ts";

const SYNC: SyncOptions = {
  quiet: false,
  dryRun: false,
  json: false,
  fetch: "due",
};
const QUIET: SyncOptions = { ...SYNC, quiet: true };
const NOW = new Date("2026-09-20T12:00:00.000Z");
const DAY_MS = 24 * 60 * 60 * 1000;

function budgetedReader(byteBudget: number): HarnessDefinition {
  return { ...sharedBlockHarness, id: "dsh", displayName: "Fixture Budgeted", byteBudget };
}

function fetchedOf(home: string, key: string) {
  const entry = readStateFile(home).sources[key];
  return entry !== undefined && "fetched" in entry ? entry.fetched : undefined;
}

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
});

describe("project scope", () => {
  test("bodies link relatively into the store and rule lines carry the project-relative path", async () => {
    await world(async ({ home, dir, userHome, project }) => {
      const source = writeSource(join(dir, "src"), TWO_MEMORIES);
      const entry = entryFor(localFrom(source), { destination: { scope: "project" } });
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
        const entry = entryFor(localFrom(source), { destination: { scope: "project" }, copy });
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
      const entry = entryFor(localFrom(source), { destination: { scope: "project" } });
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
      await expectExit(runSync(SYNC, budgeted), ExitCode.RuleCapExceeded);
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
        expect(error.message).toContain("over the 64-byte limit Fixture Budgeted loads");
        expect(existsSync(join(userHome, ".fixture", "FIXTURE.md"))).toBe(false);
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
      expect(error.message).toContain("over the 64-byte limit Fixture Budgeted loads");
      expect(existsSync(join(userHome, ".fixture", "FIXTURE.md"))).toBe(false);
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

describe("what a refused or departed source leaves behind", () => {
  test("a colliding source lands neither block nor bodies, so the owner's body stays its own", async () => {
    await world(async ({ home, dir, userHome, project }) => {
      const first = writeSource(join(dir, "first"), { shared: { description: "First." } });
      const second = writeSource(join(dir, "second"), { shared: { description: "Second." } });
      const project_ = { destination: { scope: "project" as const } };
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
      const entry = entryFor(localFrom(source), { destination: { scope: "project" } });
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
      const entry = entryFor(localFrom(source), { destination: { scope: "project" } });
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
    await world(async ({ home, dir, userHome }) => {
      const upstream = writeSource(join(dir, "upstream"), TWO_MEMORIES);
      const from = githubFrom("acme/rules");
      seedStore(home, from, upstream);
      const facts = await fetchedFacts(upstream, daysAgo(NOW, 9), null, "a".repeat(40));
      const entry = fetchedEntry(from, facts, { destination: { scope: "project" } });
      writeState(home, stateWith({ "@acme/rules": entry }));
      const fake = fakeResolvers();
      fake.set(from, { kind: "dir", dir: upstream, sha: "b".repeat(40) });
      const io = fakeIo({ home, userHome, cwd: dir, resolvers: fake.resolvers });
      const report = await runSync(SYNC, io);
      expect(fake.calls).toEqual([]);
      expect(report.fetched).toEqual([]);
      expect(fetchedOf(home, "@acme/rules")?.sha).toBe(gitSha("a".repeat(40)));
    });
  });

  test("a refused refresh keeps the bodies its preserved rules point at", async () => {
    await world(async ({ home, dir, userHome, project }) => {
      const upstream = writeSource(join(dir, "upstream"), { alpha: { description: "Alpha." } });
      const from = githubFrom("acme/rules");
      seedStore(home, from, upstream);
      const facts = await fetchedFacts(upstream, daysAgo(NOW, 9), null, "a".repeat(40));
      const entry = fetchedEntry(from, facts, { destination: { scope: "project" } });
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
          "@acme/rules": fetchedEntry(from, facts, { destination: { scope: "project" } }),
          [rival]: {
            ...entryFor(localFrom(rival), { destination: { scope: "project" } }),
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
      // and the refresh is over the cap; the exit code is the first in key order.
      await expectExit(runSync({ ...SYNC, json: true }, io), ExitCode.NameCollision);
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
          "@acme/rules": fetchedEntry(from, facts, { destination: { scope: "project" } }),
          [rival]: {
            ...entryFor(localFrom(rival), { destination: { scope: "project" } }),
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
      await expectExit(runSync({ ...SYNC, json: true }, io), ExitCode.NameCollision);
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
      const liveEntry = entryFor(localFrom(live, true), { destination: { scope: "project" } });
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
            ...entryFor(localFrom(rival), { destination: { scope: "project" } }),
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
          destination: { scope: "project" },
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
      await expectExit(runSync({ ...SYNC, json: true }, io), ExitCode.NameCollision);
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
      const entry = fetchedEntry(from, facts, { destination: { scope: "project" }, copy: true });
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
        destination: { scope: "project" },
        select: [memoryName("alpha")],
      });
      const newer = writeSource(join(dir, "newer"), { beta: { description: "Newer beta." } });
      writeState(
        home,
        stateWith({
          "@acme/rules": older,
          [newer]: {
            ...entryFor(localFrom(newer), { destination: { scope: "project" } }),
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

  test("a shared-file budget refusal keeps its reason when only the second source was fresh", async () => {
    await world(async ({ home, dir, userHome }) => {
      const first = writeSource(join(dir, "first"), { one: { description: "One." } });
      const upstream = writeSource(join(dir, "upstream"), { two: { description: "Two." } });
      const from = githubFrom("acme/rules");
      const firstEntry = entryFor(localFrom(first), { harnesses: ["codex"] });
      writeState(home, stateWith({ [first]: firstEntry }));
      const plain = fakeIo({ home, userHome, cwd: dir, harnesses: [sharedBlockHarness] });
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
          [first]: firstEntry,
          "@acme/rules": fetchedEntry(from, facts, { harnesses: ["codex"] }),
        }),
      );
      const fake = fakeResolvers();
      fake.set(from, { kind: "dir", dir: upstream, sha: "b".repeat(40) });
      const io = fakeIo({ home, userHome, cwd: dir, resolvers: fake.resolvers, harnesses: [tiny] });
      await expectExit(runSync({ ...SYNC, json: true }, io), ExitCode.RuleCapExceeded);
      const document = JSON.parse(io.out.join(""));
      const reasons = document.report.notices.filter((line: string) => line.includes(" would be "));
      expect(reasons).toHaveLength(1);
      expect(readFileSync(shared, "utf8")).toContain("One.");
      expect(existsSync(storePathFor(home, from))).toBe(false);
    });
  });

  test("copy mode leaves a user's own file where a body would go, with a notice", async () => {
    await world(async ({ home, dir, userHome, project }) => {
      const source = writeSource(join(dir, "src"), TWO_MEMORIES);
      const entry = entryFor(localFrom(source), { destination: { scope: "project" }, copy: true });
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
      const entry = fetchedEntry(from, facts, { destination: { scope: "project" }, rename });
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
      const entry = fetchedEntry(from, facts, { destination: { scope: "project" }, rename });
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
        destination: { scope: "project" },
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
            ...entryFor(localFrom(rival), { destination: { scope: "project" } }),
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
      const projectScope = { destination: { scope: "project" as const } };
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
        const noRules = { destination: { scope: "project" as const }, rule: false, copy };
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
      const noRules = { destination: { scope: "project" as const }, rule: false, copy: true };
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
      const noRules = { destination: { scope: "project" as const }, rule: false, copy: true };
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
      const entry = entryFor(localFrom(source), { destination: { scope: "project" } });
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

describe("plan surfaces", () => {
  test("--dry-run prints the plan and touches nothing; --json is one value, also on a collision", async () => {
    await world(async ({ home, dir, userHome }) => {
      const source = writeSource(join(dir, "src"), TWO_MEMORIES);
      writeState(home, stateWith({ [source]: entryFor(localFrom(source)) }, ["claude-code"]));
      const before = treeDigest(dir);
      const io = fakeIo({ home, userHome, cwd: dir });
      const report = await runSync({ ...SYNC, dryRun: true }, io);
      expect(treeDigest(dir)).toBe(before);
      expect(existsSync(homePaths(home).lastSync)).toBe(false);
      expect(io.out.join("")).toBe(renderPlan(report.plan));
      const statePath = homePaths(home).state;
      expect(report.plan.changes.some((change) => change.path === statePath)).toBe(true);

      const json = fakeIo({ home, userHome, cwd: dir });
      await runSync({ ...SYNC, json: true }, json);
      const document = JSON.parse(json.out.join(""));
      expect(document.ok).toBe(true);
      expect(document.report.rules).toBe(2);
      expect(Array.isArray(document.plan.changes)).toBe(true);

      const twin = writeSource(join(dir, "twin"), { "always-review": { description: "Again." } });
      const later = { ...entryFor(localFrom(twin)), addedAt: "2026-08-02T00:00:00.000Z" };
      writeState(home, stateWith({ [source]: entryFor(localFrom(source)), [twin]: later }));
      const failing = fakeIo({ home, userHome, cwd: dir });
      await expectExit(runSync({ ...SYNC, json: true }, failing), ExitCode.NameCollision);
      const failure = JSON.parse(failing.out.join(""));
      expect(failure.ok).toBe(false);
      expect(failure.code).toBe(ExitCode.NameCollision);
    });
  });

  test("a read-only rules directory is exit 4 interactively and one loud line under --quiet", async () => {
    await world(async ({ home, dir, userHome }) => {
      const source = writeSource(join(dir, "src"), TWO_MEMORIES);
      writeState(home, stateWith({ [source]: entryFor(localFrom(source)) }));
      const rules = join(userHome, ".fixture", "rules");
      mkdirSync(rules);
      chmodSync(rules, 0o500);
      try {
        const io = fakeIo({ home, userHome, cwd: dir });
        await expectExit(runSync(SYNC, io), ExitCode.DestinationWriteFailed);
        const quiet = fakeIo({ home, userHome, cwd: dir, now: new Date(NOW.getTime() + 120_000) });
        await runSync(QUIET, quiet);
        expect(quiet.out.join("")).toMatch(
          /^maxims: cannot write .*maxims-local-src--[0-9a-f]+\.md: .*\n$/,
        );
      } finally {
        chmodSync(rules, 0o700);
      }
    });
  });

  test("a forced refresh fetches whatever -a limits the run to, a due one does not, and only names who", async () => {
    await world(async ({ home, dir, userHome }) => {
      const rules = writeSource(join(dir, "rules"), TWO_MEMORIES);
      const other = writeSource(join(dir, "other"), { solo: { description: "Solo." } });
      const rulesFrom = githubFrom("acme/rules");
      const otherFrom = githubFrom("acme/other");
      seedStore(home, rulesFrom, rules);
      seedStore(home, otherFrom, other);
      writeState(
        home,
        stateWith({
          "@acme/rules": fetchedEntry(rulesFrom, await fetchedFacts(rules, daysAgo(NOW, 9))),
          "@acme/other": fetchedEntry(otherFrom, await fetchedFacts(other, daysAgo(NOW, 9))),
        }),
      );
      const fake = fakeResolvers();
      fake.set(rulesFrom, { kind: "dir", dir: rules });
      fake.set(otherFrom, { kind: "dir", dir: other });
      const io = fakeIo({ home, userHome, cwd: dir, resolvers: fake.resolvers });
      await runSync({ ...SYNC, fetch: "due", agents: ["claude-code"] }, io);
      expect(fake.calls).toEqual([]);
      await runSync({ ...SYNC, fetch: "force", agents: ["claude-code"] }, io);
      expect(fake.calls).toEqual(["resolveRef @acme/other", "resolveRef @acme/rules"]);
      fake.calls.length = 0;
      writeFileSync(
        join(rules, "memories", "new-rule.md"),
        memoryFile("new-rule", { description: "New." }),
      );
      const report = await runSync({ ...SYNC, fetch: "force", only: ["@acme/rules"] }, io);
      expect(fake.calls).toEqual(["resolveRef @acme/rules", "fetch @acme/rules"]);
      expect(report.fetched).toEqual(["@acme/rules"]);
      expect(report.upstreamChanges).toEqual({ "@acme/rules": ["+ new-rule"] });
    });
  });

  test("a source a filtered forced refresh swapped is rewritten for the harnesses outside the filter", async () => {
    await world(async ({ home, dir, userHome }) => {
      const upstream = writeSource(join(dir, "upstream"), TWO_MEMORIES);
      const from = githubFrom("acme/rules");
      seedStore(home, from, upstream);
      const facts = await fetchedFacts(upstream, daysAgo(NOW, 1));
      const entry = fetchedEntry(from, facts, { harnesses: ["claude-code", "codex"] });
      writeState(home, stateWith({ "@acme/rules": entry }));
      const fake = fakeResolvers();
      fake.set(from, { kind: "dir", dir: upstream });
      const io = fakeIo({ home, userHome, cwd: dir, resolvers: fake.resolvers });
      await runSync(SYNC, io);
      const shared = join(userHome, ".fixture", "FIXTURE.md");
      expect(readFileSync(shared, "utf8")).toContain("Never merge red.");
      rmSync(join(upstream, "memories", "keep-tests-green.md"));
      await runSync({ ...SYNC, fetch: "force", agents: ["claude-code"] }, io);
      expect(existsSync(join(storePathFor(home, from), "memories", "keep-tests-green.md"))).toBe(
        false,
      );
      expect(readFileSync(shared, "utf8")).not.toContain("Never merge red.");
      expect(readFileSync(globalRulesFile(userHome, "acme-rules"), "utf8")).not.toContain(
        "Never merge red.",
      );
    });
  });

  test("a filtered run keeps the block a source holds in a rendered shared file through a harness outside the filter", async () => {
    await world(async ({ home, dir, userHome, project }) => {
      const first = writeSource(join(dir, "first"), { alpha: { description: "Alpha." } });
      const second = writeSource(join(dir, "second"), { beta: { description: "Beta." } });
      writeState(
        home,
        stateWith({
          [first]: entryFor(localFrom(first, true), {
            destination: { scope: "project" },
            harnesses: ["codex"],
          }),
          [second]: entryFor(localFrom(second), {
            destination: { scope: "project" },
            harnesses: ["dsh"],
          }),
        }),
      );
      const io = fakeIo({
        home,
        userHome,
        cwd: project,
        harnesses: [sharedBlockHarness, budgetedReader(1 << 20)],
      });
      await runSync(SYNC, io);
      const shared = join(project, "FIXTURE.md");
      const before = readFileSync(shared, "utf8");
      expect(before).toContain("Beta.");
      writeFileSync(
        join(first, "memories", "alpha.md"),
        memoryFile("alpha", { description: "Alpha, changed." }),
      );
      await runSync({ ...SYNC, fetch: "none", agents: ["codex"] }, io);
      const after = readFileSync(shared, "utf8");
      expect(after).toContain("Alpha, changed.");
      expect(after).toContain("Beta.");
      expect(parseBlocks(after).blocks.map((block) => block.source)).toEqual(
        parseBlocks(before).blocks.map((block) => block.source),
      );
      // The file a filtered run visits only to strip a departed source's block keeps the blocks
      // of the sources it still holds through harnesses outside the filter.
      writeState(
        home,
        stateWith({
          [second]: entryFor(localFrom(second), {
            destination: { scope: "project" },
            harnesses: ["dsh"],
          }),
        }),
      );
      await runSync({ ...SYNC, fetch: "none", agents: ["codex"] }, io);
      const stripped = readFileSync(shared, "utf8");
      expect(stripped).not.toContain("Alpha");
      expect(stripped).toContain("Beta.");
    });
  });

  test("a widened filter keeps the sibling blocks of a shared file and never fails a harness the user did not name", async () => {
    await world(async ({ home, dir, userHome, project }) => {
      const first = writeSource(join(dir, "first"), { alpha: { description: "Alpha." } });
      const second = writeSource(join(dir, "second"), { beta: { description: "Beta." } });
      const firstFrom = githubFrom("acme/first");
      seedStore(home, firstFrom, first);
      writeState(
        home,
        stateWith({
          "@acme/first": fetchedEntry(firstFrom, await fetchedFacts(first, daysAgo(NOW, 1)), {
            destination: { scope: "project" },
            harnesses: ["claude-code", "codex"],
          }),
          [second]: entryFor(localFrom(second), {
            destination: { scope: "project" },
            harnesses: ["codex"],
          }),
        }),
      );
      const fake = fakeResolvers();
      fake.set(firstFrom, { kind: "dir", dir: first });
      const io = fakeIo({ home, userHome, cwd: project, resolvers: fake.resolvers });
      await runSync(SYNC, io);
      const shared = join(project, "FIXTURE.md");
      expect(readFileSync(shared, "utf8")).toContain("Beta.");
      writeFileSync(
        join(first, "memories", "alpha.md"),
        memoryFile("alpha", { description: "Alpha, changed." }),
      );
      const filtered: SyncOptions = { ...SYNC, fetch: "force", agents: ["claude-code"] };
      await runSync({ ...filtered, only: ["@acme/first"] }, io);
      const text = readFileSync(shared, "utf8");
      expect(text).toContain("Alpha, changed.");
      expect(text).toContain("Beta.");
      // The harness the widening brought in is skipped when it has no home, where the one the user
      // named would stop the run.
      rmSync(join(project, ".fixture"), { recursive: true });
      writeFileSync(
        join(first, "memories", "alpha.md"),
        memoryFile("alpha", { description: "Alpha, changed twice." }),
      );
      const widened = await runSync({ ...SYNC, fetch: "force", agents: ["codex"] }, io);
      expect(widened.notices).toContain(
        `maxims: @acme/first: skipped claude-code (Fixture Rules: ${join(project, ".fixture")} does not exist)`,
      );
      writeFileSync(
        join(first, "memories", "alpha.md"),
        memoryFile("alpha", { description: "Alpha, changed thrice." }),
      );
      await expectExit(runSync(filtered, io), ExitCode.DestinationWriteFailed);
    });
  });

  test("a dry run with a preview plans from the handed state, config and store writes, touching nothing", async () => {
    await world(async ({ home, dir, userHome }) => {
      const source = writeSource(join(dir, "src"), TWO_MEMORIES);
      const from: LocalSourceFrom = { type: "local", path: source };
      const scope = { memoryPath: "memories", fullDepth: false };
      const tree = await readMemoryTree(source, scope, () => undefined);
      const state = stateWith({ [source]: entryFor(from) });
      const changes = materializeLocal(from, home, tree.files);
      const before = treeDigest(dir);
      const io = fakeIo({ home, userHome, cwd: dir });
      const report = await runSync(
        { ...SYNC, dryRun: true, fetch: "none", preview: { state, config: {}, changes } },
        io,
      );
      expect(report.rules).toBe(2);
      const rulesFile = globalRulesFile(userHome, sourceSlug(from));
      expect(report.plan.changes.some((change) => change.path === rulesFile)).toBe(true);
      expect(treeDigest(dir)).toBe(before);
      expect(existsSync(storePathFor(home, from))).toBe(false);
      expect(existsSync(homePaths(home).state)).toBe(false);
      const capped = fakeIo({ home, userHome, cwd: dir });
      await expectExit(
        runSync(
          {
            ...SYNC,
            dryRun: true,
            fetch: "none",
            preview: { state, config: { ruleCap: 1 }, changes },
          },
          capped,
        ),
        ExitCode.RuleCapExceeded,
      );
    });
  });

  test("a sync handed a retired entry sweeps the -o folder it left behind", async () => {
    await world(async ({ home, dir, userHome }) => {
      const team = writeSource(join(dir, "team"), { "team-rule": { description: "Team." } });
      const one = join(dir, "one");
      const two = join(dir, "two");
      mkdirSync(one);
      mkdirSync(two);
      const from = githubFrom("acme/team");
      const at = (path: string) =>
        fetchedEntry(from, facts, { destination: { scope: "out", path } });
      const facts = await fetchedFacts(team, daysAgo(NOW, 1));
      seedStore(home, from, team);
      writeState(home, stateWith({ "@acme/team": at(one) }));
      const io = fakeIo({ home, userHome, cwd: dir });
      await runSync({ ...SYNC, fetch: "none" }, io);
      expect(existsSync(join(one, "maxims-acme-team.md"))).toBe(true);
      writeState(home, stateWith({ "@acme/team": at(two) }));
      await runSync({ ...SYNC, fetch: "none", retired: [at(one)] }, io);
      expect(existsSync(join(one, "maxims-acme-team.md"))).toBe(false);
      expect(
        lstatSync(join(one, "memories", "team-rule.md"), { throwIfNoEntry: false }),
      ).toBeUndefined();
      expect(existsSync(join(two, "maxims-acme-team.md"))).toBe(true);
      // The retired folder may be the new destination's own rules directory, where the rule file
      // this run writes has the same name: it is kept.
      const rulesDir = join(userHome, ".fixture", "rules");
      const local = writeSource(join(dir, "local"), TWO_MEMORIES);
      const outEntry = entryFor(localFrom(local), {
        destination: { scope: "out", path: rulesDir },
      });
      seedStore(home, localFrom(local), local);
      writeState(home, stateWith({ [local]: outEntry }));
      await runSync({ ...SYNC, fetch: "none" }, io);
      const file = join(rulesDir, `maxims-${sourceSlug(localFrom(local))}.md`);
      expect(existsSync(file)).toBe(true);
      writeState(home, stateWith({ [local]: entryFor(localFrom(local)) }));
      await runSync({ ...SYNC, fetch: "none", retired: [outEntry] }, io);
      expect(existsSync(file)).toBe(true);
      expect(readFileSync(file, "utf8")).toContain("Never merge red.");
    });
  });

  test("a forced refresh that fails keeps last-good and reports the source as failed", async () => {
    await world(async ({ home, dir, userHome }) => {
      const upstream = writeSource(join(dir, "upstream"), TWO_MEMORIES);
      const from = githubFrom("acme/rules");
      seedStore(home, from, upstream);
      const facts = await fetchedFacts(upstream, daysAgo(NOW, 1));
      writeState(home, stateWith({ "@acme/rules": fetchedEntry(from, facts) }));
      const fake = fakeResolvers();
      fake.set(from, { kind: "fail", failure: "network" });
      const io = fakeIo({ home, userHome, cwd: dir, resolvers: fake.resolvers });
      const report = await runSync({ ...SYNC, fetch: "force" }, io);
      expect(report.failed).toEqual([
        { key: "@acme/rules", message: "scripted network", kind: "network" },
      ]);
      const text = readFileSync(globalRulesFile(userHome, "acme-rules"), "utf8");
      expect(text).toContain("Never merge red.");
      expect(fetchedOf(home, "@acme/rules")?.lastError?.kind).toBe("network");
    });
  });
});

describe("shared file byte budget", () => {
  test("the budget is judged on the finished file, not on the text between two block replacements", async () => {
    await world(async ({ home, dir, userHome }) => {
      const rule = (prefix: string, count: number) =>
        Object.fromEntries(
          Array.from({ length: count }, (_, index) => [
            `${prefix}-rule-${index}`,
            { description: `Rule ${index} of ${prefix}.` },
          ]),
        );
      // Names of one length on both sides, so the finished file is as long as the first one.
      const first = join(dir, "alpha");
      const second = join(dir, "bravo");
      writeSource(first, rule("alpha", 2));
      writeSource(second, rule("bravo", 6));
      const codexOnly = { harnesses: ["codex" as const] };
      writeState(
        home,
        stateWith({
          [first]: entryFor(localFrom(first, true), codexOnly),
          [second]: entryFor(localFrom(second, true), codexOnly),
        }),
      );
      const shared = join(userHome, ".fixture", "FIXTURE.md");
      const unbudgeted = fakeIo({ home, userHome, cwd: dir, harnesses: [sharedBlockHarness] });
      await runSync({ ...SYNC, fetch: "none" }, unbudgeted);
      const size = statSync(shared).size;
      // Eight rule lines fit with one line to spare; the first block growing to six before the
      // second shrinks to two would pass through twelve.
      const budgeted: HarnessDefinition = { ...sharedBlockHarness, byteBudget: size + 40 };
      rmSync(join(first, "memories"), { recursive: true });
      rmSync(join(second, "memories"), { recursive: true });
      writeSource(first, rule("alpha", 6));
      writeSource(second, rule("bravo", 2));
      const io = fakeIo({ home, userHome, cwd: dir, harnesses: [budgeted] });
      const report = await runSync({ ...SYNC, fetch: "none" }, io);
      expect(report.rules).toBe(8);
      expect(statSync(shared).size).toBe(size);
      const text = readFileSync(shared, "utf8");
      expect(parseBlocks(text).blocks).toHaveLength(2);
      expect(text.match(/alpha-rule-\d/g)).toHaveLength(6);
      expect(text.match(/bravo-rule-\d/g)).toHaveLength(2);
    });
  });

  // A harness may refuse to read its own config when probed for the tier it reaches (Codex on a
  // config.toml that does not parse). The probe decides only the self-refresh line, so a run that
  // renders no stale block never asks: a kept block of a vanished source plans without it.
  test("the tier probe runs only for a file with a stale block", async () => {
    await world(async ({ home, dir, userHome }) => {
      const probing: HarnessDefinition = {
        ...sharedBlockHarness,
        achievedTier: () => Promise.reject(new Error("probed the config")),
      };
      const live = writeSource(join(dir, "live"), TWO_MEMORIES);
      writeState(
        home,
        stateWith({ [live]: entryFor(localFrom(live, true), { harnesses: ["codex"] }) }),
      );
      const io = fakeIo({ home, userHome, cwd: dir, harnesses: [probing] });
      const shared = join(userHome, ".fixture", "FIXTURE.md");
      await runSync(SYNC, io);
      const before = readFileSync(shared, "utf8");
      rmSync(live, { recursive: true });
      const report = await runSync(SYNC, io);
      expect(report.failed.map((failure) => failure.key)).toEqual([live]);
      expect(readFileSync(shared, "utf8")).toBe(before);
      const upstream = writeSource(join(dir, "upstream"), TWO_MEMORIES);
      const from = githubFrom("acme/rules");
      seedStore(home, from, upstream);
      const facts = await fetchedFacts(upstream, daysAgo(NOW, 40));
      writeState(
        home,
        stateWith({ "@acme/rules": fetchedEntry(from, facts, { harnesses: ["codex"] }) }),
      );
      const fake = fakeResolvers();
      fake.set(from, { kind: "fail", failure: "network" });
      const stale = fakeIo({
        home,
        userHome,
        cwd: dir,
        harnesses: [probing],
        resolvers: fake.resolvers,
      });
      await expect(runSync(SYNC, stale)).rejects.toThrow("probed the config");
    });
  });

  // An unreadable source keeps its block in the shared file, and the harness that loads the file
  // through that source keeps loading it, so the finished file answers to that reader's budget.
  test("a grown shared file is judged against the budget of a reader only an emptied source brings", async () => {
    await world(async ({ home, dir, userHome, project }) => {
      const codexSource = writeSource(join(dir, "codex-src"), { alpha: { description: "Alpha." } });
      const dshSource = writeSource(join(dir, "dsh-src"), { beta: { description: "Beta." } });
      const projectScoped = (harness: HarnessId) => ({
        destination: { scope: "project" as const },
        harnesses: [harness],
      });
      const codexEntry = entryFor(localFrom(codexSource, true), projectScoped("codex"));
      const dshEntry = entryFor(localFrom(dshSource, true), projectScoped("dsh"));
      writeState(home, stateWith({ [codexSource]: codexEntry, [dshSource]: dshEntry }));
      const shared = join(project, "FIXTURE.md");
      const roomy = fakeIo({
        home,
        userHome,
        cwd: project,
        harnesses: [sharedBlockHarness, budgetedReader(1 << 20)],
      });
      await runSync(SYNC, roomy);
      const before = readFileSync(shared, "utf8");
      expect(before).toContain("Beta.");
      rmSync(join(dshSource, "memories", "beta.md"));
      const grown = memoryFile("alpha-two", { description: "Alpha, grown past the budget." });
      writeFileSync(join(codexSource, "memories", "alpha-two.md"), grown);
      const limit = Buffer.byteLength(before) + 16;
      const io = fakeIo({
        home,
        userHome,
        cwd: project,
        harnesses: [sharedBlockHarness, budgetedReader(limit)],
      });
      const error = await expectExit(runSync(SYNC, io), ExitCode.RuleCapExceeded);
      expect(error.message).toContain(`${shared} would be`);
      expect(error.message).toContain(`over the ${limit}-byte limit Fixture Budgeted loads`);
      expect(readFileSync(shared, "utf8")).toBe(before);
      // The control: the same growth with no source bringing the budgeted reader is written.
      writeState(home, stateWith({ [codexSource]: codexEntry }));
      const report = await runSync(SYNC, io);
      expect(report.rules).toBe(2);
      expect(readFileSync(shared, "utf8")).toContain("Alpha, grown past the budget.");
    });
  });
});
