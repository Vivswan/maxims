// What would drift silently: a fail-soft rung that starts emptying or rewriting the last-good rule
// file when its remote is unreachable, gone, rewound to nothing valid or grown past the cap; a
// `sync --quiet` that exits non-zero on a broken state file, a held lock or a dead remote; a
// refused install (unparsable registry, cap, read-only destination) that leaves bytes behind. Every
// row drives the bundle a user installs, under node, against a real git remote on the loopback.
import { afterAll, beforeAll, expect, test } from "bun:test";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join, relative } from "node:path";
import { parseRuleBlocks } from "../../src/commands/shared/blocks.ts";
import { homePaths, storePathFor } from "../../src/util/home.ts";
import { withLock } from "../../src/util/lock.ts";
import {
  type Bundle,
  buildBundle,
  type Home,
  makeHome,
  type Run,
  runMaxims,
} from "../e2e/binary.ts";
import { snapshot } from "../e2e/fixtures.ts";
import { withTempDir } from "../shared/temp_dir.ts";
import {
  commitAll,
  fixtureRepo,
  type MemorySpec,
  manyMemories,
  memoryFile,
  writeMemories,
} from "./shared/fixture-repo.ts";
import { type GitDaemon, withGitDaemon } from "./shared/git-daemon.ts";
import {
  ageFetch,
  clearDebounce,
  fetchedOf,
  lastErrorOf,
  onlyRuleFile,
  quarantinedStates,
  readStateFile,
  refreshLog,
  ruleFiles,
  ruleLines,
  setCooldownDays,
} from "./shared/state.ts";

let bundleDir = "";
let bundle: Bundle;

beforeAll(() => {
  const home = process.env.HOME;
  if (home === undefined) throw new Error("the test launcher must set HOME");
  bundleDir = mkdtempSync(join(home, "maxims-chaos-bundle-"));
  bundle = buildBundle(bundleDir);
});

afterAll(() => {
  rmSync(bundleDir, { recursive: true, force: true });
});

const RULES: Record<string, MemorySpec> = {
  "always-review": { description: "Review the diff before every commit." },
  "keep-tests-green": { description: "Never merge red." },
};
const OTHER: Record<string, MemorySpec> = {
  "one-line-paragraphs": { description: "One sentence per line in prose." },
};

const SLOW_ROW_MS = 30_000;

type World = { dir: string; home: Home; remotes: string; daemon: GitDaemon };

async function withWorld<T>(fn: (world: World) => Promise<T>): Promise<T> {
  return withTempDir(async (dir) => {
    const home = makeHome(dir);
    const remotes = join(dir, "remotes");
    mkdirSync(remotes);
    return withGitDaemon(remotes, (daemon) => fn({ dir, home, remotes, daemon }));
  });
}

const ADD_FLAGS = ["-g", "--rule", "-a", "claude-code", "-y"];

async function install(
  world: World,
  name: string,
  files: Parameters<typeof fixtureRepo>[1],
  extraFlags: string[] = [],
): Promise<{ key: string; repo: string; run: Run }> {
  const repo = fixtureRepo(join(world.remotes, name), files).dir;
  const key = world.daemon.url(name);
  const run = await runMaxims(bundle, world.home, ["add", key, ...ADD_FLAGS, ...extraFlags]);
  return { key, repo, run };
}

function expectClean(run: Run): void {
  expect({ code: run.code, stderr: run.stderr }).toEqual({ code: 0, stderr: "" });
}

// The store tree under the maxims home, so a row can prove a failed refresh replaced no copy.
function storeSnapshot(home: Home): Map<string, string> {
  return snapshot(homePaths(home.maximsHome).store);
}

function storeEntry(home: Home, key: string): string {
  return storePathFor(home.maximsHome, { type: "git", url: key, ref: "HEAD" });
}

// A rendered rule file holds one line per memory, each carrying the description and a detail
// path into the store copy; the copy itself holds the file the fixture wrote.
function expectInstalled(
  home: Home,
  key: string,
  rule: string,
  memories: Record<string, MemorySpec>,
): void {
  const text = readFileSync(rule, "utf8");
  const names = Object.keys(memories).sort();
  expect(
    parseRuleBlocks(text).map((block) => ({ ...block, names: block.names.map(String) })),
  ).toEqual([{ source: key, names }]);
  const lines = ruleLines(text);
  expect(lines).toHaveLength(names.length);
  for (const [index, name] of names.entries()) {
    const spec = memories[name];
    if (spec === undefined) throw new Error(`no fixture for ${name}`);
    const body = join(storeEntry(home, key), "memories", `${name}.md`);
    expect(lines[index]).toContain(`- ${spec.description} (detail: ${body}, `);
    expect(readFileSync(body, "utf8")).toBe(memoryFile(name, spec));
  }
}

const STALE_LINE = "have not refreshed since";

type NetworkRow = {
  label: string;
  ageDays: number;
  cooldownDays: number;
  staleLine: boolean;
};

// Past the seven-day mark a failing source earns one staleness line inside its block; the
// eight-day row pins that the line is the only difference.
const networkRows: NetworkRow[] = [
  { label: "two days old under a one-day cooldown", ageDays: 2, cooldownDays: 1, staleLine: false },
  { label: "eight days old", ageDays: 8, cooldownDays: 7, staleLine: true },
];

function withoutStaleLine(text: string): string {
  return text
    .split("\n")
    .filter((line) => !line.includes(STALE_LINE))
    .join("\n");
}

test.each(networkRows)(
  "network: the remote gone, a fetch $label keeps the block; --quiet exits 0, sync exits 2",
  async ({ ageDays, cooldownDays, staleLine }) => {
    await withWorld(async (world) => {
      const { key, run } = await install(world, "rules", RULES);
      expectClean(run);
      const rule = onlyRuleFile(world.home.root);
      const before = readFileSync(rule, "utf8");
      const store = storeSnapshot(world.home);
      await world.daemon.stop();
      const clock = new Date();
      setCooldownDays(world.home.maximsHome, cooldownDays);
      ageFetch(world.home.maximsHome, key, ageDays, clock);
      clearDebounce(world.home.maximsHome);
      // The hook run meets the dead remote first, so its exit 0 is the fail-soft mapping at
      // work and not a fetch that was never due.
      const quiet = await runMaxims(bundle, world.home, ["sync", "--quiet"]);
      expect({ code: quiet.code, stderr: quiet.stderr }).toEqual({ code: 0, stderr: "" });
      expect(lastErrorOf(world.home.maximsHome, key)?.kind).toBe("network");
      const after = readFileSync(rule, "utf8");
      const staleLines = after.split("\n").filter((line) => line.includes(STALE_LINE));
      expect(staleLines).toHaveLength(staleLine ? 1 : 0);
      expect(withoutStaleLine(after)).toBe(before);
      expect(storeSnapshot(world.home)).toEqual(store);
      ageFetch(world.home.maximsHome, key, ageDays, clock);
      const manual = await runMaxims(bundle, world.home, ["sync"]);
      expect(manual.code).toBe(2);
      expect(manual.stderr).toMatch(
        /^maxims: git ls-remote: fatal: unable to connect to 127\.0\.0\.1/,
      );
      expect(lastErrorOf(world.home.maximsHome, key)?.kind).toBe("network");
      expect(readFileSync(rule, "utf8")).toBe(after);
      expect(storeSnapshot(world.home)).toEqual(store);
    });
  },
  SLOW_ROW_MS,
);

type MissingRow = { label: string; stopDaemon: boolean };

const missingRows: MissingRow[] = [
  { label: "a repository the daemon does not serve", stopDaemon: false },
  { label: "a port nobody listens on", stopDaemon: true },
];

test.each(missingRows)(
  "missing remote: a fresh add of $label exits 2 and writes nothing",
  async ({ stopDaemon }) => {
    await withWorld(async (world) => {
      if (stopDaemon) await world.daemon.stop();
      const before = snapshot(world.home.root);
      const run = await runMaxims(bundle, world.home, [
        "add",
        world.daemon.url("never-existed"),
        ...ADD_FLAGS,
      ]);
      expect(run.code).toBe(2);
      expect(run.stderr).toContain(
        ` ERROR  cannot fetch ${world.daemon.url("never-existed")}: git ls-remote: fatal: `,
      );
      expect(snapshot(world.home.root)).toEqual(before);
    });
  },
  SLOW_ROW_MS,
);

test(
  "corrupt state: a quiet sync quarantines the file and exits 0; the manual sync after it deletes nothing",
  async () => {
    await withWorld(async (world) => {
      const { run } = await install(world, "rules", RULES);
      expectClean(run);
      const rule = onlyRuleFile(world.home.root);
      const before = readFileSync(rule, "utf8");
      const store = storeSnapshot(world.home);
      const statePath = homePaths(world.home.maximsHome).state;
      writeFileSync(statePath, '{"version": 1, "sources": [');
      clearDebounce(world.home.maximsHome);
      const quiet = await runMaxims(bundle, world.home, ["sync", "--quiet"]);
      expect({ code: quiet.code, stdout: quiet.stdout, stderr: quiet.stderr }).toEqual({
        code: 0,
        stdout: "",
        stderr: "",
      });
      const [moved, ...others] = quarantinedStates(world.home.maximsHome);
      expect(others).toEqual([]);
      expect(moved).toBeDefined();
      expect(readFileSync(join(world.home.maximsHome, moved ?? ""), "utf8")).toBe(
        '{"version": 1, "sources": [',
      );
      expect(existsSync(statePath)).toBe(false);
      expect(readFileSync(rule, "utf8")).toBe(before);
      expect(refreshLog(world.home.maximsHome)).toContain("state.json was corrupt and moved to");
      const manual = await runMaxims(bundle, world.home, ["sync"]);
      expect({ code: manual.code, stdout: manual.stdout, stderr: manual.stderr }).toEqual({
        code: 0,
        stdout: "maxims: nothing installed\n",
        stderr: "",
      });
      expect(readFileSync(rule, "utf8")).toBe(before);
      expect(storeSnapshot(world.home)).toEqual(store);
    });
  },
  SLOW_ROW_MS,
);

test(
  "lock busy: add waits five seconds then exits 5; sync --quiet exits 0 at once with one log line",
  async () => {
    await withWorld(async (world) => {
      const paths = homePaths(world.home.maximsHome);
      const before = snapshot(world.home.root, [".agents/maxims/state.json.lock"]);
      const repo = fixtureRepo(join(world.remotes, "rules"), RULES).dir;
      expect(existsSync(repo)).toBe(true);
      await withLock(paths.lock, {}, async () => {
        const started = Date.now();
        const add = await runMaxims(bundle, world.home, [
          "add",
          world.daemon.url("rules"),
          ...ADD_FLAGS,
        ]);
        const waited = Date.now() - started;
        expect(add.code).toBe(5);
        expect(add.stderr).toMatch(/^ ERROR {2}store is locked by "/);
        expect(waited).toBeGreaterThanOrEqual(4500);
        expect(snapshot(world.home.root, [".agents/maxims/state.json.lock"])).toEqual(before);
        const quietStart = Date.now();
        const quiet = await runMaxims(bundle, world.home, ["sync", "--quiet"]);
        expect({ code: quiet.code, stdout: quiet.stdout, stderr: quiet.stderr }).toEqual({
          code: 0,
          stdout: "",
          stderr: "",
        });
        expect(Date.now() - quietStart).toBeLessThan(3000);
        expect(refreshLog(world.home.maximsHome).trimEnd().split("\n")).toEqual([
          expect.stringMatching(/^\S+ sync --quiet: skipped, store is locked by "/),
        ]);
      });
    });
  },
  SLOW_ROW_MS,
);

test(
  "unparsable harness config: add --add-hook exits 4 and leaves the registry and the home as they were",
  async () => {
    await withWorld(async (world) => {
      const settings = join(world.home.root, ".claude", "settings.json");
      mkdirSync(join(world.home.root, ".claude"), { recursive: true });
      writeFileSync(settings, '{ "hooks": [');
      const before = snapshot(world.home.root);
      const { run } = await install(world, "rules", RULES, ["--add-hook"]);
      expect(run.code).toBe(4);
      expect(run.stderr).toBe(
        ` ERROR  cannot edit ${settings}: it is not valid JSON\nTip: fix the file by hand, then run maxims sync\n`,
      );
      expect(readFileSync(settings, "utf8")).toBe('{ "hooks": [');
      expect(ruleFiles(world.home.root)).toEqual([]);
      expect(snapshot(world.home.root)).toEqual(before);
    });
  },
  SLOW_ROW_MS,
);

const CAP_HINT =
  "Tip: narrow the source with --memory <name>..., or raise the cap (currently 25) with --cap <n> for this run or `maxims config set ruleCap <n>` to keep it\n";

test(
  "cap on add: a source of 26 rule lines exits 8 with the --memory hint and writes nothing",
  async () => {
    await withWorld(async (world) => {
      const before = snapshot(world.home.root);
      const { key, run } = await install(world, "many", manyMemories(26));
      expect(run.code).toBe(8);
      expect(run.stderr).toBe(
        ` ERROR  ${key} would publish 26 rule lines, over the cap of 25\n${CAP_HINT}`,
      );
      expect(snapshot(world.home.root)).toEqual(before);
    });
  },
  SLOW_ROW_MS,
);

test(
  "cap on refresh: an installed source grown to 26 rule lines is refused whole and keeps last-good",
  async () => {
    await withWorld(async (world) => {
      const { key, repo, run } = await install(world, "rules", RULES);
      expectClean(run);
      const rule = onlyRuleFile(world.home.root);
      const before = readFileSync(rule, "utf8");
      const store = storeSnapshot(world.home);
      const statePath = homePaths(world.home.maximsHome).state;
      writeMemories(repo, manyMemories(26));
      commitAll(repo, "grown");
      setCooldownDays(world.home.maximsHome, 1);
      ageFetch(world.home.maximsHome, key, 2);
      const aged = readFileSync(statePath, "utf8");
      const manual = await runMaxims(bundle, world.home, ["sync"]);
      expect(manual.code).toBe(8);
      // The refusal is a notice of the run, printed with the frame before the exit is mapped.
      expect(manual.stderr).toBe("");
      expect(manual.stdout.split("\n")).toEqual(
        expect.arrayContaining([
          `x  ${key}: 26 rule lines exceed the cap of 25`,
          `   ${CAP_HINT.slice("Tip: ".length, -1)}`,
        ]),
      );
      expect(readFileSync(rule, "utf8")).toBe(before);
      expect(storeSnapshot(world.home)).toEqual(store);
      expect(readFileSync(statePath, "utf8")).toBe(aged);
    });
  },
  SLOW_ROW_MS,
);

// Mode bits mean nothing to root and nothing on Windows, so the row has no failure to observe there.
const cannotObserveReadOnly = process.platform === "win32" || process.getuid?.() === 0;

test.skipIf(cannotObserveReadOnly)(
  "read-only destination: the second add exits 4 with its intent and store copy recorded; the next sync writes only the missing file",
  async () => {
    await withWorld(async (world) => {
      const first = await install(world, "rules", RULES);
      expectClean(first.run);
      const rulesDir = join(world.home.root, ".claude", "rules");
      const firstRule = onlyRuleFile(world.home.root);
      const firstBytes = readFileSync(firstRule, "utf8");
      chmodSync(rulesDir, 0o500);
      let secondKey = "";
      try {
        const second = await install(world, "other", OTHER);
        secondKey = second.key;
        expect(second.run.code).toBe(4);
        expect(second.run.stderr).toMatch(/^ ERROR {2}cannot write .*EACCES/);
        const state = readStateFile(world.home.maximsHome);
        expect(Object.keys(state.sources).sort()).toEqual([first.key, second.key].sort());
        expect(Object.keys(fetchedOf(state, second.key).memories)).toEqual(Object.keys(OTHER));
        const copy = join(storeEntry(world.home, second.key), "memories", "one-line-paragraphs.md");
        expect(readFileSync(copy, "utf8")).toBe(
          memoryFile("one-line-paragraphs", { description: "One sentence per line in prose." }),
        );
        expect(ruleFiles(world.home.root)).toEqual([firstRule]);
        expect(readFileSync(firstRule, "utf8")).toBe(firstBytes);
      } finally {
        chmodSync(rulesDir, 0o755);
      }
      const beforeSync = snapshot(world.home.root, [".agents/maxims"]);
      const sync = await runMaxims(bundle, world.home, ["sync", "--json"]);
      expect(sync.code).toBe(0);
      const document = JSON.parse(sync.stdout) as {
        ok: boolean;
        plan: { changes: { kind: string; path: string }[] };
      };
      expect(document.ok).toBe(true);
      const [secondRule] = ruleFiles(world.home.root).filter((path) => path !== firstRule);
      if (secondRule === undefined) throw new Error("the second rule file was not written");
      // The state file is rewritten too (its keys come back sorted), so only the writes that
      // reach a harness are pinned.
      const destinationWrites = document.plan.changes.filter(
        (change) => change.kind === "write" && !change.path.startsWith(world.home.maximsHome),
      );
      expect(destinationWrites.map((change) => change.path)).toEqual([secondRule]);
      expectInstalled(world.home, secondKey, secondRule, OTHER);
      const afterSync = snapshot(world.home.root, [".agents/maxims"]);
      for (const [path, digest] of beforeSync) {
        expect(afterSync.get(path)).toBe(digest);
        afterSync.delete(path);
      }
      expect([...afterSync.keys()]).toEqual([relative(world.home.root, secondRule)]);
    });
  },
  SLOW_ROW_MS,
);

test(
  "zero valid memories: a remote rewound to a README alone exits 3, keeps the block and says so once",
  async () => {
    await withWorld(async (world) => {
      const { key, repo, run } = await install(world, "rules", RULES);
      expectClean(run);
      const rule = onlyRuleFile(world.home.root);
      const before = readFileSync(rule, "utf8");
      const store = storeSnapshot(world.home);
      writeMemories(repo, { README: { raw: "# memories\n\nNothing here any more.\n" } });
      commitAll(repo, "layout changed");
      setCooldownDays(world.home.maximsHome, 1);
      ageFetch(world.home.maximsHome, key, 2);
      const manual = await runMaxims(bundle, world.home, ["sync"]);
      expect(manual.code).toBe(3);
      const lines = manual.stdout.split("\n");
      expect(lines.filter((line) => line.includes("no valid memories"))).toEqual([
        `maxims: ${key}: no valid memories at memories (layout probably changed upstream); kept last-good`,
      ]);
      expect(lines.filter((line) => line.includes("skipped memories/README.md"))).toEqual([
        `${key}: skipped memories/README.md: filename stem "README" is not kebab-case`,
      ]);
      expect(lastErrorOf(world.home.maximsHome, key)?.kind).toBe("invalid");
      expect(readFileSync(rule, "utf8")).toBe(before);
      expect(storeSnapshot(world.home)).toEqual(store);
    });
  },
  SLOW_ROW_MS,
);

test(
  "partially valid: the valid memories install and every bad file earns one warning",
  async () => {
    await withWorld(async (world) => {
      const { key, run } = await install(world, "mixed", {
        ...RULES,
        "no-frontmatter": { raw: "just a paragraph\n" },
        "wrong-name": { raw: memoryFile("other-name", { description: "Named otherwise." }) },
      });
      expect(run.code).toBe(0);
      const warnings = run.stdout.split("\n").filter((line) => line.includes("is not a memory"));
      expect(warnings).toEqual([
        "!  no-frontmatter.md is not a memory: missing frontmatter",
        '!  wrong-name.md is not a memory: name "other-name" does not equal filename stem "wrong-name"',
      ]);
      const fetched = fetchedOf(readStateFile(world.home.maximsHome), key);
      expect(Object.keys(fetched.memories).sort()).toEqual(Object.keys(RULES).sort());
      expectInstalled(world.home, key, onlyRuleFile(world.home.root), RULES);
    });
  },
  SLOW_ROW_MS,
);
