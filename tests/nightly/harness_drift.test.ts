// Each drift below would be silent without this file, since nothing else reads a source's claims.
//
//   a claim holds inside a longer word          -> `hooks` holds on `webhooks` after the hooks section is gone
//   a line break splits a claim                 -> a fact wrapped across two lines reads as absent
//   a pointer resolves through a missing key    -> a schema that dropped a setting still reads as match
//   a pointer resolves through the prototype    -> an empty schema answers `/toString` as match
//   a source the run never read passes          -> a vendor block on the user agent turns the run green
//   a moved source passes                       -> a landing page at the new URL holds a claim by accident
//   a run with nothing to verify passes         -> an empty registry reads as every source matching
//   one source of several drifts                -> its definition still counts as a match
//   a repository file is fetched elsewhere      -> a claim is read off a page that is not the named file
//   a missing claim breaks the table            -> a backtick in the claim ends the cell's fence early
//   the fix instruction changes                 -> the remedy a reader follows disappears
import { describe, expect, test } from "bun:test";
import {
  claimPresent,
  normalizeText,
  runHarnessDrift,
  type VerifiedDefinition,
} from "../../scripts/nightly/harness_drift.ts";
import type { Outcome } from "../../scripts/nightly/report.ts";
import type { PointerCheck, VerifiedSource } from "../../src/harnesses/contract.ts";

// A markdown rendition as a vendor serves it: a fact wrapped across lines, a code fence quoting
// markup, so the text is read as it is and only its whitespace runs collapse.
const PAGE = [
  "# Hooks",
  "",
  "Run `maxims sync` on SessionStart",
  "  and write `<slug>.md`; it's fast.",
  "",
  "```html",
  "<main>Example</main>",
  "```",
  "",
].join("\n");

const NORMALIZED =
  "# Hooks Run `maxims sync` on SessionStart and write `<slug>.md`; it's fast. ```html <main>Example</main> ```";

test("normalizeText pins the text a claim is matched against for a fixed page", () => {
  expect(normalizeText(PAGE)).toBe(NORMALIZED);
});

// The boundary rule is what keeps a claim honest: `hooks` must not hold on `webhooks`, `hook` not
// on `hooks`, and `rules` not on `.clinerules`, while a claim that ends in punctuation needs no
// boundary there. `axb` is the negative control for the escaping: an unescaped `a.b` would hold
// on it. The impossible token is the negative control for the matcher itself.
const WORDS =
  "Put rules in .claude/rules/ and set alwaysApply: true; webhooks and pre-hooks differ from hooks. " +
  "Keep $DSH_HOME/cordis.patch.yml under 65,536-byte budgets, axb.";

describe("claimPresent", () => {
  test.each([
    ["a phrase", "set alwaysApply: true", true],
    ["a path ending in a word character", ".claude/rules", true],
    ["a key ending in punctuation", "alwaysApply:", true],
    ["a whitespace run in the claim", "set\n  alwaysApply:", true],
    ["a literal dollar and dots", "$DSH_HOME/cordis.patch.yml", true],
    ["a limit with a comma", "65,536-byte", true],
    ["a word inside a longer word", "ebhooks", false],
    ["a word that ends a longer word", "rules.", false],
    ["a shorter word than the text's", "hook", false],
    ["a word the text joins with a hyphen", "hooks differ", false],
    ["a word before a hyphen", "pre", false],
    ["a word the text ends with", "differ from hooks", true],
    ["a regex metacharacter read literally", "a.b", false],
    ["the same letters without the metacharacter", "axb", true],
    ["an impossible token", "zzImpossibleToken414", false],
  ])("%s: %j reads %p", (_case, claim, present) => {
    expect(claimPresent(WORDS, claim)).toBe(present);
  });

  test("a claim holds across a line break the normalization collapsed", () => {
    expect(claimPresent(normalizeText(PAGE), "SessionStart and write")).toBe(true);
  });
});

// A published schema as the pointers must read it: a dotted key such as `amp.mcpServers` is one
// token, a slash inside a key is escaped as `~1`, and a value check compares what the key holds.
const SCHEMA = {
  properties: {
    "amp.mcpServers": { type: "object" },
    "a/b": { type: "string" },
    hooks: { items: [{ const: "SessionStart" }, { const: "SessionEnd" }] },
  },
};

const RAW = "# Hooks\n\nThe `TaskStart` file runs on each task.\n\n<main>quoted</main>\n";
const TEXT = { headers: { "content-type": "text/plain; charset=utf-8" } };
const HTML = { headers: { "content-type": "text/html; charset=utf-8" } };
const JSON_TYPE = { headers: { "content-type": "application/json" } };

function fakeFetch(answers: Record<string, () => Response | Promise<Response>>): typeof fetch {
  const impl = async (input: string | URL | Request): Promise<Response> => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const answer = answers[url];
    if (answer === undefined) throw new Error(`getaddrinfo ENOTFOUND ${new URL(url).host}`);
    return answer();
  };
  return impl as typeof fetch;
}

const timeoutError = (): never => {
  const error = new Error("The operation timed out.");
  error.name = "TimeoutError";
  throw error;
};

describe("runHarnessDrift", () => {
  const url = (name: string): string => `https://example.com/${name}`;
  const RAW_URL = "https://raw.githubusercontent.com/example/agent/main/docs/hooks.md";
  const page = (name: string, claims: [string, ...string[]], note?: string): VerifiedSource => ({
    kind: "page",
    url: url(name),
    claims,
    why: "a fixture",
    ...(note === undefined ? {} : { note }),
  });
  const file = (claims: [string, ...string[]], note?: string): VerifiedSource => ({
    kind: "file",
    repo: "example/agent",
    ref: "main",
    path: "docs/hooks.md",
    claims,
    ...(note === undefined ? {} : { note }),
  });
  const schema = (
    name: string,
    paths: [PointerCheck, ...PointerCheck[]],
    note?: string,
  ): VerifiedSource => ({
    kind: "schema",
    url: url(name),
    paths,
    ...(note === undefined ? {} : { note }),
  });
  const def = (
    id: string,
    first: VerifiedSource,
    ...rest: VerifiedSource[]
  ): VerifiedDefinition => ({ id, verifiedAgainst: { sources: [first, ...rest] } });
  const answers = {
    [url("stable")]: () => new Response(PAGE, TEXT),
    [RAW_URL]: () => new Response(RAW, TEXT),
    [url("settings.json")]: () => new Response(JSON.stringify(SCHEMA), JSON_TYPE),
    [url("moved")]: () => new Response("# Moved\n\nThis page moved; see the hooks page.\n", TEXT),
    [url("gone")]: () => new Response("", { status: 503 }),
    [url("slow")]: timeoutError,
    [url("relocated")]: () =>
      new Response(null, { status: 301, headers: { location: "/docs/new-hooks" } }),
    [url("stale")]: () => new Response(null, { status: 304 }),
    [url("rendered")]: () => new Response("<nav>SessionStart</nav>", HTML),
    [url("schema-moved")]: () => new Response("<p>moved</p>", TEXT),
    [url("schema-null")]: () => new Response("null", JSON_TYPE),
    [url("schema-array")]: () => new Response("[]", JSON_TYPE),
    [url("schema-empty")]: () => new Response("{}", JSON_TYPE),
  };
  const table = (rows: string[]): string =>
    ["| id | kind | source | note | verdict | result |", "|---|---|---|---|---|---|", ...rows].join(
      "\n",
    );
  const row = (
    id: string,
    kind: string,
    source: string,
    verdict: string,
    result: string,
    note = "-",
  ) => `| ${id} | ${kind} | ${source} | ${note} | ${verdict} | ${result} |`;
  const heading = "## Harness documentation drift";
  const fix =
    "To clear a DRIFT row: open the source, re-verify the definition's facts it justifies, fix the " +
    "definition or its claims and pointers to what the source states now, and set that definition's " +
    "`verifiedAgainst.date` to today. An UNREACHABLE row shows the answer the source gave in place " +
    "of its content: the run read nothing of that source, so it fails until the source reads again " +
    "or the definition points at one that does. The run passes only when every claim and pointer of " +
    "every source of every definition holds.";
  const failed = (headline: string, rows: string): Outcome => ({
    status: "fail",
    summary: `${heading}\n\n${headline}\n\n${rows}\n`,
    report: {
      title: "Harness documentation drift",
      body: `${headline}\n\n${rows}\n\n${fix}\n`,
    },
  });

  // One source of each kind, every claim holding: the page's claims against its text, the file's
  // against the raw text fetched from the named repo, ref and path, the schema's pointers against
  // the parsed JSON.
  test("a run where every claim of every kind holds passes with the table in the summary", async () => {
    const outcome = await runHarnessDrift(
      [
        def("stable", page("stable", ["SessionStart", "`<slug>.md`", "maxims sync"])),
        def("raw", file(["TaskStart", "<main>quoted</main>"], "the hook file")),
        def(
          "schema",
          schema("settings.json", [
            "/properties/amp.mcpServers",
            "/properties/a~1b",
            { pointer: "/properties/amp.mcpServers/type", equals: "object" },
          ]),
        ),
      ],
      fakeFetch(answers),
    );
    expect(outcome).toEqual({
      status: "pass",
      summary: [
        heading,
        "",
        "3 definitions: 3 match, 0 drift, 0 unreachable",
        "3 sources: 3 match, 0 drift, 0 unreachable",
        "",
        table([
          row("stable", "page", url("stable"), "match", "3 claims hold"),
          row("raw", "file", RAW_URL, "match", "2 claims hold", "the hook file"),
          row("schema", "schema", url("settings.json"), "match", "3 pointers resolve"),
        ]),
        "",
      ].join("\n"),
    });
  });

  // Every way a run can fail to read a source, each as the one source of its run, so none hides
  // behind another's failure. Without this the run stays green on sources it never read, and a
  // vendor that starts answering 403 to the nightly's user agent turns the whole category green
  // for good. A redirect is a move the row must show, since the landing page at the new URL could
  // hold a claim by accident; so is a page that answers rendered HTML, whose nav text would hold a
  // claim written against its markdown rendition. A schema URL that answers markup, or a JSON
  // document with no keys to point into (null, an array), read nothing of the schema either.
  test.each([
    ["gone", page("gone", ["SessionStart"]), "page", "HTTP 503"],
    ["slow", page("slow", ["SessionStart"]), "page", "timeout after 20 s"],
    [
      "offline",
      page("offline", ["SessionStart"]),
      "page",
      "network error: getaddrinfo ENOTFOUND example.com",
    ],
    [
      "relocated",
      page("relocated", ["SessionStart"]),
      "page",
      "moved to https://example.com/docs/new-hooks",
    ],
    ["stale", page("stale", ["SessionStart"]), "page", "HTTP 304"],
    ["rendered", page("rendered", ["SessionStart"]), "page", "answered text/html"],
    [
      "schema-moved",
      schema("schema-moved", ["/properties"]),
      "schema",
      "not JSON: InvalidSymbol at offset 0",
    ],
    ["schema-null", schema("schema-null", ["/properties"]), "schema", "not a JSON object: null"],
    ["schema-array", schema("schema-array", [""]), "schema", "not a JSON object: []"],
  ] as const)(
    "the %s source, which the run could not read, fails the run with its answer in its row",
    async (name, source, kind, result) => {
      const outcome = await runHarnessDrift([def(name, source)], fakeFetch(answers));
      const counts = "0 match, 0 drift, 1 unreachable";
      const headline = `1 definitions: ${counts}\n1 sources: ${counts}`;
      const rows = table([row(name, kind, url(name), "UNREACHABLE", result)]);
      expect(outcome).toEqual(failed(headline, rows));
    },
  );

  // A run that judged nothing has no row to go red, so without this it is the one run that can
  // never fail: an emptied registry reads as all matching.
  test("a run with no definitions fails", async () => {
    const outcome = await runHarnessDrift([], fakeFetch({}));
    const headline = [
      "0 definitions: 0 match, 0 drift, 0 unreachable",
      "0 sources: 0 match, 0 drift, 0 unreachable",
    ];
    expect(outcome).toEqual(failed(headline.join("\n"), table([])));
  });

  // The moved page lost `SessionStart` and the backticked file name; the schema lost one of two
  // settings and types another differently; the raw file never had the third claim; the empty
  // schema has no `toString` key, whatever the parsed object inherits. Each row names what is
  // missing as a JSON string, so a claim's own backticks cannot end the cell's fence, and the
  // definition that also has a matching source still fails.
  test("a missing claim fails the definition and its row names the claims and pointers that are gone", async () => {
    const outcome = await runHarnessDrift(
      [
        def(
          "multi",
          page("stable", ["SessionStart"]),
          page("moved", ["SessionStart", "moved", "`hooks.json`"], "the hook event"),
        ),
        def(
          "schema",
          schema("settings.json", [
            "/properties/hooks",
            "/properties/webhooks",
            { pointer: "/properties/a~1b/type", equals: "object" },
          ]),
        ),
        def("partial", file(["TaskStart", "Task Start", "SessionStart"]), page("gone", ["x"])),
        def("inherited", schema("schema-empty", ["/toString"])),
      ],
      fakeFetch(answers),
    );
    const headline = [
      "4 definitions: 0 match, 4 drift, 0 unreachable",
      "6 sources: 1 match, 4 drift, 1 unreachable",
    ].join("\n");
    const rows = table([
      row("multi", "page", url("stable"), "match", "1 claims hold"),
      row(
        "multi",
        "page",
        url("moved"),
        "DRIFT",
        'missing: "SessionStart", "`hooks.json`"',
        "the hook event",
      ),
      row(
        "schema",
        "schema",
        url("settings.json"),
        "DRIFT",
        'missing: "/properties/webhooks"; "/properties/a~1b/type" is "string", not "object"',
      ),
      row("partial", "file", RAW_URL, "DRIFT", 'missing: "Task Start", "SessionStart"'),
      row("partial", "page", url("gone"), "UNREACHABLE", "HTTP 503"),
      row("inherited", "schema", url("schema-empty"), "DRIFT", 'missing: "/toString"'),
    ]);
    expect(outcome).toEqual(failed(headline, rows));
  });
});
