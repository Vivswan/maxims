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
import { join } from "node:path";
import { withTempHome } from "../../tests/shared/temp_dir.ts";
import {
  type ContentHash,
  type MemoryName,
  parseContentHash,
  parseMemoryName,
} from "../memory/contract.ts";
import { ExitCode, MaximsError } from "../util/exit-codes.ts";
import { homePaths } from "../util/home.ts";
import { legacyHooksStep } from "./fixtures/migration-step-v0.ts";
import type { MigrationStep } from "./migrations/index.ts";
import {
  emptyState,
  type GitSha,
  parseGitSha,
  parseState,
  type SourceEntry,
  type State,
} from "./schema.ts";
import {
  inspectState,
  readState,
  serializeState,
  WRITTEN_BY,
  withStateLock,
  writeState,
} from "./store.ts";

const FIXTURES = join(import.meta.dir, "fixtures");
const RUBBER_DUCK = memoryName("rubber-duck-before-every-commit");
const RENAME_FROM = memoryName("gate-exit-conditions-the-merge");
const RENAME_TO = memoryName("gate-exit-conditions-the-merge-dotfiles");

function memoryName(candidate: string): MemoryName {
  const name = parseMemoryName(candidate);
  if (name === null) throw new Error(`${candidate} is not a memory name`);
  return name;
}

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

// The v1 fixture as the parser hands it back: defaults filled, everything else byte-for-byte.
const VALID_STATE: State = {
  version: 1,
  writtenBy: "maxims@0.4.1",
  hooks: ["claude-code", "codex"],
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

function seed(home: string, fixture: string): string {
  const path = homePaths(home).state;
  copyFileSync(join(FIXTURES, fixture), path);
  return path;
}

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
function concurrentWriterStep(
  path: string,
  bytes: string,
  migrate: (json: unknown) => unknown,
): MigrationStep {
  let landed = false;
  return {
    from: 0,
    to: 1,
    migrate(json) {
      if (!landed) {
        landed = true;
        writeFileSync(path, bytes);
      }
      return migrate(json);
    },
  };
}

// Staleness is the lock file's age, so a stale fixture backdates the file's mtime along with the
// record; a record alone, however old, is a live holder's lock.
function holdLock(home: string, holder: Record<string, unknown>, ageMs = 0): string {
  const lockPath = homePaths(home).lock;
  writeFileSync(lockPath, `${JSON.stringify(holder)}\n`);
  const then = new Date(Date.now() - ageMs);
  utimesSync(lockPath, then, then);
  return lockPath;
}

async function expectLocked(promise: Promise<unknown>): Promise<MaximsError> {
  let caught: unknown;
  try {
    await promise;
  } catch (error) {
    caught = error;
  }
  if (!(caught instanceof MaximsError)) throw new Error(`expected a MaximsError, got ${caught}`);
  expect(caught.code).toBe(ExitCode.StoreLocked);
  return caught;
}

// A manual-mode holder that signals when its callback is running, so a contender started after
// `entered` resolves is known to meet a held lock rather than an empty directory.
function heldLock(home: string): {
  entered: Promise<void>;
  release: () => void;
  done: Promise<string>;
} {
  let enter: () => void = () => undefined;
  let release: () => void = () => undefined;
  const entered = new Promise<void>((done) => {
    enter = done;
  });
  const held = new Promise<void>((done) => {
    release = done;
  });
  const done = withStateLock(home, "manual", async () => {
    enter();
    await held;
    return "first";
  });
  return { entered, release, done };
}

describe("readState", () => {
  test("a missing file is absent and nothing is created", async () => {
    await withTempHome(async (home) => {
      expect(await readState(home)).toEqual({ kind: "absent" });
      expect(readdirSync(home)).toEqual([]);
    });
  });

  test("the v1 fixture reads as the golden structure without touching the file", async () => {
    await withTempHome(async (home) => {
      const path = seed(home, "v1-valid.json");
      const before = readFileSync(path, "utf8");
      expect(await readState(home)).toEqual({
        kind: "loaded",
        state: VALID_STATE,
        migrated: false,
      });
      expect(readFileSync(path, "utf8")).toBe(before);
      expect(readdirSync(home)).toEqual(["state.json"]);
    });
  });

  const hostile: { fixture: string; issue: RegExp }[] = [
    { fixture: "v1-corrupt-json.txt", issue: /^not valid JSON: / },
    { fixture: "v1-hostile-extra-key.json", issue: /installedPath/ },
    { fixture: "v1-hostile-traversal.json", issue: /select\.0: expected a kebab-case memory name/ },
    { fixture: "v0-legacy.json", issue: /^version 0 is older than any migration/ },
    {
      fixture: "v1-corrupt-fractional-version.json",
      issue: /^version: Invalid input: expected 1$/,
    },
    {
      fixture: "v1-corrupt-unpinned-key.json",
      issue: /^sources\.@example-user\/rules: source key must be @example-user\/rules#main$/,
    },
    {
      fixture: "v1-corrupt-case-twins.json",
      issue:
        /^sources\.@Example-User\/Rules: names the same GitHub repository as @example-user\/rules$/,
    },
    {
      fixture: "v1-corrupt-nul-path.json",
      issue: /intent\.from\.path: a path cannot contain NUL$/,
    },
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
        expect(result.movedTo).toMatch(
          /\/state\.json\.corrupt-\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}\.\d{3}Z$/,
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
      const path = seed(home, "v99-newer.json");
      const before = readFileSync(path, "utf8");
      expect(await readState(home)).toEqual({ kind: "newer", version: 99, path });
      expect(readFileSync(path, "utf8")).toBe(before);
      expect(readdirSync(home)).toEqual(["state.json"]);
    });
  });

  test("a due migration is applied, stamped as written by this maxims, and persisted", async () => {
    await withTempHome(async (home) => {
      const path = seed(home, "v0-legacy.json");
      const migrated: State = { ...VALID_STATE, writtenBy: WRITTEN_BY };
      const result = await readState(home, { migrations: [legacyHooksStep] });
      expect(result).toEqual({ kind: "loaded", state: migrated, migrated: true });
      expect(readFileSync(path, "utf8")).toBe(serializeState(migrated));
      expect(await readState(home)).toEqual({ kind: "loaded", state: migrated, migrated: false });
      expect(readdirSync(home)).toEqual(["state.json"]);
    });
  });

  test("a lock-free read never waits on a held lock to persist a migration; the holder's read does", async () => {
    await withTempHome(async (home) => {
      const path = seed(home, "v0-legacy.json");
      const before = readFileSync(path, "utf8");
      await withStateLock(home, "manual", async (lock) => {
        const outside = await readState(home, { migrations: [legacyHooksStep] });
        expect(outside.kind).toBe("loaded");
        expect(readFileSync(path, "utf8")).toBe(before);
        const inside = await lock.read({ migrations: [legacyHooksStep] });
        expect(inside).toEqual(outside);
        expect(readFileSync(path, "utf8")).toBe(
          serializeState({ ...VALID_STATE, writtenBy: WRITTEN_BY }),
        );
      });
    });
  });

  test("a file that turns valid between the lock-free read and the lock is kept, not quarantined", async () => {
    await withTempHome(async (home) => {
      const path = seed(home, "v0-legacy.json");
      const landed = readFileSync(join(FIXTURES, "v1-valid.json"), "utf8");
      const step = concurrentWriterStep(path, landed, () => ({ version: 1 }));
      expect(await readState(home, { migrations: [step] })).toEqual({
        kind: "loaded",
        state: VALID_STATE,
        migrated: false,
      });
      expect(readFileSync(path, "utf8")).toBe(landed);
      expect(readdirSync(home)).toEqual(["state.json"]);
    });
  });

  test("a migration write-back keeps a source another writer landed before the lock was taken", async () => {
    await withTempHome(async (home) => {
      const path = seed(home, "v0-legacy.json");
      const theirs: State = {
        ...VALID_STATE,
        writtenBy: WRITTEN_BY,
        sources: { ...VALID_STATE.sources, [SECOND_KEY]: SECOND_SOURCE },
      };
      const step = concurrentWriterStep(path, serializeState(theirs), legacyHooksStep.migrate);
      expect(await readState(home, { migrations: [step] })).toEqual({
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
      const path = seed(home, "v1-corrupt-json.txt");
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
  test("writes once, stamps writtenBy, locks down modes, and skips an identical rewrite", async () => {
    await withTempHome(async (home) => {
      const state = emptyState("maxims@0.3.0");
      expect(await writeState(home, state, "maxims@0.4.1")).toEqual({ written: true });
      const path = homePaths(home).state;
      expect(readFileSync(path, "utf8")).toBe(
        serializeState({ ...state, writtenBy: "maxims@0.4.1" }),
      );
      expect(statSync(path).mode & 0o777).toBe(0o600);
      expect(statSync(home).mode & 0o777).toBe(0o700);
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

  test("serializeState is the file the store writes, human-readable, and parses back unchanged", async () => {
    await withTempHome(async (home) => {
      await writeState(home, VALID_STATE, VALID_STATE.writtenBy);
      const bytes = readFileSync(homePaths(home).state, "utf8");
      expect(bytes).toBe(serializeState(VALID_STATE));
      expect(bytes.startsWith('{\n  "version": 1,\n  "writtenBy": "maxims@0.4.1",\n')).toBe(true);
      expect(bytes.endsWith("}\n")).toBe(true);
      expect(parseState(JSON.parse(bytes))).toEqual({ ok: "parsed", state: VALID_STATE });
    });
  });
});

describe("withStateLock", () => {
  test("manual mode: the second caller waits, then fails with exit 5 naming the holder's argv", async () => {
    await withTempHome(async (home) => {
      const holder = heldLock(home);
      await holder.entered;
      const error = await expectLocked(
        withStateLock(home, "manual", async () => "second", { waitMs: 60 }),
      );
      expect(error.message).toContain(process.argv.join(" "));
      holder.release();
      expect(await holder.done).toBe("first");
      expect(existsSync(homePaths(home).lock)).toBe(false);
    });
  });

  test("manual mode: the second caller stays pending while the lock is held and runs once it is released", async () => {
    await withTempHome(async (home) => {
      const holder = heldLock(home);
      await holder.entered;
      const second = withStateLock(home, "manual", async () => "second", { waitMs: 5000 });
      const meanwhile = Bun.sleep(60).then(() => "still held");
      expect(await Promise.race([second, meanwhile])).toBe("still held");
      holder.release();
      expect(await Promise.all([holder.done, second])).toEqual(["first", "second"]);
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

  test("a write through the lock lands in the file and the lock is released afterwards", async () => {
    await withTempHome(async (home) => {
      const state = emptyState("maxims@0.4.1");
      const outcome = await withStateLock(home, "hook", (lock) =>
        lock.write(state, "maxims@0.4.1"),
      );
      expect(outcome).toEqual({ kind: "ran", value: { written: true } });
      expect(readFileSync(homePaths(home).state, "utf8")).toBe(serializeState(state));
      expect(existsSync(homePaths(home).lock)).toBe(false);
    });
  });
});

describe("inspectState", () => {
  test("a corrupt file is reported and left in place, with no sibling and no home created", async () => {
    await withTempHome(async (home) => {
      const path = seed(home, "v1-corrupt-json.txt");
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
