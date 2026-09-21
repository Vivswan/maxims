// What would drift silently: a `--dry-run` that touches disk, a `--json` run whose stdout is not one
// value even on a failure, a filtered run that fails a harness the user did not name, and a shared
// file over a byte budget that refuses every source in it instead of holding the newest.
import { describe, expect, test } from "bun:test";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  rmSync,
  statSync,
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
  type IntentOverrides,
  localFrom,
  memoryFile,
  readStateFile,
  seedStore,
  sharedBlockHarness,
  stateWith,
  treeDigest,
  writeSource,
  writeState,
} from "../../tests/engine/harness.ts";
import { expectExit, globalRulesFile, TWO_MEMORIES, world } from "../../tests/engine/world.ts";
import { CHMOD_DENIES } from "../../tests/shared/platform.ts";
import {
  budgetedReader,
  fetchedOf,
  heldHint,
  NOW,
  QUIET,
  SYNC,
} from "../../tests/shared/sync_support.ts";
import type { HarnessDefinition, HarnessId } from "../harnesses/contract.ts";
import { parseBlocks } from "../rulefile/block.ts";
import { type LocalSourceFrom, materializeLocal } from "../sources/local.ts";
import { readMemoryTree } from "../sources/tree.ts";
import type { SourceEntry } from "../state/schema.ts";
import { renderPlan } from "../util/change.ts";
import { ExitCode } from "../util/exit-codes.ts";
import { homePaths, storePathFor } from "../util/home.ts";
import { sourceSlug } from "./shared/slug.ts";
import { renderHookStdout } from "./shared/stdin.ts";
import { runSync } from "./sync.ts";
import type { SyncOptions } from "./types.ts";

function heldLines(key: string, over: number, path: string): string[] {
  return [`x  ${key} is ${over} bytes over the budget for ${path}`, `   ${heldHint(key)}`];
}

describe("plan surfaces", () => {
  test("--dry-run prints the plan and touches nothing; --json is one value, also on a collision", async () => {
    await world(async ({ home, dir, userHome }) => {
      const source = writeSource(join(dir, "src"), TWO_MEMORIES);
      writeState(
        home,
        stateWith({ [source]: entryFor(localFrom(source)) }, { global: ["claude-code"] }),
      );
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

  test.skipIf(!CHMOD_DENIES)(
    "a read-only rules directory is exit 4 interactively and one loud line under --quiet",
    async () => {
      await world(async ({ home, dir, userHome }) => {
        const source = writeSource(join(dir, "src"), TWO_MEMORIES);
        writeState(home, stateWith({ [source]: entryFor(localFrom(source)) }));
        const rules = join(userHome, ".fixture", "rules");
        mkdirSync(rules);
        chmodSync(rules, 0o500);
        try {
          const io = fakeIo({ home, userHome, cwd: dir });
          await expectExit(runSync(SYNC, io), ExitCode.DestinationWriteFailed);
          const quiet = fakeIo({
            home,
            userHome,
            cwd: dir,
            now: new Date(NOW.getTime() + 120_000),
          });
          await runSync(QUIET, quiet);
          expect(quiet.out.join("")).toMatch(
            /^maxims: cannot write .*maxims-local-src--[0-9a-f]+\.md: .*\n$/,
          );
        } finally {
          chmodSync(rules, 0o700);
        }
      });
    },
  );

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
            destination: { scope: "project", root: project },
            harnesses: ["codex"],
          }),
          [second]: entryFor(localFrom(second), {
            destination: { scope: "project", root: project },
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
            destination: { scope: "project", root: project },
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
            destination: { scope: "project", root: project },
            harnesses: ["claude-code", "codex"],
          }),
          [second]: entryFor(localFrom(second), {
            destination: { scope: "project", root: project },
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

  test("a forced refresh that fails keeps last-good, reports the source as failed and never says up to date", async () => {
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
      io.out.length = 0;
      io.clock.now = new Date(NOW.getTime() + 1000);
      const again = await runSync({ ...SYNC, fetch: "force" }, io);
      expect(again.failed.map((failure) => failure.key)).toEqual(["@acme/rules"]);
      expect(again.changed.filter((path) => !path.startsWith(home))).toEqual([]);
      expect(io.out.join("")).toBe("");
    });
  });
});

// `count` rules of one shape; `edition` changes the text without changing its length.
function ruleSet(prefix: string, count: number, edition = "one") {
  return Object.fromEntries(
    Array.from({ length: count }, (_, index) => [
      `${prefix}-rule-${index}`,
      { description: `Rule ${index} of ${prefix}, edition ${edition}.` },
    ]),
  );
}

describe("shared file byte budget", () => {
  const shared = (userHome: string) => join(userHome, ".fixture", "FIXTURE.md");
  const day = (n: number) => `2026-08-0${n}T00:00:00.000Z`;
  const onDsh: IntentOverrides = { harnesses: ["dsh"] };
  const onCodex: IntentOverrides = { harnesses: ["codex"] };
  const dated = (path: string, addedAt: string, overrides = onDsh): SourceEntry => ({
    ...entryFor(localFrom(path), overrides),
    addedAt,
  });
  // Three two-rule sources whose keys sort in the order they are named.
  const threeSources = (dir: string) => ({
    alpha: writeSource(join(dir, "alpha"), ruleSet("alpha", 2)),
    bravo: writeSource(join(dir, "bravo"), ruleSet("bravo", 2)),
    charlie: writeSource(join(dir, "charlie"), ruleSet("charlie", 2)),
  });
  const withSources = (home: string, added: Record<string, SourceEntry>): void => {
    const state = readStateFile(home);
    writeState(home, { ...state, sources: { ...state.sources, ...added } });
  };
  const roomyIo = (w: { home: string; dir: string; userHome: string }) =>
    fakeIo({ ...w, cwd: w.dir, harnesses: [sharedBlockHarness, budgetedReader(1 << 20)] });
  const budgetedIo = (w: { home: string; dir: string; userHome: string }, budget: number) =>
    fakeIo({ ...w, cwd: w.dir, harnesses: [sharedBlockHarness, budgetedReader(budget)] });
  const blockKeys = (path: string) =>
    parseBlocks(readFileSync(path, "utf8")).blocks.map((block) => block.source);
  const blockOf = (text: string, key: string): string => {
    const span = parseBlocks(text).blocks.find((block) => block.source === key);
    return span === undefined ? "" : text.slice(span.start, span.end);
  };
  const holdLines = (notices: string[]) =>
    notices.filter((line) => line.startsWith("x  ") || line.startsWith("   narrow"));

  test("the budget is judged on the finished file, not on the text between two block replacements", async () => {
    await world(async ({ home, dir, userHome }) => {
      const rule = ruleSet;
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
        destination: { scope: "project" as const, root: project },
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
      expect(error.message).toStartWith(`${codexSource} is `);
      expect(error.message).toEndWith(` bytes over the budget for ${shared}`);
      expect(readFileSync(shared, "utf8")).toBe(before);
      // The control: the same growth with no source bringing the budgeted reader is written.
      writeState(home, stateWith({ [codexSource]: codexEntry }));
      const report = await runSync(SYNC, io);
      expect(report.rules).toBe(2);
      expect(readFileSync(shared, "utf8")).toContain("Alpha, grown past the budget.");
    });
  });

  // Which source is held: the one installed last by `addedAt` as an instant, whatever its key
  // sorts as, and on a tie the later key, so two machines holding the same file hold the same
  // source. The instant matters: `...00Z` and `...00.001Z` are both valid, and the string order
  // between them is not the time order.
  const winners = [
    {
      name: "the source installed last, although its key sorts first",
      addedAt: { alpha: day(3), bravo: day(1), charlie: day(2) },
      held: "alpha",
    },
    {
      name: "the later key when two sources were installed at the same moment",
      addedAt: { alpha: day(1), bravo: day(2), charlie: day(2) },
      held: "charlie",
    },
    {
      name: "the later instant when the timestamps differ in precision",
      addedAt: {
        alpha: "2026-08-01T00:00:00Z",
        bravo: "2026-08-01T00:00:00.001Z",
        charlie: day(1),
      },
      held: "bravo",
    },
  ] as const;
  for (const winner of winners) {
    test(`over the budget, one source is held and named with its overage: ${winner.name}`, async () => {
      await world(async (w) => {
        const paths = threeSources(w.dir);
        const held = paths[winner.held];
        const others = (["alpha", "bravo", "charlie"] as const).filter((n) => n !== winner.held);
        const file = shared(w.userHome);
        writeState(
          w.home,
          stateWith(
            Object.fromEntries(others.map((n) => [paths[n], dated(paths[n], winner.addedAt[n])])),
          ),
        );
        const roomy = roomyIo(w);
        await runSync(SYNC, roomy);
        const fits = statSync(file).size;
        withSources(w.home, { [held]: dated(held, winner.addedAt[winner.held]) });
        const io = budgetedIo(w, fits);
        await expectExit(runSync({ ...SYNC, json: true }, io), ExitCode.RuleCapExceeded);
        const document = JSON.parse(io.out.join(""));
        expect(blockKeys(file)).toEqual(others.map((n) => paths[n]));
        expect(readFileSync(file, "utf8")).not.toContain(`of ${winner.held},`);
        const store = storePathFor(w.home, localFrom(held));
        expect(existsSync(store)).toBe(false);
        const changes: { path: string }[] = document.plan.changes;
        expect(changes.filter((change) => change.path.startsWith(store))).toEqual([]);
        // The same pick on the next run, before the roomy reader measures the overage: the text
        // that failed is the file it then writes.
        const again = await expectExit(runSync(SYNC, io), ExitCode.RuleCapExceeded);
        await runSync(SYNC, roomy);
        const over = statSync(file).size - fits;
        expect(over).toBeGreaterThan(0);
        expect(document.code).toBe(ExitCode.RuleCapExceeded);
        expect(document.message).toBe(`${held} is ${over} bytes over the budget for ${file}`);
        expect(again.message).toBe(document.message);
        expect(document.hint).toBe(heldHint(held));
        expect(holdLines(document.report.notices)).toEqual(heldLines(held, over, file));
      });
    });
  }

  test("a held source that already had a block keeps it byte-identical while the others refresh", async () => {
    await world(async (w) => {
      const { alpha, bravo, charlie } = threeSources(w.dir);
      const file = shared(w.userHome);
      writeState(
        w.home,
        stateWith({
          [alpha]: dated(alpha, day(1)),
          [bravo]: dated(bravo, day(2)),
          [charlie]: dated(charlie, day(3)),
        }),
      );
      await runSync(SYNC, roomyIo(w));
      const before = readFileSync(file, "utf8");
      for (const [path, name, count] of [
        [alpha, "alpha", 2],
        [bravo, "bravo", 2],
        [charlie, "charlie", 4],
      ] as const) {
        rmSync(join(path, "memories"), { recursive: true });
        writeSource(path, ruleSet(name, count, "two"));
      }
      const io = budgetedIo(w, Buffer.byteLength(before));
      const error = await expectExit(
        runSync({ ...SYNC, fetch: "force" }, io),
        ExitCode.RuleCapExceeded,
      );
      expect(error.message).toStartWith(`${charlie} is `);
      const after = readFileSync(file, "utf8");
      expect(blockOf(after, charlie)).toBe(blockOf(before, charlie));
      expect(blockOf(after, alpha)).toContain("of alpha, edition two.");
      expect(blockOf(after, bravo)).toContain("of bravo, edition two.");
      expect(Buffer.byteLength(after)).toBe(Buffer.byteLength(before));
    });
  });

  test("sources are held newest first, one at a time, until the file fits", async () => {
    await world(async (w) => {
      const { alpha, bravo, charlie } = threeSources(w.dir);
      const file = shared(w.userHome);
      writeState(w.home, stateWith({ [alpha]: dated(alpha, day(1)) }));
      const roomy = roomyIo(w);
      await runSync(SYNC, roomy);
      const fits = statSync(file).size;
      withSources(w.home, { [bravo]: dated(bravo, day(2)), [charlie]: dated(charlie, day(3)) });
      const io = budgetedIo(w, fits);
      await expectExit(runSync({ ...SYNC, json: true }, io), ExitCode.RuleCapExceeded);
      const document = JSON.parse(io.out.join(""));
      expect(blockKeys(file)).toEqual([alpha]);
      for (const key of [bravo, charlie]) {
        expect(existsSync(storePathFor(w.home, localFrom(key)))).toBe(false);
      }
      // Each hold's overage is the finished text before it; the roomy reader grows the file back
      // block by block in the same order.
      writeState(
        w.home,
        stateWith({ [alpha]: dated(alpha, day(1)), [bravo]: dated(bravo, day(2)) }),
      );
      await runSync(SYNC, roomy);
      const withBravo = statSync(file).size;
      withSources(w.home, { [charlie]: dated(charlie, day(3)) });
      await runSync(SYNC, roomy);
      const withCharlie = statSync(file).size;
      expect(document.message).toBe(
        `${charlie} is ${withCharlie - fits} bytes over the budget for ${file}`,
      );
      expect(holdLines(document.report.notices)).toEqual([
        ...heldLines(charlie, withCharlie - fits, file),
        ...heldLines(bravo, withBravo - fits, file),
      ]);
    });
  });

  test("a reader only the held source brings still judges the finished file", async () => {
    await world(async (w) => {
      const { alpha, bravo, charlie } = threeSources(w.dir);
      const file = shared(w.userHome);
      writeState(w.home, stateWith({ [alpha]: dated(alpha, day(1), onCodex) }));
      await runSync(SYNC, roomyIo(w));
      const fits = statSync(file).size;
      withSources(w.home, {
        [bravo]: dated(bravo, day(2), onCodex),
        [charlie]: dated(charlie, day(3), onDsh),
      });
      const io = budgetedIo(w, fits);
      await expectExit(runSync({ ...SYNC, json: true }, io), ExitCode.RuleCapExceeded);
      const document = JSON.parse(io.out.join(""));
      const heldKeys = holdLines(document.report.notices)
        .filter((line) => line.startsWith("x  "))
        .map((line) => line.slice("x  ".length, line.indexOf(" is ")));
      expect(heldKeys).toEqual([charlie, bravo]);
      expect(blockKeys(file)).toEqual([alpha]);
      // The control: the same two codex sources with no dsh reader in the file are written.
      writeState(
        w.home,
        stateWith({
          [alpha]: dated(alpha, day(1), onCodex),
          [bravo]: dated(bravo, day(2), onCodex),
        }),
      );
      await runSync(SYNC, io);
      expect(blockKeys(file)).toEqual([alpha, bravo]);
    });
  });

  test("an -o rule file answers to no harness budget", async () => {
    await world(async (w) => {
      const source = writeSource(join(w.dir, "src"), ruleSet("out", 4));
      const out = join(w.dir, "out");
      const entry = entryFor(localFrom(source), { destination: { scope: "out", path: out } });
      writeState(w.home, stateWith({ [source]: entry }));
      const report = await runSync(SYNC, budgetedIo(w, 64));
      const file = join(out, `maxims-${sourceSlug(localFrom(source))}.md`);
      expect(report.rules).toBe(4);
      expect(statSync(file).size).toBeGreaterThan(64);
      expect(blockKeys(file)).toEqual([source]);
      expect(holdLines(report.notices)).toEqual([]);
    });
  });

  // A fresh refresh refused for the budget is planned again from last-good, which the user's own
  // text can push over the same budget; the two refusals say the same thing, and it is said once.
  test("a source held fresh and again from last-good says its hold once", async () => {
    await world(async (w) => {
      const alpha = writeSource(join(w.dir, "alpha"), ruleSet("alpha", 2));
      const file = shared(w.userHome);
      writeState(w.home, stateWith({ [alpha]: dated(alpha, day(1)) }));
      await runSync(SYNC, roomyIo(w));
      const fits = statSync(file).size;
      rmSync(join(alpha, "memories"), { recursive: true });
      writeSource(alpha, ruleSet("alpha", 2, "two"));
      const mine = "Notes of my own.\n";
      writeFileSync(file, `${mine}${readFileSync(file, "utf8")}`);
      const io = budgetedIo(w, fits);
      await expectExit(
        runSync({ ...SYNC, fetch: "force", json: true }, io),
        ExitCode.RuleCapExceeded,
      );
      const document = JSON.parse(io.out.join(""));
      expect(holdLines(document.report.notices)).toEqual(heldLines(alpha, mine.length, file));
      expect(readFileSync(file, "utf8")).toContain("of alpha, edition one.");
    });
  });

  test("under --quiet the hold is said on the hook's stdout and the run exits clean", async () => {
    await world(async (w) => {
      const { alpha, bravo, charlie } = threeSources(w.dir);
      const file = shared(w.userHome);
      writeState(
        w.home,
        stateWith({ [alpha]: dated(alpha, day(1)), [bravo]: dated(bravo, day(2)) }),
      );
      const roomy = roomyIo(w);
      await runSync(SYNC, roomy);
      const fits = statSync(file).size;
      withSources(w.home, { [charlie]: dated(charlie, day(3)) });
      const io = budgetedIo(w, fits);
      io.clock.now = new Date(NOW.getTime() + 5 * 60 * 1000);
      const report = await runSync(QUIET, io);
      expect(blockKeys(file)).toEqual([alpha, bravo]);
      await runSync(SYNC, roomy);
      const lines = heldLines(charlie, statSync(file).size - fits, file);
      expect(io.out.join("")).toBe(renderHookStdout("plain", lines));
      expect(holdLines(report.notices)).toEqual(lines);
      const log = readFileSync(homePaths(w.home).log, "utf8");
      for (const line of lines) expect(log).toContain(`sync --quiet: ${line}`);
    });
  });
});
