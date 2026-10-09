// Each drift below would be silent without this file, since nothing else reads a source's claims.
//
//   a claim holds inside a longer word          -> `hooks` holds on `webhooks` after the hooks section is gone
//   markup is misread                           -> a claim holds on script-embedded data, or a reader's word vanishes
//   a sidebar leaks into the words              -> a claim holds on a nav link to the page that lost the fact
//   a pointer resolves through a missing key    -> a schema that dropped a setting still reads as match
//   a source the run never read passes          -> a vendor block on the user agent turns the run green
//   a run with nothing to verify passes         -> an empty registry reads as every source matching
//   one source of several drifts                -> its definition still counts as a match
//   a repository file is fetched elsewhere      -> a claim is read off a page that is not the named file
//   the fix instruction changes                 -> the remedy a reader follows disappears
import { describe, expect, test } from "bun:test";
import {
  claimPresent,
  mediaOf,
  normalizeDocument,
  resolvePointer,
  runHarnessDrift,
  type VerifiedDefinition,
} from "../../scripts/nightly/harness_drift.ts";
import type { Outcome } from "../../scripts/nightly/report.ts";
import type { PointerCheck, VerifiedSource } from "../../src/harnesses/contract.ts";

const PAGE = [
  "<!DOCTYPE html>",
  "<html><head><title>Hooks &amp; rules</title>",
  '<script>window.__BUILD_ID__ = "build-1234";</script>',
  "<style>.x { color: red; }</style></head>",
  "<body>",
  "  <h1>Session   hooks</h1>",
  "  <p>Run <code>maxims sync</code> on <b>SessionStart</b>&nbsp;&amp; write",
  "  <code>&lt;slug&gt;.md</code>; it&#39;s fast.</p>",
  '  <script type="module">console.log("nonce-abc")</script>',
  "</body></html>",
  "",
].join("\n");

const NORMALIZED =
  "Hooks & rules Session hooks Run maxims sync on SessionStart & write <slug>.md; it's fast.";

describe("normalizeDocument", () => {
  test("pins the words a reader sees for a fixed page", () => {
    expect(normalizeDocument(PAGE, "html")).toBe(NORMALIZED);
  });

  // Documentation sites stamp a build id or a nonce into their scripts on every deploy, and some
  // embed the page's own data as JSON there; a claim that could read script bodies would hold on
  // an identifier no reader was shown.
  test("script bodies are not words, so a new build id leaves them unchanged", () => {
    const redeployed = PAGE.replace("build-1234", "build-5678").replace("nonce-abc", "nonce-xyz");
    expect(normalizeDocument(redeployed, "html")).toBe(NORMALIZED);
    expect(claimPresent(normalizeDocument(PAGE, "html"), "build-1234")).toBe(false);
  });

  // Markup a tag-stripping regex misreads: a ">" inside an attribute value ends the tag early and
  // leaks the rest as words, a bare "<" in prose swallows the words after it as a tag, and the
  // text browsers show only without scripts is kept although no reader with scripts sees it.
  // Then markup node-html-parser misreads with its defaults: a pre block's inner tags count as
  // text, a doctype rides along as text or takes the words next to it, a raw-text element whose
  // end tag differs in case or carries a space before ">" swallows the rest of the page, and two
  // block elements with no whitespace between them glue their words into one, so `SessionStart`
  // in its own paragraph or table cell would read as part of a longer word and never hold.
  test.each([
    ['<p>See <a title="a > b">the link</a> here.</p>', "See the link here."],
    ["<p>if a < b then c</p>", "if a < b then c"],
    ["<p>a </p><noscript>enable js</noscript><p> b</p>", "a b"],
    ['<pre><code class="language-sh">maxims sync</code></pre>', "maxims sync"],
    ["<!DOCTYPE html>Hello <b>world</b>", "Hello world"],
    ["\n<!DOCTYPE html><p>hello</p>", "hello"],
    ["<SCRIPT>1</script><p>hello</p>", "hello"],
    ["<script>1</script ><p>hello</p>", "hello"],
    ["<p>SessionStart</p><p>SessionEnd</p>", "SessionStart SessionEnd"],
    ["<table><tr><td>a</td><td>b</td></tr></table>", "a b"],
    ["<p>x <code>y</code>z <span>w</span>v</p>", "x yz wv"],
    ["<p>write\n  <code>&lt;slug&gt;.md</code></p>", "write <slug>.md"],
  ])("reads %s as the words a reader sees", (html, words) => {
    expect(normalizeDocument(html, "html")).toBe(words);
  });

  // A site's sidebar lists every page, so a claim such as `hooks` would hold on the nav link to a
  // page that lost its hooks section. The two-main row is a site that prints a second copy of its
  // content for the print layout.
  test.each([
    ["<nav>Docs Rules Hooks</nav><main><p>Rules</p></main><footer>(c) 2026</footer>", "Rules"],
    ["<nav>Docs</nav><main><article><p>Rules</p></article></main>", "Rules"],
    ["<aside>Docs</aside><main><p>Rules</p></main><main><p>Rules</p></main>", "Rules"],
    ["<nav>Docs</nav><article><p>Rules</p></article>", "Rules"],
    ['<nav>Docs</nav><div role="main"><p>Rules</p></div>', "Rules"],
    ["<nav>Docs</nav>\n<p>Rules</p>", "Docs Rules"],
  ])("reads only the content element of %s", (html, words) => {
    expect(normalizeDocument(html, "html")).toBe(words);
  });

  // A raw file served as text is never parsed, so a `main` tag quoted in one of its code fences
  // cannot become the content element and hide the rest of the file.
  test("a markdown file is read as the text it is", () => {
    const markdown = "# Hooks\n\nRun on SessionStart.\n\n```html\n<main>Example</main>\n```\n";
    expect(normalizeDocument(markdown, "text")).toBe(
      "# Hooks Run on SessionStart. ```html <main>Example</main> ```",
    );
  });
});

// What each vendor serves: the HTML sites with and without a charset, and GitHub's raw files as
// plain text. An unknown or missing type is read as text because parsing it could hide words.
test.each([
  ["text/html; charset=utf-8", "html"],
  ["text/html", "html"],
  ["application/xhtml+xml", "html"],
  ["text/plain; charset=utf-8", "text"],
  ["text/markdown", "text"],
  [null, "text"],
])("mediaOf(%s) is %s", (contentType, media) => {
  expect<string>(mediaOf(contentType)).toBe(media);
});

// The boundary rule is what keeps a claim honest: `hooks` must not hold on `webhooks`, `hook` not
// on `hooks`, and `rules` not on `.clinerules`, while a claim that ends in punctuation needs no
// boundary there. The impossible token is the negative control for the matcher itself.
const WORDS =
  "Put rules in .claude/rules/ and set alwaysApply: true; webhooks and pre-hooks differ from hooks. " +
  "Keep $DSH_HOME/cordis.patch.yml under 65,536-byte budgets.";

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
    ["an impossible token", "zzImpossibleToken414", false],
  ])("%s: %j reads %p", (_case, claim, present) => {
    expect(claimPresent(WORDS, claim)).toBe(present);
  });

  test("a claim holds across a line break the normalization collapsed", () => {
    expect(
      claimPresent(normalizeDocument("<p>Session\n   hooks</p>", "html"), "Session hooks"),
    ).toBe(true);
  });
});

// RFC 6901 as a published schema needs it: a dotted key such as `amp.mcpServers` is one token, a
// slash inside a key is escaped as `~1`, and an array is entered only by a canonical index.
const SCHEMA = {
  properties: {
    "amp.mcpServers": { type: "object" },
    "a/b": { type: "string" },
    hooks: { items: [{ const: "SessionStart" }, { const: "SessionEnd" }] },
  },
};

test.each([
  ["/properties/amp.mcpServers", { found: true, value: { type: "object" } }],
  ["/properties/amp.mcpServers/type", { found: true, value: "object" }],
  ["/properties/a~1b", { found: true, value: { type: "string" } }],
  ["/properties/hooks/items/1/const", { found: true, value: "SessionEnd" }],
  ["/properties/hooks/items/01", { found: false }],
  ["/properties/hooks/items/2", { found: false }],
  ["/properties/webhooks", { found: false }],
  ["/properties/amp", { found: false }],
  ["/properties/amp.mcpServers/type/length", { found: false }],
] as const)("resolvePointer(%s) is %j", (pointer, resolved) => {
  expect(resolvePointer(SCHEMA, pointer)).toEqual(resolved);
});

const RAW = "# Hooks\n\nThe `TaskStart` file runs on each task.\n\n<main>quoted</main>\n";
const HTML = { headers: { "content-type": "text/html; charset=utf-8" } };
const TEXT = { headers: { "content-type": "text/plain; charset=utf-8" } };
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

const notJson = (): string => {
  try {
    JSON.parse("<p>moved</p>");
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
  throw new Error("expected JSON.parse to refuse markup");
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
    [url("stable")]: () => new Response(PAGE, HTML),
    [RAW_URL]: () => new Response(RAW, TEXT),
    [url("settings.json")]: () => new Response(JSON.stringify(SCHEMA), JSON_TYPE),
    [url("moved")]: () => new Response("<nav>Docs SessionStart</nav><main>moved</main>", HTML),
    [url("gone")]: () => new Response("", { status: 503 }),
    [url("slow")]: timeoutError,
    [url("schema-moved")]: () => new Response("<p>moved</p>", HTML),
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
    "definition or its claims to what the source states now, and set that definition's " +
    "`verifiedAgainst.date` to today. An UNREACHABLE row shows the answer the source gave in place " +
    "of its content: the run read nothing of that source, so it fails until the source reads again " +
    "or the definition points at one that does. The run passes only when every claim of every " +
    "source of every definition holds.";
  const failed = (headline: string, rows: string): Outcome => ({
    status: "fail",
    summary: `${heading}\n\n${headline}\n\n${rows}\n`,
    report: {
      title: "Harness documentation drift",
      body: `${headline}\n\n${rows}\n\n${fix}\n`,
    },
  });

  // One source of each kind, every claim holding: the page's claims against the parsed words, the
  // file's against the raw text fetched from the named repo, ref and path, the schema's pointers
  // against the parsed JSON.
  test("a run where every claim of every kind holds passes with the table in the summary", async () => {
    const outcome = await runHarnessDrift(
      [
        def("stable", page("stable", ["SessionStart", "<slug>.md", "Session hooks"])),
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
  // for good. A schema URL that answers markup read nothing of the schema either.
  test.each([
    ["gone", page("gone", ["SessionStart"]), "page", "HTTP 503"],
    ["slow", page("slow", ["SessionStart"]), "page", "timeout after 20 s"],
    [
      "offline",
      page("offline", ["SessionStart"]),
      "page",
      "network error: getaddrinfo ENOTFOUND example.com",
    ],
    ["schema-moved", schema("schema-moved", ["/properties"]), "schema", `not JSON: ${notJson()}`],
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

  // The moved page keeps `SessionStart` only in its sidebar, so the claim must not hold there; the
  // schema lost one of two settings and types another differently; the raw file never had the
  // third claim. Each row names what is missing, and the definition that also has a matching
  // source still fails.
  test("a missing claim fails the definition and its row names the claims and pointers that are gone", async () => {
    const outcome = await runHarnessDrift(
      [
        def(
          "multi",
          page("stable", ["SessionStart"]),
          page("moved", ["SessionStart", "moved", "hooks.json"], "the hook event"),
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
      ],
      fakeFetch(answers),
    );
    const headline = [
      "3 definitions: 0 match, 3 drift, 0 unreachable",
      "5 sources: 1 match, 3 drift, 1 unreachable",
    ].join("\n");
    const rows = table([
      row("multi", "page", url("stable"), "match", "1 claims hold"),
      row(
        "multi",
        "page",
        url("moved"),
        "DRIFT",
        "missing: `SessionStart`, `hooks.json`",
        "the hook event",
      ),
      row(
        "schema",
        "schema",
        url("settings.json"),
        "DRIFT",
        'missing: `/properties/webhooks`; `/properties/a~1b/type` is "string", not "object"',
      ),
      row("partial", "file", RAW_URL, "DRIFT", "missing: `Task Start`, `SessionStart`"),
      row("partial", "page", url("gone"), "UNREACHABLE", "HTTP 503"),
    ]);
    expect(outcome).toEqual(failed(headline, rows));
  });
});
