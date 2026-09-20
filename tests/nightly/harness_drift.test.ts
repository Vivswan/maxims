// Fails if a definition lands without its baseline hash, so the nightly could never see its page
// move, or if the normalization behind every stored hash changes, which would repaint all
// fourteen as drift in one night, or if it misreads markup so a page's own words go missing or
// unseen script text gets counted; also if a fetch failure or a missing hash turns the table the
// issue shows red instead of unverifiable, or if the fill instruction stops showing the fetched
// hash an author pastes in.
import { describe, expect, test } from "bun:test";
import {
  normalizeDocument,
  runHarnessDrift,
  type VerifiedPage,
} from "../../scripts/nightly/harness_drift.ts";
import { HARNESSES } from "../../src/harnesses/registry.ts";
import { type ContentHash, contentHashOf } from "../../src/memory/contract.ts";

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
const PAGE_HASH = contentHashOf(NORMALIZED);

describe("normalizeDocument", () => {
  test("pins the normalized text and its hash for a fixed page", () => {
    expect(normalizeDocument(PAGE)).toBe(NORMALIZED);
    expect<string>(PAGE_HASH).toBe(
      "sha256:250b9c5827a7d9789921817c234d05933e4a4b1561c1cdd05bda81565741d4e2",
    );
    expect(contentHashOf(normalizeDocument(PAGE))).toBe(PAGE_HASH);
  });

  test("one changed word changes the hash", () => {
    const changed = PAGE.replace("SessionStart", "SessionEnd");
    expect(contentHashOf(normalizeDocument(changed))).not.toBe(PAGE_HASH);
  });

  // Documentation sites stamp a build id or a nonce into their scripts on every deploy; a hash
  // that followed them would report drift nightly with no word of the page changed.
  test("a new build id in a script body leaves the hash unchanged", () => {
    const redeployed = PAGE.replace("build-1234", "build-5678").replace("nonce-abc", "nonce-xyz");
    expect(normalizeDocument(redeployed)).toBe(NORMALIZED);
    expect(contentHashOf(normalizeDocument(redeployed))).toBe(PAGE_HASH);
  });

  // Markup a tag-stripping regex misreads: a ">" inside an attribute value ends the tag early and
  // leaks the rest as words, a bare "<" in prose swallows the words after it as a tag, and the
  // text browsers show only without scripts is kept although no reader with scripts sees it.
  // Then markup node-html-parser misreads with its defaults: a pre block's inner tags count as
  // text, a doctype rides along as text or takes the words next to it, and a raw-text element
  // whose end tag differs in case or carries a space before ">" swallows the rest of the page.
  test.each([
    ['<p>See <a title="a > b">the link</a> here.</p>', "See the link here."],
    ["<p>if a < b then c</p>", "if a < b then c"],
    ["<p>a </p><noscript>enable js</noscript><p> b</p>", "a b"],
    ['<pre><code class="language-sh">maxims sync</code></pre>', "maxims sync"],
    ["<!DOCTYPE html>Hello <b>world</b>", "Hello world"],
    ["\n<!DOCTYPE html><p>hello</p>", "hello"],
    ["<SCRIPT>1</script><p>hello</p>", "hello"],
    ["<script>1</script ><p>hello</p>", "hello"],
  ])("reads %s as the words a reader sees", (html, words) => {
    expect(normalizeDocument(html)).toBe(words);
  });
});

const STORED = contentHashOf("stored page");
const OTHER = contentHashOf("moved page");

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
  const page = (id: string, contentHash?: ContentHash): VerifiedPage => ({
    id,
    verifiedAgainst: { url: `https://example.com/${id}`, contentHash },
  });
  const answers = {
    "https://example.com/stable": () => new Response(PAGE),
    "https://example.com/moved": () => new Response("<p>moved page</p>"),
    "https://example.com/gone": () => new Response("", { status: 503 }),
    "https://example.com/slow": timeoutError,
    "https://example.com/unrecorded": () => new Response("<p>moved page</p>"),
  };
  const table = (rows: string[]): string =>
    ["| id | url | verdict | stored | fetched |", "|---|---|---|---|---|", ...rows].join("\n");
  const row = (id: string, verdict: string, stored: string, fetched: string): string =>
    `| ${id} | https://example.com/${id} | ${verdict} | ${stored} | ${fetched} |`;
  const stableRow = row("stable", "match", PAGE_HASH, PAGE_HASH);
  const movedRow = row("moved", "DRIFT", STORED, OTHER);

  // Every way a page can be unverifiable, as the rows the issue and the summary show: the
  // unrecorded page's row carries the hash an author pastes into the definition.
  const unverifiable = [
    page("gone", STORED),
    page("slow", STORED),
    page("offline", STORED),
    page("unrecorded"),
  ];
  const unverifiableRows = [
    row("gone", "unverifiable", STORED, "HTTP 503"),
    row("slow", "unverifiable", STORED, "timeout after 20 s"),
    row("offline", "unverifiable", STORED, "network error: getaddrinfo ENOTFOUND example.com"),
    row("unrecorded", "unverifiable", "(none)", OTHER),
  ];

  test("matches and unverifiable pages pass with the table in the summary", async () => {
    const outcome = await runHarnessDrift(
      [page("stable", PAGE_HASH), ...unverifiable],
      fakeFetch(answers),
    );
    expect(outcome).toEqual({
      status: "pass",
      summary: [
        "## Harness documentation drift",
        "",
        "5 definitions: 1 match, 0 drift, 4 unverifiable",
        "",
        table([stableRow, ...unverifiableRows]),
        "",
      ].join("\n"),
    });
  });

  test("one drifted page fails with the table and the two fields to set", async () => {
    const outcome = await runHarnessDrift(
      [page("stable", PAGE_HASH), page("moved", STORED), page("gone", STORED)],
      fakeFetch(answers),
    );
    const headline = "3 definitions: 1 match, 1 drift, 1 unverifiable";
    const rows = table([stableRow, movedRow, row("gone", "unverifiable", STORED, "HTTP 503")]);
    expect(outcome).toEqual({
      status: "fail",
      summary: `## Harness documentation drift\n\n${headline}\n\n${rows}\n`,
      report: {
        title: "Harness documentation drift",
        body: [
          headline,
          "",
          rows,
          "",
          "To clear a DRIFT row: open the page, re-verify the definition against it, then set that " +
            "definition's `verifiedAgainst.date` to today and `verifiedAgainst.contentHash` to the fetched " +
            "value above. An unverifiable row never fails the run: either this run could not read the page, " +
            "or the definition records no hash yet and the fetched value is the one to record.",
          "",
        ].join("\n"),
      },
    });
  });
});

// Every page resolved when the hashes were recorded, so no definition is excused here.
test("every registered definition records the hash of its verified page", () => {
  const missing = HARNESSES.filter((def) => def.verifiedAgainst.contentHash === undefined).map(
    (def) => def.id,
  );
  expect(missing).toEqual([]);
});
