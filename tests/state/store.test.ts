// Guards the state boundary on disk: a corrupt or hostile file that is half obeyed instead of moved
// aside, a newer file that gets rewritten, a migration that never persists, a redundant rewrite on
// every sync, a second writer that clobbers the first, or a lock-free read that moves aside or
// overwrites a file another process replaced after it looked would each surface only on a user's
// machine.
import { describe, expect, test } from "bun:test";
import {
  copyFileSync,
  existsSync,
  readdirSync,
  readFileSync,
  statSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, join } from "node:path";
import { type GitSha, parseGitSha } from "../../src/contracts/git-sha.ts";
import { type ContentHash, parseContentHash } from "../../src/memory/contract.ts";
import type { Ladder } from "../../src/state/migrations/runner.ts";
import { CURRENT_STATE_VERSION, FIRST_VERSION } from "../../src/state/migrations/state-ladder.ts";
import { emptyState, parseState, type SourceEntry, type State } from "../../src/state/schema.ts";
import {
  inspectState,
  readState,
  serializeState,
  WRITTEN_BY,
  withStateLock,
  writeState,
} from "../../src/state/store.ts";
import { ExitCode, MaximsError } from "../../src/util/exit-codes.ts";
import { homePaths } from "../../src/util/home.ts";
import { memoryName } from "../engine/fakes.ts";
import { WINDOWS } from "../shared/platform.ts";
import { srcPath } from "../shared/src_path.ts";
import { withTempHome } from "../shared/temp_dir.ts";

const FIXTURES = srcPath("state", "fixtures", "state");
const RUBBER_DUCK = memoryName("rubber-duck-before-every-commit");
const RENAME_FROM = memoryName("gate-exit-conditions-the-merge");
const RENAME_TO = memoryName("gate-exit-conditions-the-merge-dotfiles");

function contentHash(candidate: string): ContentHash {
  const hash = parseContentHash(candidate);
  if (hash === null) throw new Error(`${candidate} is not a content hash`);
  return hash;
}

function gitSha(candidate: string): GitSha {
  const sha = parseGitSha(candidate);
  if (sha === null) throw new Error(`${candidate} is not a git sha`);
  return sha;
}

// The first entry of current.json as the parser hands it back, byte-for-byte.
const VALID_STATE: State = {
  version: 1,
  writtenBy: "maxims@0.4.1",
  hooks: { global: ["claude-code", "codex"] },
  sources: {
    "@example-user/rules#main": {
      intent: {
        from: { type: "github", repo: "example-user/rules", ref: "main" },
        select: [RUBBER_DUCK],
        rename: { [RENAME_FROM]: RENAME_TO },
        rule: true,
        destination: { scope: "global" },
        copy: false,
        auth: false,
        harnesses: ["claude-code", "codex"],
        memoryPath: "memories",
        fullDepth: false,
      },
      fetched: {
        at: "2026-08-27T04:12:09.113Z",
        sha: gitSha("fc675572711b0a1c9e00000000000000000000aa"),
        memoryPath: "memories",
        memories: {
          [RUBBER_DUCK]: {
            content: contentHash(`sha256:${"9f2a1c".repeat(10)}9f2a`),
            description: contentHash(`sha256:${"11cd".repeat(16)}`),
          },
        },
        lastError: null,
      },
      addedAt: "2026-08-20T08:38:04.471Z",
    },
  },
};

// current.json also carries a shared project-scope entry.
const CURRENT_STATE: State = {
  ...VALID_STATE,
  sources: {
    ...VALID_STATE.sources,
    "@example-user/team-rules": {
      intent: {
        from: { type: "github", repo: "example-user/team-rules", ref: "HEAD" },
        select: "*",
        rename: {},
        rule: true,
        destination: { scope: "project", root: "/home/user/project" },
        copy: false,
        auth: false,
        harnesses: ["codex"],
        memoryPath: "memories",
        fullDepth: false,
        shared: true,
      },
      addedAt: "2026-08-21T09:00:00.000Z",
    },
  },
};

function seed(home: string, fixture: string): string {
  const path = homePaths(home).state;
  copyFileSync(join(FIXTURES, fixture), path);
  return path;
}

// The migration mechanics (write-back, the lock, a concurrent writer) run on the current golden
// with its version pin moved back one rung, brought forward by a one-step ladder that sets the pin
// and nothing else, so no second document shape exists for them.
const BELOW_CURRENT = CURRENT_STATE_VERSION - 1;

function seedAt(home: string, version: number): string {
  const path = homePaths(home).state;
  writeFileSync(path, `${JSON.stringify({ ...CURRENT_STATE, version }, null, 2)}\n`);
  return path;
}

function stampCurrent(json: unknown): unknown {
  if (typeof json !== "object" || json === null) throw new Error("expected an object");
  return { ...json, version: CURRENT_STATE_VERSION };
}

function oneStepLadder(up: (json: unknown) => unknown): Ladder {
  return {
    kind: "state",
    firstVersion: BELOW_CURRENT,
    steps: [{ description: "stamp the current version", up }],
  };
}

const STAMP_LADDER = oneStepLadder(stampCurrent);

const SECOND_KEY = "@example-user/more-rules#main";
const SECOND_SOURCE: SourceEntry = {
  intent: {
    from: { type: "github", repo: "example-user/more-rules", ref: "main" },
    select: "*",
    rename: {},
    rule: false,
    destination: { scope: "global" },
    copy: false,
    auth: false,
    harnesses: ["codex"],
    memoryPath: "memories",
    fullDepth: false,
  },
  addedAt: "2026-09-01T10:00:00.000Z",
};

// A step whose first run doubles as a concurrent writer: it executes after the lock-free read has
// the bytes and before the lock attempt, the one window in which another process can land a
// write that the reader must notice before it mutates the file.
function concurrentWriterLadder(
  path: string,
  bytes: string,
  up: (json: unknown) => unknown,
): Ladder {
  let landed = false;
  return oneStepLadder((json) => {
    if (!landed) {
      landed = true;
      writeFileSync(path, bytes);
    }
    return up(json);
  });
}

// Staleness is the lock file's age, so a stale fixture backdates the file's mtime along with the
// record; a record alone, however old, is refused as a live holder's lock.
function holdLock(home: string, holder: Record<string, unknown>, ageMs = 0): string {
  const lockPath = homePaths(home).lock;
  writeFileSync(lockPath, `${JSON.stringify(holder)}\n`);
  const then = new Date(Date.now() - ageMs);
  utimesSync(lockPath, then, then);
  return lockPath;
}

// A manual-mode holder that signals when its callback is running, so a contender started after
// `entered` resolves is known to meet a held lock rather than an empty directory.
function heldLock(home: string): {
  entered: Promise<void>;
  release: () => void;
  done: Promise<string>;
} {
  const entered = Promise.withResolvers<void>();
  const held = Promise.withResolvers<void>();
  const done = withStateLock(home, "manual", async () => {
    entered.resolve();
    await held.promise;
    return "first";
  });
  return { entered: entered.promise, release: held.resolve, done };
}

describe("readState", () => {
  test("a missing file is absent and nothing is created", async () => {
    await withTempHome(async (home) => {
      expect(await readState(home)).toEqual({ kind: "absent" });
      expect(readdirSync(home)).toEqual([]);
    });
  });

  test("current.json reads as the golden structure without touching the file", async () => {
    await withTempHome(async (home) => {
      const path = seed(home, "current.json");
      const before = readFileSync(path, "utf8");
      expect(await readState(home)).toEqual({
        kind: "loaded",
        state: CURRENT_STATE,
        migrated: false,
      });
      expect(readFileSync(path, "utf8")).toBe(before);
      expect(readdirSync(home)).toEqual(["state.json"]);
    });
  });

  // Every writer stamps `toISOString()`, so a hand-edited timestamp is the only way another
  // precision reaches the file; the parsed value is canonical so that no later comparison sees
  // two spellings of one instant, and a read still rewrites nothing.
  test("timestamps of another precision read as millisecond form without touching the file", async () => {
    await withTempHome(async (home) => {
      const path = seed(home, "current-odd-precision.json");
      const before = readFileSync(path, "utf8");
      const expected = structuredClone(CURRENT_STATE);
      const first = expected.sources["@example-user/rules#main"];
      const second = expected.sources["@example-user/team-rules"];
      if (first === undefined || !("fetched" in first) || first.fetched === undefined) {
        throw new Error("the golden state lost its fetched entry");
      }
      if (second === undefined) throw new Error("the golden state lost its second entry");
      first.fetched.at = "2026-08-27T04:12:09.113Z";
      first.addedAt = "2026-08-20T08:38:04.000Z";
      second.addedAt = "2026-08-21T09:00:00.000Z";
      expect(await readState(home)).toEqual({ kind: "loaded", state: expected, migrated: false });
      expect(readFileSync(path, "utf8")).toBe(before);
    });
  });

  const hostile: { fixture: string; issue: RegExp }[] = [
    { fixture: "corrupt-json.txt", issue: /^not valid JSON: / },
    { fixture: "hostile-extra-key.json", issue: /installedPath/ },
    { fixture: "hostile-traversal.json", issue: /select\.0: expected a kebab-case memory name/ },
    {
      fixture: "corrupt-fractional-version.json",
      issue: new RegExp(`^version: Invalid input: expected ${CURRENT_STATE_VERSION}$`),
    },
    {
      fixture: "corrupt-unpinned-key.json",
      issue: /^sources\.@example-user\/rules: source key must be @example-user\/rules#main$/,
    },
    {
      fixture: "corrupt-case-twins.json",
      issue:
        /^sources\.@Example-User\/Rules: names the same GitHub repository as @example-user\/rules$/,
    },
    {
      fixture: "corrupt-nul-path.json",
      issue: /intent\.from\.path: a path cannot contain NUL$/,
    },
    {
      fixture: "corrupt-pending-unreviewed.json",
      issue: /pending: a held revision needs the source marked for review$/,
    },
    {
      fixture: "corrupt-pending-at-installed-sha.json",
      issue: /pending\.sha: the held revision is the installed one$/,
    },
    {
      fixture: "corrupt-pending-without-fetched.json",
      issue: /pending: a held revision needs an installed revision behind it$/,
    },
    // One fixture per required intent field, so a parse default restored on any one of them goes
    // red here, at the file, and not only at the parser.
    ...(
      [
        ["auth", "auth", "boolean"],
        ["memory-path", "memoryPath", "string"],
        ["full-depth", "fullDepth", "boolean"],
      ] as const
    ).map(([name, field, expected]) => ({
      fixture: `corrupt-intent-without-${name}.json`,
      issue: new RegExp(
        `^sources\\.@example-user/rules\\.intent\\.${field}: Invalid input: expected ${expected}, received undefined$`,
      ),
    })),
  ];
  test.each(hostile)(
    "$fixture is moved aside, reported, and never rebuilt",
    async ({ fixture, issue }) => {
      await withTempHome(async (home) => {
        const path = seed(home, fixture);
        const original = readFileSync(path, "utf8");
        const result = await readState(home);
        expect(result.kind).toBe("quarantined");
        if (result.kind !== "quarantined") return;
        expect(dirname(result.movedTo)).toBe(home);
        expect(basename(result.movedTo)).toMatch(
          /^state\.json\.corrupt-\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}\.\d{3}Z$/,
        );
        expect(result.issues.some((line) => issue.test(line))).toBe(true);
        expect(readFileSync(result.movedTo, "utf8")).toBe(original);
        expect(existsSync(path)).toBe(false);
        expect(await readState(home)).toEqual({ kind: "absent" });
      });
    },
  );

  test("a newer file is refused with its version and path, and its bytes are left alone", async () => {
    await withTempHome(async (home) => {
      const path = seed(home, "newer.json");
      const before = readFileSync(path, "utf8");
      expect(await readState(home)).toEqual({ kind: "newer", version: 99, path });
      expect(readFileSync(path, "utf8")).toBe(before);
      expect(readdirSync(home)).toEqual(["state.json"]);
    });
  });

  test("a version below the first rung is quarantined, never read as current", async () => {
    await withTempHome(async (home) => {
      const path = seedAt(home, FIRST_VERSION - 1);
      const original = readFileSync(path, "utf8");
      const result = await readState(home);
      expect(result.kind).toBe("quarantined");
      if (result.kind !== "quarantined") return;
      expect(result.issues).toEqual([
        expect.stringMatching(
          new RegExp(
            `^version ${FIRST_VERSION - 1} is older than any migration this maxims carries`,
          ),
        ),
      ]);
      expect(readFileSync(result.movedTo, "utf8")).toBe(original);
      expect(existsSync(path)).toBe(false);
    });
  });

  test("a due migration is applied, stamped as written by this maxims, and persisted", async () => {
    await withTempHome(async (home) => {
      const path = seedAt(home, BELOW_CURRENT);
      const migrated: State = { ...CURRENT_STATE, writtenBy: WRITTEN_BY };
      const result = await readState(home, { ladder: STAMP_LADDER });
      expect(result).toEqual({ kind: "loaded", state: migrated, migrated: true });
      expect(readFileSync(path, "utf8")).toBe(serializeState(migrated));
      expect(await readState(home)).toEqual({ kind: "loaded", state: migrated, migrated: false });
      expect(readdirSync(home)).toEqual(["state.json"]);
    });
  });

  test("a lock-free read never waits on a held lock to persist a migration; the holder's read does", async () => {
    await withTempHome(async (home) => {
      const path = seedAt(home, BELOW_CURRENT);
      const before = readFileSync(path, "utf8");
      await withStateLock(home, "manual", async (lock) => {
        const outside = await readState(home, { ladder: STAMP_LADDER });
        expect(outside.kind).toBe("loaded");
        expect(readFileSync(path, "utf8")).toBe(before);
        const inside = await lock.read({ ladder: STAMP_LADDER });
        expect(inside).toEqual(outside);
        expect(readFileSync(path, "utf8")).toBe(
          serializeState({ ...CURRENT_STATE, writtenBy: WRITTEN_BY }),
        );
      });
    });
  });

  test("a file that turns valid between the lock-free read and the lock is kept, not quarantined", async () => {
    await withTempHome(async (home) => {
      const path = seedAt(home, BELOW_CURRENT);
      const landed = readFileSync(join(FIXTURES, "current.json"), "utf8");
      const ladder = concurrentWriterLadder(path, landed, () => ({
        version: CURRENT_STATE_VERSION,
      }));
      expect(await readState(home, { ladder })).toEqual({
        kind: "loaded",
        state: CURRENT_STATE,
        migrated: false,
      });
      expect(readFileSync(path, "utf8")).toBe(landed);
      expect(readdirSync(home)).toEqual(["state.json"]);
    });
  });

  test("a migration write-back keeps a source another writer landed before the lock was taken", async () => {
    await withTempHome(async (home) => {
      const path = seedAt(home, BELOW_CURRENT);
      const theirs: State = {
        ...CURRENT_STATE,
        writtenBy: WRITTEN_BY,
        sources: { ...CURRENT_STATE.sources, [SECOND_KEY]: SECOND_SOURCE },
      };
      const ladder = concurrentWriterLadder(path, serializeState(theirs), stampCurrent);
      expect(await readState(home, { ladder })).toEqual({
        kind: "loaded",
        state: theirs,
        migrated: false,
      });
      expect(readFileSync(path, "utf8")).toBe(serializeState(theirs));
      expect(readdirSync(home)).toEqual(["state.json"]);
    });
  });

  test("a corrupt file under a held lock is reported in place; the holder's read moves it aside", async () => {
    await withTempHome(async (home) => {
      const path = seed(home, "corrupt-json.txt");
      const before = readFileSync(path, "utf8");
      await withStateLock(home, "manual", async (lock) => {
        const result = await readState(home);
        expect(result).toEqual({
          kind: "corrupt",
          path,
          issues: [expect.stringMatching(/^not valid JSON: /)],
          lockedBy: expect.stringContaining(process.argv.join(" ")),
        });
        expect(readFileSync(path, "utf8")).toBe(before);
        expect(readdirSync(home).sort()).toEqual(["state.json", "state.json.lock"]);
        const inside = await lock.read();
        expect(inside.kind).toBe("quarantined");
        if (inside.kind !== "quarantined") return;
        expect(readFileSync(inside.movedTo, "utf8")).toBe(before);
        expect(existsSync(path)).toBe(false);
      });
      expect(await readState(home)).toEqual({ kind: "absent" });
    });
  });
});

describe("writeState", () => {
  test("writes once, stamps writtenBy, and skips an identical rewrite", async () => {
    await withTempHome(async (home) => {
      const state = emptyState("maxims@0.3.0");
      expect(await writeState(home, state, "maxims@0.4.1")).toEqual({ written: true });
      const path = homePaths(home).state;
      expect(readFileSync(path, "utf8")).toBe(
        serializeState({ ...state, writtenBy: "maxims@0.4.1" }),
      );
      expect(readdirSync(home)).toEqual(["state.json"]);
      const mtime = statSync(path).mtimeMs;
      await Bun.sleep(5);
      expect(await writeState(home, state, "maxims@0.4.1")).toEqual({ written: false });
      expect(statSync(path).mtimeMs).toBe(mtime);
      expect(await readState(home)).toEqual({
        kind: "loaded",
        state: { ...state, writtenBy: "maxims@0.4.1" },
        migrated: false,
      });
    });
  });

  // Windows has no mode bits to lock down.
  test.skipIf(WINDOWS)("leaves the state file owner-only and the home owner-only", async () => {
    await withTempHome(async (home) => {
      await writeState(home, emptyState("maxims@0.3.0"), "maxims@0.4.1");
      expect(statSync(homePaths(home).state).mode & 0o777).toBe(0o600);
      expect(statSync(home).mode & 0o777).toBe(0o700);
    });
  });

  test("serializeState is the file the store writes, human-readable, and parses back unchanged", async () => {
    await withTempHome(async (home) => {
      await writeState(home, VALID_STATE, VALID_STATE.writtenBy);
      const bytes = readFileSync(homePaths(home).state, "utf8");
      expect(bytes).toBe(serializeState(VALID_STATE));
      expect(
        bytes.startsWith(
          `{\n  "version": ${CURRENT_STATE_VERSION},\n  "writtenBy": "maxims@0.4.1",\n`,
        ),
      ).toBe(true);
      expect(bytes.endsWith("}\n")).toBe(true);
      expect(parseState(JSON.parse(bytes))).toEqual({ ok: "parsed", state: VALID_STATE });
    });
  });
});

describe("withStateLock", () => {
  test("manual mode: a second caller waits for the holder and runs once released; one whose wait runs out fails with exit 5 naming the holder's argv", async () => {
    await withTempHome(async (home) => {
      const holder = heldLock(home);
      await holder.entered;
      const patient = withStateLock(home, "manual", async () => "second", { waitMs: 5000 });
      const impatient = withStateLock(home, "manual", async () => "third", { waitMs: 60 });
      await expect(impatient).rejects.toBeInstanceOf(MaximsError);
      await expect(impatient).rejects.toMatchObject({
        code: ExitCode.StoreLocked,
        message: expect.stringContaining(process.argv.join(" ")),
      });
      expect(existsSync(homePaths(home).lock)).toBe(true);
      const meanwhile = Bun.sleep(60).then(() => "still held");
      await expect(Promise.race([patient, meanwhile])).resolves.toBe("still held");
      holder.release();
      expect(await Promise.all([holder.done, patient])).toEqual(["first", "second"]);
      expect(existsSync(homePaths(home).lock)).toBe(false);
    });
  });

  test("hook mode: a held lock is skipped at once with the holder's command line, and left in place", async () => {
    await withTempHome(async (home) => {
      const lockPath = holdLock(home, {
        pid: process.pid,
        host: "example.com",
        startedAt: new Date().toISOString(),
        argv: ["npx", "maxims", "add", "@example-user/rules"],
      });
      const started = Date.now();
      let ran = false;
      const outcome = await withStateLock(home, "hook", async () => {
        ran = true;
      });
      expect(Date.now() - started).toBeLessThan(500);
      expect(ran).toBe(false);
      expect(outcome.kind).toBe("skipped");
      if (outcome.kind !== "skipped") return;
      expect(outcome.reason).toContain("npx maxims add @example-user/rules");
      expect(existsSync(lockPath)).toBe(true);
    });
  });

  test("a stale lock from a dead holder is stolen, the theft reported, and the callback runs", async () => {
    await withTempHome(async (home) => {
      const startedAt = new Date(Date.now() - 120_000).toISOString();
      const lockPath = holdLock(
        home,
        { pid: 999_999, host: "example.com", startedAt, argv: ["maxims", "sync"] },
        120_000,
      );
      const outcome = await withStateLock(home, "hook", async (lock) => lock.stolen);
      expect(outcome).toEqual({
        kind: "ran",
        value: {
          holder: { pid: 999_999, host: "example.com", startedAt, argv: ["maxims", "sync"] },
          ageMs: expect.any(Number),
          holderAlive: false,
        },
      });
      if (outcome.kind === "ran") expect(outcome.value?.ageMs).toBeGreaterThanOrEqual(120_000);
      expect(existsSync(lockPath)).toBe(false);
    });
  });
});

describe("inspectState", () => {
  test("a corrupt file is reported and left in place, with no sibling and no home created", async () => {
    await withTempHome(async (home) => {
      const path = seed(home, "corrupt-json.txt");
      const before = readFileSync(path, "utf8");
      const result = await inspectState(home);
      expect(result).toEqual({
        kind: "corrupt",
        issues: [expect.stringMatching(/^not valid JSON: /)],
      });
      expect(readFileSync(path, "utf8")).toBe(before);
      expect(readdirSync(home)).toEqual(["state.json"]);
      expect(await inspectState(join(home, "nowhere"))).toEqual({ kind: "absent" });
      expect(existsSync(join(home, "nowhere"))).toBe(false);
    });
  });
});
