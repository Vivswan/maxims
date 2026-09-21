// Fails if a publish verdict stops reading the registry the way the two lanes rely on: a stale run must never
// move next or latest back, a rerun must publish nothing, a source that changed nothing shipped since the next
// build must publish nothing while a next build the checkout cannot place holds nothing back, a shipped change
// main's tip has undone must publish nothing, and a record this pipeline cannot read must stop the run rather than
// pass for an empty registry. The history is hand-built, so the cases hold without git or network.
import { describe, expect, test } from "bun:test";
import {
  type Ancestry,
  type Channel,
  type ConfirmVerdict,
  confirmPublish,
  type NextVerdict,
  nextPublishVerdict,
  type Packument,
  type PublishVerdict,
  parsePackument,
  stablePublishVerdict,
  UnreadablePackument,
} from "../../.github/scripts/release-pipeline.ts";

/** A linear main: index order is commit order, and every sha7 is unique. SIDE is a commit off main. */
const MAIN = ["1000001", "2000002", "3000003", "4000004"].map((sha7) => sha7 + "e".repeat(33));
const [OLDER, SOURCE, NEWER, NEWEST] = MAIN as [string, string, string, string];
const SIDE = `5000005${"e".repeat(33)}`;

/** Where the remote-tracking ref of main sits in the checkout, and what differs between it and every other commit. */
interface Tip {
  sha: string;
  changed: string[];
}

/** The hand-built history: every pair of distinct commits differs by `changed` (a diff of a commit with itself is
 * empty), a diff up to the tip by the tip's own list, and origin/main names the tip or nothing. */
function history(changed: string[], tip: Tip | null): Ancestry {
  return {
    resolveCommit: (name) =>
      name === "origin/main"
        ? (tip?.sha ?? null)
        : ([...MAIN, SIDE].find((sha) => sha.startsWith(name)) ?? null),
    isAncestor: (ancestor, descendant) => {
      const [a, d] = [MAIN.indexOf(ancestor), MAIN.indexOf(descendant)];
      return a !== -1 && d !== -1 && a <= d;
    },
    changedPaths: (from, to) => (from === to ? [] : to === tip?.sha ? tip.changed : changed),
  };
}
const linear = history(["src/cli.ts", "docs/cli.md"], null);

const prerelease = (sha: string, count: number, release = "0.0.1"): string =>
  `${release}-main.${count}.20260920.g${sha.slice(0, 7)}`;
const packument = (versions: string[], tags: Record<string, string>): Packument => ({
  versions: Object.fromEntries(versions.map((version) => [version, {}])),
  "dist-tags": tags,
});

const VERSION = prerelease(SOURCE, 2);

describe("nextPublishVerdict", () => {
  const cases: [string, Packument | null, NextVerdict][] = [
    ["never published", null, { action: "publish", version: VERSION, notices: [] }],
    [
      "already published for this sha (a rerun)",
      packument([VERSION], { next: VERSION }),
      { action: "present", version: VERSION, notices: [] },
    ],
    [
      "a descendant's pre-release already published (a stale retry)",
      packument([prerelease(OLDER, 1), prerelease(NEWEST, 4), prerelease(NEWER, 3)], {
        next: prerelease(NEWEST, 4),
      }),
      {
        action: "skip",
        version: VERSION,
        reason: `the registry already holds ${prerelease(NEWEST, 4)}, whose source ${NEWEST.slice(0, 7)} is a descendant of ${SOURCE.slice(0, 7)} on main, so this stale run publishes nothing (npm publish --tag next would move next back)`,
        notices: [],
      },
    ],
    [
      "a descendant's pre-release whose numbers sort BELOW this version (a manifest that went back)",
      packument([prerelease(NEWER, 1, "0.0.0")], { next: prerelease(NEWER, 1, "0.0.0") }),
      {
        action: "skip",
        version: VERSION,
        reason: `the registry already holds ${prerelease(NEWER, 1, "0.0.0")}, whose source ${NEWER.slice(0, 7)} is a descendant of ${SOURCE.slice(0, 7)} on main, so this stale run publishes nothing (npm publish --tag next would move next back)`,
        notices: [],
      },
    ],
    [
      "an ancestor's pre-release whose numbers sort ABOVE this version holds nothing back",
      packument([prerelease(OLDER, 9, "0.1.0")], { next: prerelease(OLDER, 9, "0.1.0") }),
      {
        action: "publish",
        version: VERSION,
        notices: [
          `one shipped file changed since next's ${prerelease(OLDER, 9, "0.1.0")} (${OLDER.slice(0, 7)}): src/cli.ts`,
        ],
      },
    ],
    [
      "only ancestors and the stable release published, with a sha the checkout lacks set aside",
      packument([prerelease(OLDER, 1), "0.0.1", "0.0.2-main.9.20260101.gabcdef0"], {
        latest: "0.0.1",
        next: prerelease(OLDER, 1),
      }),
      {
        action: "publish",
        version: VERSION,
        notices: [
          "0.0.2-main.9.20260101.gabcdef0 names abcdef0, which is no commit in this checkout; ignored",
          `one shipped file changed since next's ${prerelease(OLDER, 1)} (${OLDER.slice(0, 7)}): src/cli.ts`,
        ],
      },
    ],
  ];
  test.each(cases)("%s", (_case, registry, expected) => {
    expect(nextPublishVerdict(linear, SOURCE, VERSION, registry)).toEqual(expected);
  });
});

describe("nextPublishVerdict gates on the shipped surface since the next build", () => {
  const BASE = prerelease(OLDER, 1);
  const base7 = OLDER.slice(0, 7);
  const onRegistry = packument([BASE], { next: BASE });
  const notice = (rest: string) =>
    `next is ${rest}, so the shipped surface has nothing to be compared against; publishing`;
  const cases: [string, string[], Packument, NextVerdict, Tip | null][] = [
    [
      "a shipped file changed since next's source: publish, naming the files",
      ["docs/install.md", "package.json", "src/commands/add.ts"],
      onRegistry,
      {
        action: "publish",
        version: VERSION,
        notices: [
          `2 shipped files changed since next's ${BASE} (${base7}): package.json, src/commands/add.ts`,
        ],
      },
      null,
    ],
    [
      "only unshipped files changed since next's source: skip, naming the base",
      ["docs/install.md", "tests/release/verdict.test.ts", ".github/workflows/post-green.yml"],
      onRegistry,
      {
        action: "skip",
        version: VERSION,
        reason: `next is ${BASE}, built from ${base7}, and no shipped file changed between it and ${SOURCE.slice(0, 7)}, so nothing is published`,
        notices: [],
      },
      null,
    ],
    [
      "next was built from this very sha under another version: skip, like a rerun",
      ["src/cli.ts"],
      packument([prerelease(SOURCE, 7)], { next: prerelease(SOURCE, 7) }),
      {
        action: "skip",
        version: VERSION,
        reason: `next is ${prerelease(SOURCE, 7)}, built from ${SOURCE.slice(0, 7)}, and no shipped file changed between it and ${SOURCE.slice(0, 7)}, so nothing is published`,
        notices: [],
      },
      null,
    ],
    [
      "next names a sha the checkout lacks (a shallow clone, an unpublished source): publish",
      [],
      packument(["0.0.2-main.9.20260101.gabcdef0"], { next: "0.0.2-main.9.20260101.gabcdef0" }),
      {
        action: "publish",
        version: VERSION,
        notices: [
          "0.0.2-main.9.20260101.gabcdef0 names abcdef0, which is no commit in this checkout; ignored",
          notice(
            "0.0.2-main.9.20260101.gabcdef0, whose source abcdef0 is no commit in this checkout",
          ),
        ],
      },
      null,
    ],
    [
      "next names a source off this run's line of main: publish",
      [],
      packument([prerelease(SIDE, 3)], { next: prerelease(SIDE, 3) }),
      {
        action: "publish",
        version: VERSION,
        notices: [
          `${prerelease(SIDE, 3)} names ${SIDE.slice(0, 7)}, which is neither an ancestor nor a descendant of ${SOURCE.slice(0, 7)} on main; ignored`,
          notice(
            `${prerelease(SIDE, 3)}, whose source ${SIDE.slice(0, 7)} is not an ancestor of ${SOURCE.slice(0, 7)} on main`,
          ),
        ],
      },
      null,
    ],
    [
      "next is unset (the first publish took latest alone): publish",
      [],
      packument(["0.0.1"], { latest: "0.0.1" }),
      { action: "publish", version: VERSION, notices: [notice("unset")] },
      null,
    ],
    [
      "next names a release, which carries no source sha: publish",
      [],
      packument(["0.0.1"], { latest: "0.0.1", next: "0.0.1" }),
      {
        action: "publish",
        version: VERSION,
        notices: [notice("0.0.1, which names no source commit")],
      },
      null,
    ],
    [
      "main's tip has undone this run's shipped change (the tip's run skipped first): skip",
      ["src/cli.ts"],
      onRegistry,
      {
        action: "skip",
        version: VERSION,
        reason: `next is ${BASE}, built from ${base7}, and main's tip ${NEWEST.slice(0, 7)} ships what it ships: ${SOURCE.slice(0, 7)} changed src/cli.ts and main has since undone it, so nothing is published`,
        notices: [],
      },
      { sha: NEWEST, changed: ["docs/install.md"] },
    ],
    [
      "main's tip carries this run's shipped change on: publish",
      ["src/cli.ts"],
      onRegistry,
      {
        action: "publish",
        version: VERSION,
        notices: [`one shipped file changed since next's ${BASE} (${base7}): src/cli.ts`],
      },
      { sha: NEWEST, changed: ["src/cli.ts", "docs/install.md"] },
    ],
    [
      "main's tip is this run's source: publish",
      ["src/cli.ts"],
      onRegistry,
      {
        action: "publish",
        version: VERSION,
        notices: [`one shipped file changed since next's ${BASE} (${base7}): src/cli.ts`],
      },
      { sha: SOURCE, changed: ["src/cli.ts"] },
    ],
    [
      "main's tip is not a descendant of this run's source (a force push): publish",
      ["src/cli.ts"],
      onRegistry,
      {
        action: "publish",
        version: VERSION,
        notices: [`one shipped file changed since next's ${BASE} (${base7}): src/cli.ts`],
      },
      { sha: SIDE, changed: [] },
    ],
  ];
  test.each(cases)("%s", (_case, changed, registry, expected, tip) => {
    expect(nextPublishVerdict(history(changed, tip), SOURCE, VERSION, registry)).toEqual(expected);
  });
});

describe("stablePublishVerdict", () => {
  const cases: [string, string, Packument | null, PublishVerdict][] = [
    ["never published", "1.0.0", null, { action: "publish", version: "1.0.0" }],
    [
      "the version is already on the registry (a rerun)",
      "1.0.0",
      packument(["1.0.0"], { latest: "1.0.0" }),
      { action: "present", version: "1.0.0" },
    ],
    [
      "latest is a newer release (an older release's job rerun later)",
      "1.0.1",
      packument(["1.0.0", "1.1.0"], { latest: "1.1.0" }),
      {
        action: "skip",
        version: "1.0.1",
        reason:
          "the registry's latest is 1.1.0, newer than 1.0.1, so this rerun of an older release publishes nothing (npm publish would move latest back)",
      },
    ],
    [
      "latest is a pre-release (the bootstrap publish took it), so the first release takes it over",
      "0.0.1",
      packument([VERSION], { latest: VERSION, next: VERSION }),
      { action: "publish", version: "0.0.1" },
    ],
    [
      "latest is an older release",
      "1.1.0",
      packument(["1.0.0"], { latest: "1.0.0" }),
      { action: "publish", version: "1.1.0" },
    ],
    [
      "latest is a newer release whose minor sorts below this one's as a string",
      "1.2.0",
      packument(["1.1.0", "1.10.0"], { latest: "1.10.0" }),
      {
        action: "skip",
        version: "1.2.0",
        reason:
          "the registry's latest is 1.10.0, newer than 1.2.0, so this rerun of an older release publishes nothing (npm publish would move latest back)",
      },
    ],
    [
      "latest is an older release whose minor sorts above this one's as a string",
      "1.10.0",
      packument(["1.9.0"], { latest: "1.9.0" }),
      { action: "publish", version: "1.10.0" },
    ],
  ];
  test.each(cases)("%s", (_case, version, registry, expected) => {
    expect(stablePublishVerdict(version, registry)).toEqual(expected);
  });

  test("a latest this pipeline did not mint stops the run instead of being ordered", () => {
    expect(() =>
      stablePublishVerdict("1.0.0", packument(["0.9.0"], { latest: "0.9.0-beta.1" })),
    ).toThrow(/not a version this pipeline mints/);
  });
});

describe("parsePackument", () => {
  test.each([
    ["a null body", null],
    ["an array", []],
    ["a string", "{}"],
    ["no versions record", { "dist-tags": {} }],
    ["versions as an array", { versions: [], "dist-tags": {} }],
    ["no dist-tags record", { versions: {} }],
    [
      "a dist-tag whose value is not a version string",
      { versions: {}, "dist-tags": { latest: 1 } },
    ],
  ])("rejects %s as unreadable", (_case, body) => {
    expect(() => parsePackument(body, "the record")).toThrow(UnreadablePackument);
  });

  test("reads the two records out of a full registry answer", () => {
    const body = {
      name: "@vivswan/maxims",
      versions: { "1.0.0": { dist: {} } },
      "dist-tags": { latest: "1.0.0" },
      time: {},
    };
    expect(parsePackument(body, "the record")).toMatchObject({
      versions: { "1.0.0": { dist: {} } },
      "dist-tags": { latest: "1.0.0" },
    });
  });
});

describe("confirmPublish", () => {
  function confirm(
    channel: Channel,
    version: string,
    reads: (Packument | null | Error)[],
    attempts = 3,
  ) {
    let pauses = 0;
    let read = 0;
    return confirmPublish({
      channel,
      name: "@vivswan/maxims",
      version,
      sourceSha: SOURCE,
      ancestry: linear,
      readPackument: async () => {
        const answer = reads[Math.min(read++, reads.length - 1)];
        if (answer instanceof Error) {
          throw answer;
        }
        return answer;
      },
      attempts,
      pause: async () => {
        pauses++;
      },
    }).then((verdict) => ({ verdict, pauses }));
  }

  test("holds the lane through reads that lack the version or fail, and settles once it shows", async () => {
    const shown = packument([VERSION], { next: VERSION });
    expect(await confirm("next", VERSION, [null, new Error("503"), shown])).toEqual({
      verdict: { outcome: "settled", version: VERSION, reads: 3 },
      pauses: 2,
    });
  });

  test("reports a record that never shows the version once the budget is spent", async () => {
    const { verdict, pauses } = await confirm("next", VERSION, [
      packument(["0.0.1"], { latest: "0.0.1" }),
    ]);
    expect(verdict).toMatchObject({ outcome: "unsettled", version: VERSION });
    expect(pauses).toBe(2);
  });

  test("a read that fails on the last attempt is the failure reported", async () => {
    await expect(confirm("next", VERSION, [new Error("registry down")], 2)).rejects.toThrow(
      "registry down",
    );
  });

  test("an unreadable record stops the run at once, whatever the budget", async () => {
    const shown = packument([VERSION], { next: VERSION });
    await expect(
      confirm("next", VERSION, [new UnreadablePackument("not a packument"), shown], 5),
    ).rejects.toThrow("not a packument");
  });

  const tags: [string, Channel, string, Packument, ConfirmVerdict["outcome"]][] = [
    [
      "next names this run's version while a descendant's pre-release is on the record",
      "next",
      VERSION,
      packument([VERSION, prerelease(NEWER, 3)], { next: VERSION }),
      "behind",
    ],
    [
      "next names an ancestor's pre-release",
      "next",
      VERSION,
      packument([prerelease(OLDER, 1), VERSION], { next: prerelease(OLDER, 1) }),
      "behind",
    ],
    ["next is unset", "next", VERSION, packument([VERSION], { latest: VERSION }), "behind"],
    [
      "next names the descendant's pre-release",
      "next",
      VERSION,
      packument([VERSION, prerelease(NEWER, 3)], { next: prerelease(NEWER, 3) }),
      "settled",
    ],
    [
      "latest names an older release than the one just published",
      "stable",
      "1.1.0",
      packument(["1.0.0", "1.1.0"], { latest: "1.0.0" }),
      "behind",
    ],
    [
      "latest names a newer release than the one just published",
      "stable",
      "1.1.0",
      packument(["1.1.0", "1.2.0"], { latest: "1.2.0" }),
      "settled",
    ],
    [
      "latest names an older release whose minor sorts above the published one's as a string",
      "stable",
      "1.10.0",
      packument(["1.9.0", "1.10.0"], { latest: "1.9.0" }),
      "behind",
    ],
  ];
  test.each(tags)("judges the dist-tag: %s", async (_case, channel, version, shown, outcome) => {
    const { verdict } = await confirm(channel, version, [shown]);
    expect(verdict.outcome).toBe(outcome);
  });
});
