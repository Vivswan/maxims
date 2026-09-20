// Fails if a publish verdict stops reading the registry the way the two lanes rely on: a stale run must never
// move next or latest back, a rerun must publish nothing, and a record this pipeline cannot read must stop the
// run rather than pass for an empty registry. The history is hand-built, so the cases hold without git or network.
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

/** A linear main: index order is commit order, and every sha7 is unique. */
const MAIN = ["1000001", "2000002", "3000003", "4000004"].map((sha7) => sha7 + "e".repeat(33));
const [OLDER, SOURCE, NEWER, NEWEST] = MAIN as [string, string, string, string];

const linear: Ancestry = {
  resolveCommit: (name) => MAIN.find((sha) => sha.startsWith(name)) ?? null,
  isAncestor: (ancestor, descendant) => {
    const [a, d] = [MAIN.indexOf(ancestor), MAIN.indexOf(descendant)];
    return a !== -1 && d !== -1 && a <= d;
  },
};

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
      { action: "publish", version: VERSION, notices: [] },
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
        ],
      },
    ],
  ];
  test.each(cases)("%s", (_case, registry, expected) => {
    expect(nextPublishVerdict(linear, SOURCE, VERSION, registry)).toEqual(expected);
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
      name: "maxims",
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
      name: "maxims",
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
