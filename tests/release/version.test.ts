// Fails if the minted pre-release version stops being one npm orders along main: the count, the g-prefixed sha,
// and the refusals that keep a malformed input from minting a version that names no commit. git's own facts (a
// first-parent count that steps once per merge, the committer date read in UTC, the exit codes the ancestry reads
// rely on) are pinned on a fixture repository because nothing in this repository enforces them.
import { describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  gitAncestry,
  mainPosition,
  prereleaseVersion,
} from "../../.github/scripts/release-pipeline.ts";

const SHA = "0123456789abcdef0123456789abcdef01234567";
const POSITION = { count: 42, date: "20260920" };

describe("prereleaseVersion", () => {
  test.each([
    [
      "a patch bump under main, the count, the date, and a g-prefixed sha7",
      "1.2.3",
      POSITION,
      SHA,
      "1.2.4-main.42.20260920.g0123456",
    ],
    [
      "an all-digit sha7 keeps the g prefix npm needs to read it as a string",
      "0.0.0",
      { count: 1, date: "20260101" },
      `1234567${"a".repeat(33)}`,
      "0.0.1-main.1.20260101.g1234567",
    ],
  ])("mints %s", (_case, manifest, position, sha, expected) => {
    expect(prereleaseVersion(manifest, position, sha)).toBe(expected);
  });

  test.each([
    ["a manifest version that is not X.Y.Z", "1.2.3-rc.1", POSITION, SHA, /not X\.Y\.Z/],
    [
      "a count of 0, which names no commit",
      "1.2.3",
      { count: 0, date: "20260920" },
      SHA,
      /not a positive integer/,
    ],
    ["a short sha", "1.2.3", POSITION, "0123456", /not a full commit sha/],
  ])("refuses %s", (_case, manifest, position, sha, message) => {
    expect(() => prereleaseVersion(manifest, position, sha)).toThrow(message);
  });
});

/** The author and committer dates of the fixture's last commit: different days, and a committer zone whose local
 * date is still the 15th while UTC has moved to the 16th. */
const AUTHOR_DATE = "2026-01-01T12:00:00+00:00";
const COMMITTER_DATE = "2026-03-15T23:30:00-05:00";

function gitIn(cwd: string, env: Record<string, string>, ...args: string[]): string {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, ...env },
  }).trim();
}

/** main: one, two, three, a merge of the two-commit topic branch, four (with the dates above). */
function fixtureRepo(root: string): { shas: string[]; merge: string; branchTip: string } {
  const git = (...args: string[]) => gitIn(root, {}, ...args);
  git("init", "-q", "-b", "main");
  const commit = (message: string, env: Record<string, string> = {}): string => {
    writeFileSync(join(root, `${message.replaceAll(" ", "-")}.txt`), `${message}\n`);
    git("add", ".");
    gitIn(root, env, "-c", "commit.gpgsign=false", "commit", "-q", "-m", message);
    return git("rev-parse", "HEAD");
  };
  const one = commit("one");
  const two = commit("two");
  git("checkout", "-q", "-b", "topic");
  commit("topic one");
  const branchTip = commit("topic two");
  git("checkout", "-q", "main");
  const three = commit("three");
  git("-c", "commit.gpgsign=false", "merge", "-q", "--no-ff", "-m", "merge topic", "topic");
  const merge = git("rev-parse", "HEAD");
  const four = commit("four", { GIT_AUTHOR_DATE: AUTHOR_DATE, GIT_COMMITTER_DATE: COMMITTER_DATE });
  return { shas: [one, two, three, merge, four], merge, branchTip };
}

describe("git facts", () => {
  test("the first-parent count steps once per merge, the date is the committer's in UTC, and ancestry answers yes, no, and unknown", () => {
    const root = mkdtempSync(join(tmpdir(), "maxims-release-"));
    try {
      const { shas, merge, branchTip } = fixtureRepo(root);
      const [one, , , , four] = shas as [string, string, string, string, string];
      expect(shas.map((sha) => mainPosition(root, sha).count)).toEqual([1, 2, 3, 4, 5]);
      expect(mainPosition(root, four).date).toBe("20260316");
      const ancestry = gitAncestry(root);
      expect(ancestry.resolveCommit(four.slice(0, 7))).toBe(four);
      expect(ancestry.resolveCommit("fffffff")).toBeNull();
      expect(ancestry.isAncestor(one, four)).toBe(true);
      expect(ancestry.isAncestor(four, one)).toBe(false);
      expect(ancestry.isAncestor(branchTip, merge)).toBe(true);
      // merge-base exits 128 on a sha the repository lacks; that is a failure, never a "no".
      expect(() => ancestry.isAncestor("f".repeat(40), four)).toThrow(/merge-base/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
