// What would drift silently: an HTTP rung of the fetch ladder (rate limit, 404, 401, a broken
// tarball) that replaces the last-good store copy or rule block instead of recording lastError; a
// rate limit that is retried inside its Retry-After window; a tarball entry that escapes the
// extraction directory or lands as a link; a store copy that vanishes mid-refresh and takes the
// rule block with it; an MCP stub start inside the debounce window that opens a socket. Every row
// runs the real engine in-process with only the network scripted.
import { expect, test } from "bun:test";
import { existsSync, readFileSync, rmSync } from "node:fs";
import type { LastError } from "../../src/contracts/last-error.ts";
import { httpResponse } from "../../src/sources/github/fixtures/runner.ts";
import {
  buildTarball,
  FIXTURE_TOP,
  symlinkTarball,
  zipSlipTarball,
} from "../../src/sources/github/fixtures/tarballs.ts";
import { sha256 } from "../../src/util/fs.ts";
import { homePaths, storePathFor } from "../../src/util/home.ts";
import { snapshot } from "../e2e/fixtures.ts";
import { staleLines, withoutStaleLine } from "../shared/stale_line.ts";
import { type MemorySpec, memoryFile } from "./shared/fixture-repo.ts";
import {
  type GithubScript,
  githubRunner,
  healthyRemote,
  SHA_ONE,
  SHA_TWO,
  shaResponse,
  TARBALL_TOP,
} from "./shared/github-script.ts";
import {
  advanceClock,
  DAY_MS,
  type RealWorld,
  type RunResult,
  runReal,
  withRealWorld,
} from "./shared/real-cli.ts";
import { expectRuleFile } from "./shared/rule-file.ts";
import { lastErrorOf, onlyRuleFile, setCooldownDays } from "./shared/state.ts";

const KEY = "@acme/rules";
const FROM = { type: "github", repo: "acme/rules", ref: "HEAD" } as const;
const RULES: Record<string, MemorySpec> = {
  "always-review": { description: "Review the diff before every commit." },
  "keep-tests-green": { description: "Never merge red." },
};
const ADD = ["add", KEY, "-g", "--rule", "-a", "claude-code", "-y"];
const HOUR_MS = 60 * 60 * 1000;

type Installed = { world: RealWorld; script: GithubScript; rule: string; before: string };

async function withInstalled<T>(fn: (installed: Installed) => Promise<T>): Promise<T> {
  const script = healthyRemote(SHA_ONE, RULES);
  return withRealWorld({ runner: githubRunner(script) }, async (world) => {
    const add = await runReal(world, ADD);
    expect({ code: add.code, stderr: add.stderr }).toEqual({ code: 0, stderr: "" });
    const rule = onlyRuleFile(world.userHome);
    expectRuleFile(rule, KEY, storePathFor(world.maximsHome, FROM), RULES);
    setCooldownDays(world.maximsHome, 1);
    advanceClock(world, 2 * DAY_MS);
    return fn({ world, script, rule, before: readFileSync(rule, "utf8") });
  });
}

function storeSnapshot(world: RealWorld): Map<string, string> {
  return snapshot(homePaths(world.maximsHome).store);
}

function networkCalls(world: RealWorld): string[] {
  return world.runner.calls.filter((call) => call.startsWith("fetch "));
}

function expectQuietOk(run: RunResult, stdout: string | RegExp): void {
  expect({ code: run.code, stderr: run.stderr }).toEqual({ code: 0, stderr: "" });
  if (typeof stdout === "string") expect(run.stdout).toBe(stdout);
  else expect(run.stdout).toMatch(stdout);
}

const BROKEN_TARBALL = new Uint8Array([7, 3, 9, 250, 1, 0, 42, 42, 99, 200, 13, 37]);

// A failed source is asked again an hour after its failure; a rate limit that names a longer
// Retry-After holds the line past that hour, so its row must see the hour pass with no request.
const RETRY_AFTER_SECONDS = 2 * 60 * 60;

type HttpRung = {
  kind: LastError["kind"];
  answer: (script: GithubScript) => void;
  manualExit: number;
  // A gone repository or unusable content is stale at once, so the block gains the notice line the
  // same run and the hook run says so; a transient kind keeps the file byte-identical.
  staleAtOnce: boolean;
  quietStdout: string | RegExp;
  retryAfter: boolean;
};

const httpRungs: HttpRung[] = [
  {
    kind: "ratelimit",
    answer: (script) => {
      script.commits = () =>
        httpResponse(403, "", {
          "retry-after": String(RETRY_AFTER_SECONDS),
          "x-ratelimit-remaining": "0",
        });
    },
    manualExit: 2,
    staleAtOnce: false,
    quietStdout: "",
    retryAfter: true,
  },
  {
    kind: "missing",
    answer: (script) => {
      script.commits = () => httpResponse(404, "not found");
    },
    manualExit: 2,
    staleAtOnce: true,
    quietStdout:
      "maxims: @acme/rules has not refreshed since 2026-09-20 (source repository gone or unreadable); rules may be out of date\nmaxims: rules refreshed (1 file updated)\n",
    retryAfter: false,
  },
  {
    kind: "auth",
    answer: (script) => {
      script.commits = () => httpResponse(401, "bad credentials");
    },
    manualExit: 2,
    staleAtOnce: false,
    quietStdout: "",
    retryAfter: false,
  },
  {
    kind: "invalid",
    answer: (script) => {
      script.commits = () => shaResponse(SHA_TWO);
      script.tarball = () => httpResponse(200, BROKEN_TARBALL);
    },
    manualExit: 3,
    staleAtOnce: true,
    quietStdout:
      /^maxims: @acme\/rules has not refreshed since 2026-09-20 \(source content invalid\); rules may be out of date\nmaxims: rules refreshed \(1 file updated\)\n$/,
    retryAfter: false,
  },
];

test.each(httpRungs)(
  "$kind: the hook run keeps last-good and exits 0, the manual run after the retry wait exits $manualExit",
  async ({ kind, answer, manualExit, staleAtOnce, quietStdout, retryAfter }) => {
    await withInstalled(async ({ world, script, rule, before }) => {
      const store = storeSnapshot(world);
      answer(script);
      const failedAt = world.clock.now;
      expectQuietOk(await runReal(world, ["sync", "--quiet"]), quietStdout);
      const lastError = lastErrorOf(world.maximsHome, KEY);
      expect(lastError?.kind).toBe(kind);
      expect(lastError?.at).toBe(failedAt.toISOString());
      expect(lastError?.retryAfter).toBe(
        retryAfter
          ? new Date(failedAt.getTime() + RETRY_AFTER_SECONDS * 1000).toISOString()
          : undefined,
      );
      const after = readFileSync(rule, "utf8");
      expect(staleLines(after)).toHaveLength(staleAtOnce ? 1 : 0);
      expect(withoutStaleLine(after)).toBe(before);
      expect(storeSnapshot(world)).toEqual(store);
      // Inside the retry wait nothing is asked of the remote, and a manual run has nothing to
      // report as failed. A Retry-After longer than the ordinary hour holds past the hour too.
      const calls = networkCalls(world).length;
      const waits = retryAfter ? [30_000, HOUR_MS] : [30_000];
      for (const wait of waits) {
        advanceClock(world, wait);
        const inside = await runReal(world, ["sync"]);
        expect(inside.code).toBe(0);
        expect(networkCalls(world)).toHaveLength(calls);
      }
      advanceClock(world, HOUR_MS + 60_000);
      const manual = await runReal(world, ["sync"]);
      expect(manual.code).toBe(manualExit);
      expect(networkCalls(world).length).toBeGreaterThan(calls);
      expect(lastErrorOf(world.maximsHome, KEY)?.kind).toBe(kind);
      expect(readFileSync(rule, "utf8")).toBe(after);
      expect(storeSnapshot(world)).toEqual(store);
    });
  },
);

const FINE_RULE: Record<string, MemorySpec> = {
  "fine-rule": { description: "A rule that arrived beside two escapes." },
};

// The traversal and link entries the extractor must refuse, beside one valid memory, so the row
// can prove the good file lands and nothing else does.
function escapesBesideOneMemory(): Uint8Array {
  return buildTarball([
    { path: `${TARBALL_TOP}/memories/../../evil.md`, content: "escaped\n" },
    { path: "../../evil.md", content: "escaped\n" },
    { path: `${TARBALL_TOP}/memories/x.md`, type: "SymbolicLink", linkpath: "/etc/passwd" },
    {
      path: `${TARBALL_TOP}/memories/fine-rule.md`,
      content: memoryFile("fine-rule", FINE_RULE["fine-rule"] ?? { description: "" }),
    },
  ]);
}

type TarballRow = {
  label: string;
  tarball: () => Uint8Array;
  warnings: string[];
  // The valid memories the archive carries; none means the fetch is refused as having nothing
  // valid and last-good stays.
  installs: Record<string, MemorySpec> | null;
};

const tarballRows: TarballRow[] = [
  {
    label: "path traversal entries",
    tarball: zipSlipTarball,
    warnings: [
      `skipped tarball entry ${FIXTURE_TOP}/memories/../../evil.md: path traversal is rejected`,
      "skipped tarball entry ../../evil.md: path traversal is rejected",
    ],
    installs: null,
  },
  {
    label: "symbolic and hard link entries",
    tarball: symlinkTarball,
    warnings: [
      `skipped tarball entry ${FIXTURE_TOP}/memories/x.md: SymbolicLink entries are never extracted`,
      `skipped tarball entry ${FIXTURE_TOP}/memories/y.md: Link entries are never extracted`,
    ],
    installs: null,
  },
  {
    label: "escapes beside one valid memory",
    tarball: escapesBesideOneMemory,
    warnings: [
      `skipped tarball entry ${TARBALL_TOP}/memories/../../evil.md: path traversal is rejected`,
      "skipped tarball entry ../../evil.md: path traversal is rejected",
      `skipped tarball entry ${TARBALL_TOP}/memories/x.md: SymbolicLink entries are never extracted`,
    ],
    installs: FINE_RULE,
  },
];

test.each(tarballRows)(
  "tarball with $label: every escape is refused by name and only regular files under the top folder land",
  async ({ tarball, warnings, installs }) => {
    await withInstalled(async ({ world, script, rule, before }) => {
      const store = storeSnapshot(world);
      const entry = storePathFor(world.maximsHome, FROM);
      script.commits = () => shaResponse(SHA_TWO);
      const bytes = tarball();
      script.tarball = () => httpResponse(200, bytes);
      world.warnings.length = 0;
      const manual = await runReal(world, ["sync"]);
      expect(world.warnings).toEqual(warnings);
      if (installs === null) {
        expect(manual.code).toBe(3);
        expect(manual.stdout).toContain(
          `maxims: ${KEY} has not refreshed since 2026-09-20 (source content invalid); rules may be out of date`,
        );
        expect(lastErrorOf(world.maximsHome, KEY)?.kind).toBe("invalid");
        const after = readFileSync(rule, "utf8");
        expect(staleLines(after)).toHaveLength(1);
        expect(withoutStaleLine(after)).toBe(before);
        expect(storeSnapshot(world)).toEqual(store);
        return;
      }
      expect({ code: manual.code, stderr: manual.stderr }).toEqual({ code: 0, stderr: "" });
      expect(lastErrorOf(world.maximsHome, KEY)).toBeNull();
      expect(storeSnapshot(world)).toEqual(
        new Map([
          ["acme", "dir"],
          ["acme/rules", "dir"],
          ["acme/rules/memories", "dir"],
          ...Object.entries(installs).map(
            ([name, spec]) =>
              [`acme/rules/memories/${name}.md`, sha256(memoryFile(name, spec))] as const,
          ),
        ]),
      );
      expectRuleFile(rule, KEY, entry, installs);
      expect(readFileSync(rule, "utf8")).toContain(`sha=${SHA_TWO}`);
    });
  },
);

type VanishRow = {
  label: string;
  // Removes the store copy from inside the remote's answer, between the ladder's first request
  // and the swap that would replace the copy.
  answer: (script: GithubScript, entry: string) => void;
  manualExit: number;
  failed: LastError["kind"] | null;
  notice: string;
};

const vanishRows: VanishRow[] = [
  {
    label: "the tree download fails after the copy vanished",
    answer: (script, entry) => {
      script.commits = () => shaResponse(SHA_TWO);
      script.tarball = () => {
        rmSync(entry, { recursive: true, force: true });
        throw new TypeError("fetch failed: socket hang up");
      };
    },
    manualExit: 2,
    failed: "network",
    notice: `maxims: ${KEY}: https://codeload.github.com/acme/rules/tar.gz/${SHA_TWO}: fetch failed: socket hang up; kept whatever is installed`,
  },
  {
    label: "the remote is unchanged and the copy vanished during the check",
    answer: (script, entry) => {
      script.commits = () => {
        rmSync(entry, { recursive: true, force: true });
        return shaResponse(SHA_ONE);
      };
    },
    manualExit: 0,
    failed: null,
    notice: `maxims: ${KEY}: not fetched yet; kept whatever is installed`,
  },
];

test.each(vanishRows)(
  "store copy vanished mid-run, $label: the block is kept and the next run rebuilds the copy",
  async ({ answer, manualExit, failed, notice }) => {
    await withInstalled(async ({ world, script, rule, before }) => {
      const entry = storePathFor(world.maximsHome, FROM);
      answer(script, entry);
      const manual = await runReal(world, ["sync", "--json"]);
      expect(manual.code).toBe(manualExit);
      const document = JSON.parse(manual.stdout) as {
        ok: boolean;
        report: { failed: { key: string; kind: string }[]; notices: string[] };
      };
      expect(document.ok).toBe(failed === null);
      expect(document.report.failed.map((item) => [item.key, item.kind])).toEqual(
        failed === null ? [] : [[KEY, failed]],
      );
      expect(document.report.notices).toContain(notice);
      expect(readFileSync(rule, "utf8")).toBe(before);
      expect(existsSync(entry)).toBe(false);
      if (failed !== null) {
        // The remote still broken, a hook run past the retry wait asks again, fails again and
        // restores nothing.
        advanceClock(world, HOUR_MS + 60_000);
        const retried = networkCalls(world).length;
        const quiet = await runReal(world, ["sync", "--quiet"]);
        expect({ code: quiet.code, stderr: quiet.stderr }).toEqual({ code: 0, stderr: "" });
        expect(networkCalls(world).length).toBeGreaterThan(retried);
        expect(readFileSync(rule, "utf8")).toBe(before);
        expect(existsSync(entry)).toBe(false);
        expect(lastErrorOf(world.maximsHome, KEY)).toMatchObject({
          kind: failed,
          at: world.clock.now.toISOString(),
        });
      }
      // The copy is absent, so the source is due whatever the clock says: a hook run against the
      // healthy remote rebuilds it from the same commit and leaves the block untouched.
      Object.assign(script, healthyRemote(SHA_ONE, RULES));
      advanceClock(world, 61_000);
      const calls = networkCalls(world).length;
      const rebuilt = await runReal(world, ["sync", "--quiet"]);
      expect({ code: rebuilt.code, stderr: rebuilt.stderr }).toEqual({ code: 0, stderr: "" });
      expect(networkCalls(world).length).toBeGreaterThan(calls);
      expectRuleFile(rule, KEY, entry, RULES);
      expect(readFileSync(rule, "utf8")).toBe(before);
      expect(lastErrorOf(world.maximsHome, KEY)).toBeNull();
    });
  },
);

const INITIALIZE = JSON.stringify({
  jsonrpc: "2.0",
  id: 1,
  method: "initialize",
  params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "fixture" } },
});

test("mcp stub: a second start inside the debounce window answers the protocol and opens no socket", async () => {
  await withInstalled(async ({ world, rule, before }) => {
    const entry = storePathFor(world.maximsHome, FROM);
    const stamp = homePaths(world.maximsHome).lastSync;
    const calls = networkCalls(world).length;
    const first = await runReal(world, ["mcp-serve"], { stdin: `${INITIALIZE}\n` });
    expect({ code: first.code, stderr: first.stderr }).toEqual({ code: 0, stderr: "" });
    const answer = JSON.parse(first.stdout.trim()) as { result: { serverInfo: { name: string } } };
    expect(answer.result.serverInfo.name).toBe("maxims");
    expect(networkCalls(world)).toHaveLength(calls + 1);
    const stamped = readFileSync(stamp, "utf8");
    // With the copy gone the source is due again, so only the debounce keeps the second start
    // off the network.
    rmSync(entry, { recursive: true });
    advanceClock(world, 10_000);
    const second = await runReal(world, ["mcp-serve"], { stdin: `${INITIALIZE}\n` });
    expect({ code: second.code, stdout: second.stdout, stderr: second.stderr }).toEqual({
      code: 0,
      stdout: first.stdout,
      stderr: "",
    });
    expect(networkCalls(world)).toHaveLength(calls + 1);
    expect(readFileSync(stamp, "utf8")).toBe(stamped);
    // Judged before the third start, which rebuilds the copy and would rewrite the file anyway.
    expect(readFileSync(rule, "utf8")).toBe(before);
    advanceClock(world, 61_000);
    const third = await runReal(world, ["mcp-serve"], { stdin: `${INITIALIZE}\n` });
    expect({ code: third.code, stderr: third.stderr }).toEqual({ code: 0, stderr: "" });
    expect(networkCalls(world)).toHaveLength(calls + 3);
    expectRuleFile(rule, KEY, entry, RULES);
    expect(readFileSync(rule, "utf8")).toBe(before);
  });
});
