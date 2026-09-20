// What would drift silently: a hook run that exits non-zero or blocks, a fetch failure that empties
// a rule file instead of keeping last-good, a 404 that goes unreported or a 403 that nags before
// its time, a staleness line rendered for a source that merely has not been fetched lately, a
// second hook inside the debounce window doing work, a hook speaking plain text into a JSON-only
// harness, a hook deleting files on a partial read, and a corrupt state file emptying a machine.
import { describe, expect, test } from "bun:test";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
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
  localFrom,
  readStateFile,
  rulesDirHarness,
  seedStore,
  stateWith,
  writeSource,
  writeState,
} from "../../tests/engine/harness.ts";
import { expectExit, globalRulesFile, TWO_MEMORIES, world } from "../../tests/engine/world.ts";
import type { HarnessDefinition } from "../harnesses/contract.ts";
import { HARNESSES } from "../harnesses/registry.ts";
import { parseBlocks } from "../rulefile/block.ts";
import type { LastError } from "../state/schema.ts";
import { withStateLock } from "../state/store.ts";
import { ExitCode } from "../util/exit-codes.ts";
import { homePaths, storePathFor } from "../util/home.ts";
import { runList } from "./list.ts";
import { sourceSlug } from "./shared/slug.ts";
import { classifyInvoker, renderHookStdout } from "./shared/stdin.ts";
import { runSync } from "./sync.ts";
import type { SyncOptions } from "./types.ts";

const SYNC: SyncOptions = {
  quiet: false,
  dryRun: false,
  json: false,
  noFetch: false,
  force: false,
};
const QUIET: SyncOptions = { ...SYNC, quiet: true };
const NOW = new Date("2026-09-20T12:00:00.000Z");
const DAY_MS = 24 * 60 * 60 * 1000;
const FROM = githubFrom("acme/rules");
const KEY = "@acme/rules";

function logText(home: string): string {
  try {
    return readFileSync(homePaths(home).log, "utf8");
  } catch {
    return "";
  }
}

// A last-good install of `@acme/rules` fetched `ageDays` ago under a one-day cooldown, whose
// next fetch behaves as scripted.
async function lastGood(
  world: { home: string; dir: string; userHome: string },
  ageDays: number,
  lastError: LastError | null = null,
) {
  const upstream = writeSource(join(world.dir, "upstream"), TWO_MEMORIES);
  seedStore(world.home, FROM, upstream);
  const facts = await fetchedFacts(upstream, daysAgo(NOW, ageDays), lastError);
  writeState(world.home, stateWith({ [KEY]: fetchedEntry(FROM, facts) }, ["claude-code"]));
  writeFileSync(homePaths(world.home).config, JSON.stringify({ cooldownDays: 1 }));
  const fake = fakeResolvers();
  fake.set(FROM, { kind: "dir", dir: upstream });
  const io = fakeIo({ ...world, cwd: world.dir, resolvers: fake.resolvers });
  return { upstream, fake, io, rules: globalRulesFile(world.userHome, "acme-rules") };
}

describe("fail-soft rungs under --quiet", () => {
  // A gone repository is stale at once, so its block gains the notice line the same run; the
  // transient kinds keep the file byte-identical until the seven-day threshold.
  const rungs: { kind: LastError["kind"]; stdout: RegExp | null; staleAtOnce: boolean }[] = [
    { kind: "network", stdout: null, staleAtOnce: false },
    { kind: "ratelimit", stdout: null, staleAtOnce: false },
    { kind: "auth", stdout: null, staleAtOnce: false },
    {
      kind: "missing",
      stdout:
        /^maxims: @acme\/rules offline, kept last-good from 2026-09-20 \(2 rules\); source repository gone or unreadable\nmaxims: rules refreshed \(1 file updated\)\n$/,
      staleAtOnce: true,
    },
  ];
  for (const rung of rungs) {
    test(`a ${rung.kind} failure keeps last-good, records lastError and exits clean`, async () => {
      await world(async (w) => {
        const { fake, io, rules } = await lastGood(w, 9);
        await runSync(SYNC, io);
        const before = readFileSync(rules, "utf8");
        fake.set(FROM, { kind: "fail", failure: rung.kind, retryAfterSeconds: 120 });
        io.clock.now = new Date(NOW.getTime() + 2 * DAY_MS);
        io.out.length = 0;
        const report = await runSync(QUIET, io);
        expect(report.plan.changes.map((change) => String(change.path))).toEqual(
          rung.staleAtOnce ? [rules, homePaths(w.home).state] : [homePaths(w.home).state],
        );
        const after = readFileSync(rules, "utf8");
        if (rung.staleAtOnce) {
          expect(after).toContain("have not refreshed since 2026-09-20T12:00:00.000Z");
          expect(after).toContain("- Never merge red.");
        } else {
          expect(after).toBe(before);
        }
        const written = JSON.parse(readFileSync(homePaths(w.home).state, "utf8"));
        expect(written.sources[KEY].fetched.lastError.kind).toBe(rung.kind);
        expect(written.sources[KEY].fetched.lastError.retryAfter).toBe(
          new Date(io.clock.now.getTime() + 120_000).toISOString(),
        );
        const stdout = io.out.join("");
        if (rung.stdout === null) expect(stdout).toBe("");
        else expect(stdout).toMatch(rung.stdout);
      });
    });
  }

  test("a fetch with zero valid memories keeps the block and says the layout changed", async () => {
    await world(async (w) => {
      const { fake, io, rules } = await lastGood(w, 9);
      await runSync(SYNC, io);
      const before = readFileSync(rules, "utf8");
      const broken = join(w.dir, "broken");
      mkdirSync(join(broken, "memories"), { recursive: true });
      writeFileSync(join(broken, "memories", "not-a-memory.md"), "no frontmatter\n");
      fake.set(FROM, { kind: "dir", dir: broken, sha: "c".repeat(40) });
      io.clock.now = new Date(NOW.getTime() + 2 * DAY_MS);
      io.out.length = 0;
      await runSync(QUIET, io);
      expect(readFileSync(rules, "utf8")).toBe(before);
      expect(io.out.join("")).toBe(
        `maxims: ${KEY}: no valid memories at memories (layout probably changed upstream); kept last-good\n`,
      );
      expect(existsSync(join(storePathFor(w.home, FROM), "memories", "always-review.md"))).toBe(
        true,
      );
    });
  });

  test("a commit id the state cannot record is a failed fetch that says so, never a crash", async () => {
    await world(async (w) => {
      const { fake, io, rules, upstream } = await lastGood(w, 9);
      await runSync(SYNC, io);
      const before = readFileSync(rules, "utf8");
      fake.set(FROM, { kind: "dir", dir: upstream, sha: `sha256:${"d".repeat(64)}` });
      io.clock.now = new Date(NOW.getTime() + 2 * DAY_MS);
      io.out.length = 0;
      await runSync(QUIET, io);
      expect(readFileSync(rules, "utf8")).toBe(before);
      expect(io.out.join("")).toBe(
        `maxims: ${KEY}: the source reported an unusable commit id "sha256:${"d".repeat(64)}"; kept last-good\n`,
      );
      const entry = readStateFile(w.home).sources[KEY];
      const lastError = entry !== undefined && "fetched" in entry ? entry.fetched?.lastError : null;
      expect(lastError?.kind).toBe("invalid");
    });
  });

  test("a defect thrown mid-run exits clean and leaves its stack in the log, nowhere else", async () => {
    await world(async (w) => {
      const { fake, io } = await lastGood(w, 9);
      fake.set(FROM, { kind: "throw", error: new Error("fixture defect") });
      const report = await runSync(QUIET, io);
      expect(report.plan.changes).toEqual([]);
      expect(io.out.join("")).toBe("");
      const log = logText(w.home);
      expect(log).toContain("sync --quiet: crashed");
      expect(log).toContain("fixture defect");
      expect(log).toMatch(/\n\s+at /);
    });
  });
});

describe("write failures under --quiet --json", () => {
  test("a destination that cannot be written is reported as a failure in the document", async () => {
    await world(async (w) => {
      const { io, rules } = await lastGood(w, 1);
      const dir = join(w.userHome, ".fixture", "rules");
      mkdirSync(dir);
      chmodSync(dir, 0o500);
      try {
        await runSync({ ...QUIET, json: true }, io);
        const document = JSON.parse(io.out.join(""));
        expect(document.ok).toBe(false);
        expect(document.code).toBe(ExitCode.DestinationWriteFailed);
        expect(existsSync(rules)).toBe(false);
      } finally {
        chmodSync(dir, 0o700);
      }
    });
  });
});

describe("bodies directories that cannot be listed", () => {
  test("an unlistable bodies directory stops the run instead of reading as empty", async () => {
    await world(async (w) => {
      const source = writeSource(join(w.dir, "live"), TWO_MEMORIES);
      writeState(
        w.home,
        stateWith({
          [source]: entryFor(localFrom(source, true), {
            destination: { scope: "project" },
            rule: false,
          }),
        }),
      );
      const io = fakeIo({ ...w, cwd: w.project });
      await runSync(SYNC, io);
      const bodies = join(w.project, ".agents", "memories");
      chmodSync(bodies, 0o311);
      try {
        const error = await expectExit(runSync(SYNC, io), ExitCode.DestinationWriteFailed);
        expect(error.message).toBe(
          `cannot list ${bodies}: EACCES: permission denied, scandir '${bodies}'`,
        );
      } finally {
        chmodSync(bodies, 0o755);
      }
    });
  });
});

describe("planning failures under --quiet --json", () => {
  test("an explicitly named harness with no config folder still yields one ok:false document", async () => {
    await world(async (w) => {
      rmSync(join(w.project, ".fixture"), { recursive: true });
      const { io, upstream } = await lastGood(w, 1);
      const facts = await fetchedFacts(upstream, daysAgo(NOW, 1));
      const entry = fetchedEntry(FROM, facts, { destination: { scope: "project" } });
      writeState(w.home, stateWith({ [KEY]: entry }));
      io.cwd = w.project;
      const report = await runSync({ ...QUIET, json: true, agents: ["claude-code"] }, io);
      const document = JSON.parse(io.out.join(""));
      expect(document.ok).toBe(false);
      expect(document.code).toBe(ExitCode.DestinationWriteFailed);
      expect(report.plan.changes).toEqual([]);
    });
  });
});

describe("native errors under --quiet --json", () => {
  test("a rule file that cannot be read yields one ok:false document and a logged stack", async () => {
    await world(async (w) => {
      const { io, rules } = await lastGood(w, 1);
      await runSync(SYNC, io);
      chmodSync(rules, 0o000);
      try {
        io.out.length = 0;
        io.clock.now = new Date(NOW.getTime() + 120_000);
        await runSync({ ...QUIET, json: true }, io);
        const document = JSON.parse(io.out.join(""));
        expect(document.ok).toBe(false);
        expect(document.message).toContain("EACCES");
        expect(logText(w.home)).toContain("sync --quiet: crashed");
      } finally {
        chmodSync(rules, 0o644);
      }
    });
  });
});

describe("staleness", () => {
  const cases: { ageDays: number; lastError: LastError | null; stale: boolean; loud: boolean }[] = [
    { ageDays: 6, lastError: null, stale: false, loud: false },
    { ageDays: 8, lastError: null, stale: false, loud: false },
    {
      ageDays: 6,
      lastError: { kind: "ratelimit", message: "429", at: NOW.toISOString() },
      stale: false,
      loud: false,
    },
    {
      ageDays: 8,
      lastError: { kind: "ratelimit", message: "429", at: NOW.toISOString() },
      stale: true,
      loud: true,
    },
    {
      ageDays: 1,
      lastError: { kind: "missing", message: "404", at: NOW.toISOString() },
      stale: true,
      loud: true,
    },
  ];
  for (const { ageDays, lastError, stale, loud } of cases) {
    test(`fetched ${ageDays}d ago with ${lastError?.kind ?? "no"} error: stale=${stale}`, async () => {
      await world(async (w) => {
        const { io, rules } = await lastGood(w, ageDays, lastError);
        const report = await runSync({ ...SYNC, noFetch: true }, io);
        const text = readFileSync(rules, "utf8");
        expect(text.includes("have not refreshed since")).toBe(stale);
        expect(text.includes("run `maxims sync --quiet` before continuing")).toBe(false);
        const loudLines = report.notices.filter((line) =>
          /offline|has not refreshed since/.test(line),
        );
        expect(loudLines.length).toBe(loud ? 1 : 0);
      });
    });
  }

  test("a tier-2 harness gets the self-refresh line once per file however many sources are stale", async () => {
    await world(async (w) => {
      const tierTwo: HarnessDefinition = { ...rulesDirHarness, tier: 2, hook: { kind: "none" } };
      const shared: HarnessDefinition = {
        ...rulesDirHarness,
        id: "codex",
        tier: 2,
        hook: { kind: "none" },
        targets: {
          project: { kind: "shared-block", file: "FIXTURE.md" },
          global: { kind: "shared-block", file: join(".fixture", "FIXTURE.md") },
        },
      };
      const entries: Record<string, ReturnType<typeof fetchedEntry>> = {};
      for (const name of ["a", "b", "c"]) {
        const from = githubFrom(`acme/${name}`);
        const upstream = writeSource(join(w.dir, name), {
          [`rule-${name}`]: { description: `Rule ${name}.` },
        });
        seedStore(w.home, from, upstream);
        const facts = await fetchedFacts(upstream, daysAgo(NOW, 9), {
          kind: "network",
          message: "down",
          at: NOW.toISOString(),
        });
        entries[`@acme/${name}`] = fetchedEntry(from, facts, {
          harnesses: ["claude-code", "codex"],
        });
      }
      writeState(w.home, stateWith(entries));
      const io = fakeIo({ ...w, cwd: w.dir, harnesses: [tierTwo, shared] });
      await runSync({ ...SYNC, noFetch: true }, io);
      const sharedText = readFileSync(join(w.userHome, ".fixture", "FIXTURE.md"), "utf8");
      expect(sharedText.split("run `maxims sync --quiet` before continuing").length - 1).toBe(1);
      expect(parseBlocks(sharedText).blocks).toHaveLength(3);
      for (const name of ["a", "b", "c"]) {
        const text = readFileSync(globalRulesFile(w.userHome, `acme-${name}`), "utf8");
        expect(text.split("run `maxims sync --quiet` before continuing").length - 1).toBe(1);
      }
    });
  });
});

describe("hook runs", () => {
  test("a second quiet run inside 60 seconds does no work; an interactive run between is not debounced", async () => {
    await world(async (w) => {
      const { io, rules } = await lastGood(w, 1);
      await runSync(QUIET, io);
      expect(existsSync(rules)).toBe(true);
      rmSync(rules);
      io.clock.now = new Date(NOW.getTime() + 1000);
      await runSync(QUIET, io);
      expect(existsSync(rules)).toBe(false);
      await runSync(SYNC, io);
      expect(existsSync(rules)).toBe(true);
      rmSync(rules);
      io.clock.now = new Date(NOW.getTime() + 61_000);
      await runSync(QUIET, io);
      expect(existsSync(rules)).toBe(true);
    });
  });

  test("a hook run never deletes: a dropped source's file waits for an interactive sync", async () => {
    await world(async (w) => {
      const { io, rules } = await lastGood(w, 1);
      await runSync(SYNC, io);
      writeState(w.home, stateWith({}));
      io.clock.now = new Date(NOW.getTime() + 120_000);
      await runSync(QUIET, io);
      expect(existsSync(rules)).toBe(true);
      expect(logText(w.home)).toContain("deferred 3 deletion(s) until an interactive sync");
      expect(readFileSync(join(w.userHome, ".fixture", "settings.json"), "utf8")).toContain(
        "npx -y @vivswan/maxims sync --quiet",
      );
      await runSync(SYNC, io);
      expect(existsSync(rules)).toBe(false);
      expect(existsSync(storePathFor(w.home, FROM))).toBe(false);
    });
  });

  test("a held lock skips a hook run with exit 0 and one log line; a manual run waits then exits 5", async () => {
    await world(async (w) => {
      const { io } = await lastGood(w, 1);
      await withStateLock(w.home, "manual", async () => {
        const report = await runSync(QUIET, io);
        expect(report.plan.changes).toEqual([]);
        expect(io.out.join("")).toBe("");
        expect(logText(w.home)).toContain("sync --quiet: skipped, store is locked by");
        const error = await expectExit(runSync(SYNC, io), ExitCode.StoreLocked);
        expect(error.message).toContain("store is locked by");
      });
    });
  }, 15_000);

  const unusable = [
    {
      name: "newer",
      write: (home: string) =>
        writeFileSync(homePaths(home).state, JSON.stringify({ version: 99 })),
      log: "written by a newer maxims (v99)",
    },
    {
      name: "corrupt",
      write: (home: string) => writeFileSync(homePaths(home).state, "{not json"),
      log: "was corrupt and moved to",
    },
  ];
  for (const { name, write, log } of unusable) {
    test(`a ${name} state file under --quiet changes nothing and logs one line`, async () => {
      await world(async (w) => {
        const { io, rules } = await lastGood(w, 1);
        await runSync(SYNC, io);
        write(w.home);
        io.clock.now = new Date(NOW.getTime() + 120_000);
        io.out.length = 0;
        const report = await runSync(QUIET, io);
        expect(report.plan.changes).toEqual([]);
        expect(existsSync(rules)).toBe(true);
        expect(io.out.join("")).toBe("");
        expect(logText(w.home)).toContain(log);
      });
    });
  }

  test("a listing and a dry run leave a corrupt state file byte-identical; a real sync moves it aside", async () => {
    await world(async (w) => {
      const { io, rules } = await lastGood(w, 1);
      await runSync(SYNC, io);
      const path = homePaths(w.home).state;
      writeFileSync(path, "{not json");
      const before = readFileSync(path, "utf8");
      const line = expect.stringMatching(
        /^maxims: state\.json is corrupt: not valid JSON: .*; run maxims sync to quarantine it$/,
      );
      io.out.length = 0;
      const listed = await runList({ quiet: false, dryRun: false, json: true }, io);
      expect(listed.sources).toEqual([]);
      expect(listed.notices).toEqual([line]);
      const previewed = await runSync({ ...SYNC, dryRun: true }, io);
      expect(previewed.plan.changes).toEqual([]);
      expect(previewed.notices).toEqual([line]);
      expect(readFileSync(path, "utf8")).toBe(before);
      expect(readdirSync(w.home).filter((name) => name.startsWith("state.json."))).toEqual([]);
      expect(existsSync(rules)).toBe(true);
      await runSync(SYNC, io);
      expect(readdirSync(w.home).some((name) => name.startsWith("state.json.corrupt-"))).toBe(true);
    });
  });

  test("a failed refresh is reported as failed under --quiet too, and never thrown", async () => {
    await world(async (w) => {
      const { fake, io } = await lastGood(w, 9);
      fake.set(FROM, { kind: "fail", failure: "ratelimit", retryAfterSeconds: 60 });
      const report = await runSync(QUIET, io);
      expect(report.failed).toEqual([
        { key: KEY, message: "scripted ratelimit", kind: "ratelimit" },
      ]);
      expect(await runSync({ ...SYNC, noFetch: true }, io)).toMatchObject({ failed: [] });
    });
  });

  test("the lock file's sources this machine lacks earn one notice and no fetch", async () => {
    await world(async (w) => {
      const { fake, io } = await lastGood(w, 1);
      mkdirSync(join(w.project, ".agents"), { recursive: true });
      writeFileSync(
        join(w.project, ".agents", "maxims.lock"),
        JSON.stringify({
          version: 1,
          sources: {
            "@acme/rules": {
              from: { type: "github", repo: "acme/rules" },
              select: "*",
              rule: true,
              harnesses: ["claude-code"],
            },
            "@acme/other": {
              from: { type: "github", repo: "acme/other" },
              select: "*",
              rule: true,
              harnesses: ["claude-code"],
            },
          },
        }),
      );
      io.cwd = w.project;
      const report = await runSync(SYNC, io);
      expect(report.notices).toContain(
        "maxims: @acme/other is in .agents/maxims.lock but not installed here; run maxims install",
      );
      expect(fake.calls.some((call) => call.includes("@acme/other"))).toBe(false);
    });
  });
});

describe("quiet json no-op paths", () => {
  test("a debounced run and a held lock each print one document", async () => {
    await world(async (w) => {
      const { io } = await lastGood(w, 1);
      await runSync(QUIET, io);
      io.out.length = 0;
      io.clock.now = new Date(NOW.getTime() + 1000);
      await runSync({ ...QUIET, json: true }, io);
      expect(JSON.parse(io.out.join("")).report.notices).toEqual([
        "maxims: skipped, a sync ran less than a minute ago",
      ]);
      io.out.length = 0;
      io.clock.now = new Date(NOW.getTime() + 120_000);
      await withStateLock(w.home, "manual", async () => {
        await runSync({ ...QUIET, json: true }, io);
      });
      const document = JSON.parse(io.out.join(""));
      expect(document.ok).toBe(true);
      expect(document.report.notices[0]).toMatch(/^maxims: skipped, store is locked by /);
    });
  });
});

describe("unreachable harnesses with unreadable sources", () => {
  test("an unreadable project source does not plant a hook in a harness folder the project lacks", async () => {
    await world(async (w) => {
      rmSync(join(w.project, ".fixture"), { recursive: true });
      const upstream = writeSource(join(w.dir, "upstream"), TWO_MEMORIES);
      const facts = await fetchedFacts(upstream, daysAgo(NOW, 1));
      const entry = fetchedEntry(FROM, facts, { destination: { scope: "project" } });
      writeState(w.home, stateWith({ [KEY]: entry }, ["claude-code"]));
      const fake = fakeResolvers();
      fake.set(FROM, { kind: "fail", failure: "network" });
      const io = fakeIo({ ...w, cwd: w.project, resolvers: fake.resolvers });
      await runSync(SYNC, io);
      expect(existsSync(join(w.project, ".fixture"))).toBe(false);
    });
  });
});

describe("live sources whose files all fail the contract", () => {
  test("a live source whose only memory lost its frontmatter keeps its block", async () => {
    await world(async (w) => {
      const live = writeSource(join(w.dir, "live"), { alpha: { description: "Alpha." } });
      writeState(w.home, stateWith({ [live]: entryFor(localFrom(live, true)) }));
      const io = fakeIo({ ...w, cwd: w.dir });
      await runSync(SYNC, io);
      const rules = readdirRules(w.userHome);
      const before = readFileSync(rules, "utf8");
      writeFileSync(join(live, "memories", "alpha.md"), "no frontmatter any more\n");
      const report = await runSync(SYNC, io);
      expect(readFileSync(rules, "utf8")).toBe(before);
      expect(report.notices.some((line) => line.includes("no valid memories"))).toBe(true);
      expect(report.failed).toEqual([
        {
          key: live,
          message: "no valid memories (memories/alpha.md: missing frontmatter)",
          kind: "invalid",
        },
      ]);
    });
  });

  // A memories folder emptied by hand is the same last-good case as one whose files all fail: a
  // hook run past the debounce must not rewrite the rule file with zero lines, and the next
  // interactive run must not sweep the copied body the retained lines point at.
  test("a live source emptied of memories keeps its block and copied body, reported as invalid", async () => {
    await world(async (w) => {
      const live = writeSource(join(w.dir, "live"), { alpha: { description: "Alpha." } });
      const entry = entryFor(localFrom(live, true), {
        destination: { scope: "project" },
        copy: true,
      });
      writeState(w.home, stateWith({ [live]: entry }));
      const io = fakeIo({ ...w, cwd: w.project });
      await runSync(SYNC, io);
      const slug = sourceSlug(localFrom(live, true));
      const rules = join(w.project, ".fixture", "rules", `maxims-${slug}.md`);
      const body = join(w.project, ".agents", "memories", "alpha.md");
      const before = readFileSync(rules, "utf8");
      expect(before).toContain("Alpha.");
      rmSync(join(live, "memories", "alpha.md"));
      io.clock.now = new Date(NOW.getTime() + 2 * DAY_MS);
      const quiet = await runSync(QUIET, io);
      expect(readFileSync(rules, "utf8")).toBe(before);
      expect(quiet.notices).toContain(`maxims: ${live}: no memories; kept whatever is installed`);
      const manual = await runSync(SYNC, io);
      expect(readFileSync(rules, "utf8")).toBe(before);
      expect(readFileSync(body, "utf8")).toContain("Alpha.");
      expect(manual.failed).toEqual([{ key: live, message: "no memories", kind: "invalid" }]);
    });
  });
});

// Devin's session start and Windsurf's prompt action carry no working directory, so a hook run
// from them starts at the process cwd; every other payload names its project.
const NAMES_NO_DIRECTORY: ReadonlySet<string> = new Set(["devin", "windsurf"]);

describe("hook stdin contract", () => {
  const fixtures = HARNESSES.flatMap((def) =>
    def.fixtures?.hookStdin === undefined
      ? []
      : [
          {
            def,
            text: readFileSync(
              join(import.meta.dir, "..", "harnesses", def.id, "fixtures", def.fixtures.hookStdin),
              "utf8",
            ),
          },
        ],
  );
  test("every shipped fixture classifies as its own harness", () => {
    expect(fixtures.length).toBeGreaterThan(0);
    for (const { def, text } of fixtures) {
      const classified = classifyInvoker(text);
      const startDir = NAMES_NO_DIRECTORY.has(def.id) ? null : expect.any(String);
      expect(classified).toEqual({ kind: "harness", id: def.id, startDir });
    }
    expect(classifyInvoker(JSON.stringify({ hello: "world" }))).toEqual({ kind: "unknown-json" });
    expect(classifyInvoker("not json")).toEqual({ kind: "unknown-json" });
    expect(classifyInvoker(null)).toEqual({ kind: "none" });
    expect(classifyInvoker("")).toEqual({ kind: "none" });
  });

  for (const { def, text } of fixtures) {
    test(`${def.id}: a stale source's line reaches stdout in the ${def.hook.kind === "none" ? "silent" : def.hook.kind} protocol`, async () => {
      await world(async (w) => {
        const upstream = writeSource(join(w.dir, "upstream"), TWO_MEMORIES);
        seedStore(w.home, FROM, upstream);
        const facts = await fetchedFacts(upstream, daysAgo(NOW, 2), {
          kind: "missing",
          message: "404",
          at: NOW.toISOString(),
        });
        writeState(
          w.home,
          stateWith({ [KEY]: fetchedEntry(FROM, facts, { harnesses: ["claude-code"] }) }),
        );
        const io = fakeIo({ ...w, cwd: w.dir, harnesses: HARNESSES });
        await runSync({ ...SYNC, noFetch: true }, io);
        io.out.length = 0;
        io.clock.now = new Date(NOW.getTime() + 120_000);
        io.stdin = text;
        await runSync({ ...QUIET, noFetch: true }, io);
        const line =
          "maxims: @acme/rules offline, kept last-good from 2026-09-18 (2 rules); source repository gone or unreadable";
        const variant =
          def.hook.kind === "registry" || def.hook.kind === "file" ? def.hook.stdout : null;
        expect(io.out.join("")).toBe(renderHookStdout(variant, [line]));
      });
    });
  }

  test("an unknown JSON payload gets silence and a terminal gets plain text", async () => {
    await world(async (w) => {
      const upstream = writeSource(join(w.dir, "upstream"), TWO_MEMORIES);
      seedStore(w.home, FROM, upstream);
      const facts = await fetchedFacts(upstream, daysAgo(NOW, 2), {
        kind: "missing",
        message: "404",
        at: NOW.toISOString(),
      });
      writeState(w.home, stateWith({ [KEY]: fetchedEntry(FROM, facts) }));
      const io = fakeIo({ ...w, cwd: w.dir });
      await runSync({ ...SYNC, noFetch: true }, io);
      io.out.length = 0;
      io.clock.now = new Date(NOW.getTime() + 120_000);
      io.stdin = JSON.stringify({ someHarness: true });
      await runSync({ ...QUIET, noFetch: true }, io);
      expect(io.out.join("")).toBe("");
      expect(logText(w.home)).toContain("offline, kept last-good");
      const tty = fakeIo({ ...w, cwd: w.dir, now: new Date(NOW.getTime() + 240_000) });
      await runSync({ ...QUIET, noFetch: true }, tty);
      expect(tty.out.join("")).toMatch(/^maxims: @acme\/rules offline, kept last-good/);
    });
  });
});

describe("orphan store entries", () => {
  test("entries no intent derives are swept interactively, kept by a hook run, and prefixes are left alone", async () => {
    await world(async (w) => {
      const { io } = await lastGood(w, 1);
      const store = homePaths(w.home).store;
      const planted = [
        join(store, "_local", "x-deadbeef"),
        join(store, "acme", "old"),
        join(store, "constructor", "rules"),
        join(store, "_git", "git.example.com", "team", "rules"),
      ];
      for (const dir of planted) mkdirSync(join(dir, "memories"), { recursive: true });
      writeFileSync(join(store, "README"), "not an entry\n");
      mkdirSync(join(store, "emptyowner"));
      await runSync(QUIET, io);
      for (const dir of planted) expect(existsSync(dir)).toBe(true);
      io.clock.now = new Date(NOW.getTime() + 120_000);
      await runSync(SYNC, io);
      for (const dir of planted) expect(existsSync(dir)).toBe(false);
      expect(existsSync(join(store, "README"))).toBe(true);
      expect(existsSync(join(store, "emptyowner"))).toBe(true);
      expect(existsSync(storePathFor(w.home, FROM))).toBe(true);
    });
  });

  test("a live source's dangling link keeps the block and reports the error", async () => {
    await world(async (w) => {
      const live = writeSource(join(w.dir, "live"), TWO_MEMORIES);
      writeState(w.home, stateWith({ [live]: entryFor(localFrom(live, true)) }));
      const io = fakeIo({ ...w, cwd: w.dir });
      await runSync(SYNC, io);
      const rules = readFileSync(readdirRules(w.userHome), "utf8");
      rmSync(live, { recursive: true });
      const report = await runSync(SYNC, io);
      expect(readFileSync(readdirRules(w.userHome), "utf8")).toBe(rules);
      expect(report.notices.some((line) => line.includes("kept whatever is installed"))).toBe(true);
      expect(report.failed).toEqual([
        { key: live, message: `${live} has no memories directory`, kind: "missing" },
      ]);
      expect(existsSync(storePathFor(w.home, localFrom(live, true)))).toBe(false);
    });
  });
});

function readdirRules(userHome: string): string {
  const dir = join(userHome, ".fixture", "rules");
  const [only] = readdirSync(dir);
  return join(dir, only ?? "");
}
