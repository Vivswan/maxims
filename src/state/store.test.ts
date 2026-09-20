// Guards the state boundary on disk: a corrupt or hostile file that is half obeyed instead of moved
// aside, a newer file that gets rewritten, a migration that never persists, a redundant rewrite on
// every sync, or a second writer that clobbers the first would each surface only on a user's machine.
import { describe, expect, test } from "bun:test";
import {
  copyFileSync,
  existsSync,
  readdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { withTempHome } from "../../tests/shared/temp_dir.ts";
import { type MemoryName, parseMemoryName } from "../memory/contract.ts";
import { ExitCode, MaximsError } from "../util/exit-codes.ts";
import { homePaths } from "../util/home.ts";
import { legacyHooksStep } from "./fixtures/migration-step-v0.ts";
import { emptyState, type State } from "./schema.ts";
import { readState, WRITTEN_BY, withStateLock, writeState } from "./store.ts";

const FIXTURES = join(import.meta.dir, "fixtures");
const RUBBER_DUCK = memoryName("rubber-duck-before-every-commit");
const RENAME_FROM = memoryName("gate-exit-conditions-the-merge");
const RENAME_TO = memoryName("gate-exit-conditions-the-merge-dotfiles");

function memoryName(candidate: string): MemoryName {
  const name = parseMemoryName(candidate);
  if (name === null) throw new Error(`${candidate} is not a memory name`);
  return name;
}

// The v1 fixture as the parser hands it back: defaults filled, everything else byte-for-byte.
const VALID_STATE: State = {
  version: 1,
  writtenBy: "maxims@0.4.1",
  hooks: ["claude-code", "codex"],
  sources: {
    "@example-user/rules": {
      intent: {
        from: { type: "github", repo: "example-user/rules", ref: "main" },
        select: [RUBBER_DUCK],
        rename: { [RENAME_FROM]: RENAME_TO },
        rule: true,
        destination: { scope: "global" },
        copy: false,
        harnesses: ["claude-code", "codex"],
        memoryPath: "memories",
        fullDepth: false,
      },
      fetched: {
        at: "2026-08-27T04:12:09.113Z",
        sha: "fc675572711b0a1c9e00000000000000000000aa",
        memoryPath: "memories",
        memories: {
          [RUBBER_DUCK]: {
            content: `sha256:${"9f2a1c".repeat(10)}9f2a`,
            description: `sha256:${"11cd".repeat(16)}`,
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

function serialized(state: State): string {
  return `${JSON.stringify(state, null, 2)}\n`;
}

function holdLock(home: string, holder: Record<string, unknown>): string {
  const lockPath = homePaths(home).lock;
  writeFileSync(lockPath, `${JSON.stringify(holder)}\n`);
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
    { fixture: "v1-corrupt-fractional-version.json", issue: /^version: expected an integer$/ },
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
      expect(readFileSync(path, "utf8")).toBe(serialized(migrated));
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
          serialized({ ...VALID_STATE, writtenBy: WRITTEN_BY }),
        );
      });
    });
  });
});

describe("writeState", () => {
  test("writes once, stamps writtenBy, locks down modes, and skips an identical rewrite", async () => {
    await withTempHome(async (home) => {
      const state = emptyState("maxims@0.3.0");
      expect(await writeState(home, state, "maxims@0.4.1")).toEqual({ written: true });
      const path = homePaths(home).state;
      expect(readFileSync(path, "utf8")).toBe(serialized({ ...state, writtenBy: "maxims@0.4.1" }));
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
});

describe("withStateLock", () => {
  test("manual mode: the second caller waits, then fails with exit 5 naming the holder's argv", async () => {
    await withTempHome(async (home) => {
      let release: () => void = () => undefined;
      const held = new Promise<void>((done) => {
        release = done;
      });
      const first = withStateLock(home, "manual", async () => {
        await held;
        return "first";
      });
      await Bun.sleep(10);
      const error = await expectLocked(
        withStateLock(home, "manual", async () => "second", { waitMs: 60 }),
      );
      expect(error.message).toContain(process.argv.join(" "));
      release();
      expect(await first).toBe("first");
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
      const lockPath = holdLock(home, {
        pid: 999_999,
        host: "example.com",
        startedAt,
        argv: ["maxims", "sync"],
      });
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
      expect(readFileSync(homePaths(home).state, "utf8")).toBe(serialized(state));
      expect(existsSync(homePaths(home).lock)).toBe(false);
    });
  });
});
