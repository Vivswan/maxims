// Fails if the bundle a user installs stops honoring dry-run, writes a rule file as a symlink,
// registers a second hook handler, persists a harness path in state, changes something on a
// second sync, breaks a session start on a vanished source or a held lock, or leaves bytes
// behind on remove, while the unit tests over the pieces stay green: the build test asks the
// built artifact only for its version.
import { afterAll, beforeAll, expect, test } from "bun:test";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readlinkSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { sourceSlug } from "../../src/commands/shared/slug.ts";
import { HOOK_COMMAND } from "../../src/harnesses/contract.ts";
import { parseMemory } from "../../src/memory/contract.ts";
import { parseState, type SourceEntry, type State } from "../../src/state/schema.ts";
import { serializeState } from "../../src/state/store.ts";
import { ExitCode } from "../../src/util/exit-codes.ts";
import { sha256 } from "../../src/util/fs.ts";
import { homePaths, storePathFor } from "../../src/util/home.ts";
import { withLock } from "../../src/util/lock.ts";
import { withTempDir } from "../shared/temp_dir.ts";
import { type Bundle, buildBundle, type Home, makeHome, type Run, runMaxims } from "./binary.ts";
import {
  CLAUDE_SETTINGS,
  CODEX_HOOKS,
  fixtureRepo,
  harnessFixture,
  hookPayload,
  installDotfiles,
  memoriesRepo,
  redact,
  snapshot,
} from "./fixtures.ts";

const CLAUDE_STDIN = harnessFixture("claude-code", "hook-stdin.json");

let bundleDir = "";
let bundle: Bundle;

beforeAll(() => {
  const home = process.env.HOME;
  if (home === undefined) throw new Error("the test launcher must set HOME");
  bundleDir = mkdtempSync(join(home, "maxims-e2e-bundle-"));
  bundle = buildBundle(bundleDir);
});

afterAll(() => {
  rmSync(bundleDir, { recursive: true, force: true });
});

// A run that does its work stamps `last-sync` and appends to the log; every other byte under
// the home must hold still. A run that promises to write nothing is held to the bare snapshot.
const SYNC_TOUCHES = [".agents/maxims/log/refresh.log", ".agents/maxims/last-sync"];

function homeSnapshot(home: Home): Map<string, string> {
  return snapshot(home.root, SYNC_TOUCHES);
}

function ok(run: Run): Run {
  expect({ code: run.code, stderr: run.stderr }).toEqual({ code: ExitCode.Ok, stderr: "" });
  return run;
}

function readState(home: Home): State {
  const parsed = parseState(JSON.parse(readFileSync(homePaths(home.maximsHome).state, "utf8")));
  if (parsed.ok !== "parsed") throw new Error(`state.json: ${JSON.stringify(parsed)}`);
  return parsed.state;
}

function writeState(home: Home, state: State): void {
  writeFileSync(homePaths(home.maximsHome).state, serializeState(state));
}

function onlyEntry(state: State): [string, SourceEntry] {
  const entries = Object.entries(state.sources);
  const [entry] = entries;
  if (entries.length !== 1 || entry === undefined) throw new Error("expected one source in state");
  return entry;
}

function daysAgo(days: number): string {
  return new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
}

// The entry rewritten with a fetch record that says its last success was `at` and, when asked,
// that its last refresh failed then; the two facts a stale source carries.
function agedEntry(entry: SourceEntry, at: string, failed: boolean): SourceEntry {
  if (!("fetched" in entry) || entry.fetched === undefined)
    throw new Error("expected a fetched entry");
  const lastError = failed ? { kind: "missing" as const, message: "gone", at } : null;
  return { ...entry, fetched: { ...entry.fetched, at, lastError } } as SourceEntry;
}

function strings(value: unknown, into: string[] = []): string[] {
  if (typeof value === "string") into.push(value);
  else if (Array.isArray(value)) for (const item of value) strings(item, into);
  else if (typeof value === "object" && value !== null) {
    for (const item of Object.values(value)) strings(item, into);
  }
  return into;
}

type Handler = Record<string, unknown>;

// Every handler under `hooks.SessionStart[*].hooks[*]`, the grouped registry shape Claude Code
// and Codex share, split into ours and the user's.
function sessionStartHandlers(text: string): { ours: Handler[]; theirs: Handler[] } {
  const registry = JSON.parse(text) as { hooks?: { SessionStart?: { hooks?: Handler[] }[] } };
  const handlers = (registry.hooks?.SessionStart ?? []).flatMap((group) => group.hooks ?? []);
  return {
    ours: handlers.filter((handler) => handler.command === HOOK_COMMAND),
    theirs: handlers.filter((handler) => handler.command !== HOOK_COMMAND),
  };
}

function withoutStamp(home: Home): void {
  rmSync(homePaths(home.maximsHome).lastSync, { force: true });
}

test("1: add --dry-run prints the plan and writes nothing, not even state", async () => {
  await withTempDir(async (dir) => {
    const home = makeHome(dir);
    const out = join(dir, "out");
    const source = fixtureRepo(dir, "skills");
    const before = snapshot(home.root);
    const run = ok(
      await runMaxims(bundle, home, [
        "add",
        source,
        "-o",
        out,
        "--rule",
        "-a",
        "claude-code",
        "--dry-run",
        "-y",
      ]),
    );
    const planned = run.stdout
      .split("\n")
      .filter((line) => /^(write|mkdir|delete|symlink|unlink) /.test(line));
    expect(
      planned.some((line) => line.startsWith(`write   ${homePaths(home.maximsHome).state}`)),
    ).toBe(true);
    expect(planned.some((line) => line.startsWith("write   ") && line.includes(`${out}/`))).toBe(
      true,
    );
    expect(snapshot(home.root)).toEqual(before);
    expect(existsSync(out)).toBe(false);
    expect(existsSync(homePaths(home.maximsHome).state)).toBe(false);
  });
});

test("2: add installs a real rule file, one hook per registry and intent-only state", async () => {
  await withTempDir(async (dir) => {
    const home = makeHome(dir);
    const installed = await installDotfiles(bundle, dir, home);
    const { stdout } = ok(installed.run);
    const warnings = stdout.split("\n").filter((line) => line.startsWith("!  "));
    expect(redact(warnings.join("\n"), installed, home)).toBe(
      [
        '!  README.md is not a memory: filename stem "README" is not kebab-case',
        "!  maxims: <SOURCE>: 1 internal, hidden",
        "!  ~N tokens in <HOME>/.claude/rules/maxims-<SLUG>.md",
        "!  ~N tokens in <HOME>/.codex/AGENTS.md",
        "!  maxims: registered the maxims hook in <HOME>/.claude/settings.json",
        "!  maxims: registered the maxims hook in <HOME>/.codex/hooks.json",
      ].join("\n"),
    );
    expect(stdout).toContain("o  Found 1 memory (1 internal, hidden)\n");
    expect(stdout).toContain(`o  Hook registered: SessionStart -> ${HOOK_COMMAND}\n`);

    const rule = lstatSync(installed.ruleFile);
    expect({ file: rule.isFile(), link: rule.isSymbolicLink() }).toEqual({
      file: true,
      link: false,
    });
    const ruleText = readFileSync(installed.ruleFile, "utf8");
    expect(ruleText.split("\n").filter((line) => line.startsWith("- "))).toHaveLength(1);
    expect(ruleText).toContain(`<!-- maxims:begin ${installed.source} sha=`);
    expect(readFileSync(installed.block, "utf8")).toContain(
      `<!-- maxims:begin ${installed.source} sha=`,
    );

    for (const [path, fixture] of [
      [installed.registries.claude, CLAUDE_SETTINGS],
      [installed.registries.codex, CODEX_HOOKS],
    ] as const) {
      const written = sessionStartHandlers(readFileSync(path, "utf8"));
      expect(written.ours).toHaveLength(1);
      expect(written.theirs).toEqual(sessionStartHandlers(fixture).theirs);
      const registry = JSON.parse(readFileSync(path, "utf8")) as {
        hooks: { SessionStart: unknown[] };
      };
      registry.hooks.SessionStart.pop();
      expect(registry).toEqual(JSON.parse(fixture));
    }

    const state = readState(home);
    expect(state.hooks).toEqual(["claude-code", "codex"]);
    const [key, entry] = onlyEntry(state);
    expect(key).toBe(installed.source);
    expect(entry.intent).toMatchObject({
      destination: { scope: "global" },
      harnesses: ["claude-code", "codex"],
      rule: true,
    });
    const harnessDirs = [join(home.root, ".claude"), join(home.root, ".codex")];
    const leaked = strings(state).filter((value) =>
      harnessDirs.some((root) => value.startsWith(root)),
    );
    expect(leaked).toEqual([]);
  });
});

test("3a: a second sync changes nothing but the stamp and the log", async () => {
  await withTempDir(async (dir) => {
    const home = makeHome(dir);
    const installed = await installDotfiles(bundle, dir, home);
    ok(installed.run);
    ok(await runMaxims(bundle, home, ["sync"]));
    const before = homeSnapshot(home);
    const second = ok(await runMaxims(bundle, home, ["sync"]));
    // Both lines print although no byte moved: the summary counts every planned write, and a
    // rules-dir file is planned on every run. Pinned as printed today.
    expect(redact(second.stdout, installed, home)).toBe(
      "maxims: <SOURCE>: 1 internal, hidden\no  Installed 1 memory, 2 rule lines\n",
    );
    expect(homeSnapshot(home)).toEqual(before);
  });
});

test("3b: a hook run over a vanished source keeps last-good, records missing and says so", async () => {
  await withTempDir(async (dir) => {
    const home = makeHome(dir);
    const installed = await installDotfiles(bundle, dir, home);
    ok(installed.run);
    const ruleBefore = readFileSync(installed.ruleFile, "utf8");
    const ruleLines = ruleBefore.split("\n").filter((line) => line.startsWith("- "));
    renameSync(installed.source, `${installed.source}.gone`);
    const state = readState(home);
    const [key, entry] = onlyEntry(state);
    const lastSuccess = daysAgo(8);
    writeState(home, { ...state, sources: { [key]: agedEntry(entry, lastSuccess, false) } });
    withoutStamp(home);

    const run = ok(
      await runMaxims(bundle, home, ["sync", "--quiet"], {
        stdin: hookPayload(CLAUDE_STDIN, home),
      }),
    );
    const since = lastSuccess.slice(0, "2026-01-01".length);
    expect(run.stdout).toBe(
      `maxims: ${installed.source} offline, kept last-good from ${since} (1 rules); source repository gone or unreadable\n` +
        "maxims: rules refreshed (2 files updated)\n",
    );
    const ruleAfter = readFileSync(installed.ruleFile, "utf8");
    for (const line of ruleLines) expect(ruleAfter).toContain(line);
    expect(ruleAfter).toContain(
      `- maxims: the rules below from ${installed.source} have not refreshed since ${since}`,
    );
    const [, after] = onlyEntry(readState(home));
    if (!("fetched" in after) || after.fetched === undefined)
      throw new Error("expected a fetched entry");
    expect(after.fetched.lastError?.kind).toBe("missing");
  });
});

test("3c: a held lock turns a manual add into exit 5 naming the holder, with nothing written", async () => {
  await withTempDir(async (dir) => {
    const home = makeHome(dir);
    ok((await installDotfiles(bundle, dir, home)).run);
    // A source whose names collide with the installed one is refused before the lock is taken.
    const second = memoriesRepo(dir, 3);
    await withLock(homePaths(home.maximsHome).lock, { staleMs: 60_000 }, async () => {
      const before = snapshot(home.root);
      const started = Date.now();
      const run = await runMaxims(bundle, home, ["add", second, "-g", "-a", "codex", "-y"]);
      const elapsed = Date.now() - started;
      expect(run.code).toBe(ExitCode.StoreLocked);
      expect(run.stderr).toContain(` ERROR  store is locked by "`);
      expect(run.stderr).toContain(`(pid ${process.pid} on `);
      expect(elapsed).toBeLessThan(8000);
      expect(snapshot(home.root)).toEqual(before);
    });
  });
}, 20_000);

test("3d: a held lock makes a hook run exit 0 at once, with nothing written", async () => {
  await withTempDir(async (dir) => {
    const home = makeHome(dir);
    ok((await installDotfiles(bundle, dir, home)).run);
    withoutStamp(home);
    await withLock(homePaths(home.maximsHome).lock, { staleMs: 60_000 }, async () => {
      const before = homeSnapshot(home);
      const started = Date.now();
      const run = ok(await runMaxims(bundle, home, ["sync", "--quiet"]));
      const elapsed = Date.now() - started;
      expect(run.stdout).toBe("");
      expect(elapsed).toBeLessThan(2000);
      expect(homeSnapshot(home)).toEqual(before);
      expect(readFileSync(homePaths(home.maximsHome).log, "utf8")).toContain(
        "sync --quiet: skipped, store is locked by",
      );
    });
  });
});

test("4: remove takes back the rule file, the block, both registry entries and the store entry", async () => {
  await withTempDir(async (dir) => {
    const home = makeHome(dir);
    const installed = await installDotfiles(bundle, dir, home);
    ok(installed.run);
    const store = storePathFor(home.maximsHome, { type: "local", path: installed.source });
    expect(existsSync(store)).toBe(true);
    ok(await runMaxims(bundle, home, ["remove", installed.source, "-y"]));
    expect(existsSync(installed.ruleFile)).toBe(false);
    expect(existsSync(installed.block)).toBe(false);
    expect(existsSync(store)).toBe(false);
    expect(readFileSync(installed.registries.claude, "utf8")).toBe(CLAUDE_SETTINGS);
    expect(readFileSync(installed.registries.codex, "utf8")).toBe(CODEX_HOOKS);
    const state = readState(home);
    expect({ sources: state.sources, hooks: state.hooks }).toEqual({ sources: {}, hooks: [] });
  });
});

test("5: list --json is one document showing the rename and the stale source", async () => {
  await withTempDir(async (dir) => {
    const home = makeHome(dir);
    const installed = await installDotfiles(bundle, dir, home, [
      "--rename",
      "gate-exit-conditions-the-merge=merge-gate",
    ]);
    ok(installed.run);
    const state = readState(home);
    const [key, entry] = onlyEntry(state);
    writeState(home, { ...state, sources: { [key]: agedEntry(entry, daysAgo(8), true) } });
    const run = ok(await runMaxims(bundle, home, ["list", "--json"]));
    const report = JSON.parse(run.stdout) as {
      sources: {
        key: string;
        stale: { since: string; kind: string; days: number } | null;
        renames: unknown[];
        memories: unknown[];
      }[];
    };
    expect(report.sources).toHaveLength(1);
    const [source] = report.sources;
    expect(source?.key).toBe(installed.source);
    expect(source?.stale).toEqual({ since: expect.any(String), kind: "missing", days: 8 });
    expect(source?.renames).toEqual([
      {
        upstreamName: "gate-exit-conditions-the-merge",
        localName: "merge-gate",
        verdict: "unneeded",
        against: null,
      },
    ]);
    expect(source?.memories).toEqual([
      {
        upstreamName: "gate-exit-conditions-the-merge",
        localName: "merge-gate",
        shortHash: expect.stringMatching(/^[0-9a-f]{7}$/),
        disabled: false,
      },
    ]);
  });
});

test("6: init scaffolds a memory that passes the contract", async () => {
  await withTempDir(async (dir) => {
    const home = makeHome(dir);
    const run = ok(await runMaxims(bundle, home, ["init", "test-rule"], { cwd: home.project }));
    expect(run.stdout).toBe("o  Created memories/test-rule.md\n");
    const path = join(home.project, "memories", "test-rule.md");
    const parsed = parseMemory(path, readFileSync(path, "utf8"));
    expect(parsed.ok ? String(parsed.memory.name) : parsed.reason).toBe("test-rule");
  });
});

test("7: a project install writes under the project and nothing under the user home", async () => {
  await withTempDir(async (dir) => {
    const home = makeHome(dir);
    const source = fixtureRepo(dir, "skills");
    mkdirSync(join(home.project, ".claude"));
    ok(
      await runMaxims(bundle, home, ["add", source, "-p", "--rule", "-a", "claude-code", "-y"], {
        cwd: home.project,
      }),
    );
    const ruleFile = join(
      home.project,
      ".claude",
      "rules",
      `maxims-${sourceSlug({ type: "local", path: source })}.md`,
    );
    const rule = lstatSync(ruleFile);
    expect({ file: rule.isFile(), link: rule.isSymbolicLink() }).toEqual({
      file: true,
      link: false,
    });
    expect(
      readFileSync(ruleFile, "utf8")
        .split("\n")
        .filter((line) => line.startsWith("- ")),
    ).toHaveLength(4);
    const bodies = join(home.project, ".agents", "memories");
    const store = storePathFor(home.maximsHome, { type: "local", path: source });
    for (const name of [
      "gate-exit-conditions-the-merge",
      "no-sleep-waiting-on-subagents",
      "rubber-duck-before-every-commit",
      "skip-unfit-skills",
    ]) {
      const link = join(bodies, `${name}.md`);
      expect(resolve(bodies, readlinkSync(link))).toBe(join(store, "memories", `${name}.md`));
    }
    const [, entry] = onlyEntry(readState(home));
    expect(entry.intent.destination).toEqual({ scope: "project" });
    expect(existsSync(join(home.root, ".claude"))).toBe(false);
  });
});

type UsageRow = [argv: string[], code: number, stderr: string];

const usageRows: UsageRow[] = [
  [["--help"], 0, ""],
  [["add", "--help"], 0, ""],
  [["frob"], 1, " ERROR  Unknown command: frob\nTip: Run maxims --help for usage.\n"],
  [["add"], 1, " ERROR  Missing required argument: source\n"],
];

test.each(usageRows)(
  "8: maxims %j exits %i and leaves the home untouched",
  async (argv, code, stderr) => {
    await withTempDir(async (dir) => {
      const home = makeHome(dir);
      const before = snapshot(home.root);
      const run = await runMaxims(bundle, home, argv);
      expect({ code: run.code, stderr: run.stderr }).toEqual({ code, stderr });
      expect(run.stdout.length > 0).toBe(code === 0);
      expect(snapshot(home.root)).toEqual(before);
    });
  },
);

// The control for every "nothing written" row: the snapshot must see the three kinds of entry
// a run could leave behind, or an unconditional empty map would pass them all.
test("the home snapshot names a new empty directory, file and symlink", async () => {
  await withTempDir(async (dir) => {
    const home = makeHome(dir);
    const before = snapshot(home.root);
    mkdirSync(join(home.root, ".claude", "rules"), { recursive: true });
    mkdirSync(join(home.root, ".codex"));
    writeFileSync(join(home.root, ".claude", "rules", "maxims-x.md"), "- a rule\n");
    symlinkSync("/dev/null", join(home.root, ".claude", "link"));
    const after = snapshot(home.root);
    for (const key of before.keys()) after.delete(key);
    expect([...after.entries()].sort()).toEqual([
      [".claude", "dir"],
      [".claude/link", "link:/dev/null"],
      [".claude/rules", "dir"],
      [".claude/rules/maxims-x.md", sha256("- a rule\n")],
      [".codex", "dir"],
    ]);
  });
});

test("9: a source over the rule cap is refused whole with exit 8 and nothing written", async () => {
  await withTempDir(async (dir) => {
    const home = makeHome(dir);
    const source = memoriesRepo(dir, 30);
    const before = snapshot(home.root);
    const run = await runMaxims(bundle, home, ["add", source, "-g", "--rule", "-a", "codex", "-y"]);
    expect(run.code).toBe(ExitCode.RuleCapExceeded);
    expect(run.stderr).toContain(
      ` ERROR  ${source} would publish 30 rule lines, over the cap of 25\n`,
    );
    expect(snapshot(home.root)).toEqual(before);
    expect(existsSync(homePaths(home.maximsHome).state)).toBe(false);
  });
});
