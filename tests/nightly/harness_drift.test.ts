// Each drift below would be silent without this file, since nothing else reads a page's hash.
//
//   a definition lands without a page's hash     -> the nightly never sees that page move
//   the one normalization behind the hashes moves -> all fourteen definitions read as drift at once
//   markup is misread                             -> a page's words go missing, or script text counts
//   a build stamp or sidebar leaks into the hash  -> a redeploy with no word changed reads as drift
//   a fetch fails or a hash is missing            -> the table turns red instead of unverifiable
//   one page of several moves                     -> its definition still counts as a match
//   the fill instruction changes                  -> the fetched hash an author pastes in disappears
import { describe, expect, test } from "bun:test";
import {
  mediaOf,
  normalizeDocument,
  runHarnessDrift,
  type VerifiedDefinition,
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
    expect(normalizeDocument(PAGE, "html")).toBe(NORMALIZED);
    expect<string>(PAGE_HASH).toBe(
      "sha256:250b9c5827a7d9789921817c234d05933e4a4b1561c1cdd05bda81565741d4e2",
    );
    expect(contentHashOf(normalizeDocument(PAGE, "html"))).toBe(PAGE_HASH);
  });

  test("one changed word changes the hash", () => {
    const changed = PAGE.replace("SessionStart", "SessionEnd");
    expect(contentHashOf(normalizeDocument(changed, "html"))).not.toBe(PAGE_HASH);
  });

  // Documentation sites stamp a build id or a nonce into their scripts on every deploy; a hash
  // that followed them would report drift nightly with no word of the page changed.
  test("a new build id in a script body leaves the hash unchanged", () => {
    const redeployed = PAGE.replace("build-1234", "build-5678").replace("nonce-abc", "nonce-xyz");
    expect(normalizeDocument(redeployed, "html")).toBe(NORMALIZED);
    expect(contentHashOf(normalizeDocument(redeployed, "html"))).toBe(PAGE_HASH);
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
    expect(normalizeDocument(html, "html")).toBe(words);
  });

  // Documentation sites print the build date in a footer and restamp it on every deploy; the
  // stamp carries no fact about the harness, so it leaves the words. Every shape a site prints is
  // listed here; a date without that prefix, or a stamp-shaped line quoted in a code sample, is a
  // fact of the page and stays. The Starlight row ends with no whitespace before the stamp, as the
  // OpenCode footer prints it after the copyright.
  test.each([
    ["Starlight", "<footer>Last updated: Sep 21, 2026</footer>", "Rules"],
    ["Starlight, iso", "<footer>Last updated: 2026-09-21</footer>", "Rules"],
    [
      "Starlight, after the copyright",
      "<footer><span>(c) Vendor</span>Last updated: Sep 21, 2026</footer>",
      "Rules (c) Vendor",
    ],
    ["Starlight 0.41 (Warp)", "<footer>Last updated Sep 16, 2026</footer>", "Rules"],
    ["Docusaurus", "<footer>Last updated on September 21, 2026</footer>", "Rules"],
    ["Docusaurus, modified", "<footer>Last modified: Sep 21, 2026</footer>", "Rules"],
    ["a dated fact", "<p>Released Sep 21, 2026</p>", "Rules Released Sep 21, 2026"],
    ["a bare update word", "<p>Updated hooks</p>", "Rules Updated hooks"],
    [
      "a stamp shape quoted in a code sample",
      '<pre>echo "Last updated: Sep 20, 2026"</pre>',
      'Rules echo "Last updated: Sep 20, 2026"',
    ],
  ])("a %s footer stamp leaves the words", (_site, footer, words) => {
    expect(normalizeDocument(`<p>Rules</p>\n${footer}`, "html")).toBe(words);
  });

  test.each([
    [
      "the whole document",
      (date: string, word: string): string =>
        PAGE.replace("</body>", `<footer>Last updated: ${date}</footer></body>`).replace(
          "SessionStart",
          word,
        ),
    ],
    [
      "the selected main element",
      (date: string, word: string): string =>
        `<nav>Docs</nav><main>${word}<footer>(c) AnomalyLast updated: ${date}</footer></main>`,
    ],
  ])(
    "a redeployed build date in %s leaves the hash unchanged while one changed word does not",
    (_path, stamped) => {
      const before = contentHashOf(
        normalizeDocument(stamped("Sep 20, 2026", "SessionStart"), "html"),
      );
      expect(
        contentHashOf(normalizeDocument(stamped("Sep 21, 2026", "SessionStart"), "html")),
      ).toBe(before);
      expect(
        contentHashOf(normalizeDocument(stamped("Sep 20, 2026", "SessionEnd"), "html")),
      ).not.toBe(before);
    },
  );

  // A site's sidebar lists every page, so a new page anywhere on the site changes the words
  // outside the content element. The two-main row is the Cursor page, which prints a second copy
  // of its content for the print layout; the footer-inside-main row is the OpenCode page, which
  // prints its build stamp glued to the copyright inside the content element.
  test.each([
    ["<nav>Docs Rules Hooks</nav><main><p>Rules</p></main><footer>(c) 2026</footer>", "Rules"],
    [
      "<main>Rules<footer>(c) AnomalyLast updated: Sep 21, 2026</footer></main>",
      "Rules(c) Anomaly",
    ],
    ["<nav>Docs</nav><main><article><p>Rules</p></article></main>", "Rules"],
    ["<aside>Docs</aside><main><p>Rules</p></main><main><p>Rules</p></main>", "Rules"],
    ["<nav>Docs</nav><article><p>Rules</p></article>", "Rules"],
    ['<nav>Docs</nav><div role="main"><p>Rules</p></div>', "Rules"],
    ["<nav>Docs</nav>\n<p>Rules</p>", "Docs Rules"],
  ])("hashes only the content element of %s", (html, words) => {
    expect(normalizeDocument(html, "html")).toBe(words);
  });

  test("a new sidebar entry outside the content element leaves the hash unchanged", () => {
    const site = (sidebar: string): string =>
      `<nav>${sidebar}</nav><main><p>Rules</p></main><footer>(c) 2026</footer>`;
    expect(contentHashOf(normalizeDocument(site("Docs Rules Hooks Plugins"), "html"))).toBe(
      contentHashOf(normalizeDocument(site("Docs Rules Hooks"), "html")),
    );
  });

  // A raw markdown file served as text is never parsed, so a `main` tag quoted in one of its code
  // fences cannot become the content element and hide the rest of the page.
  test("a markdown file is hashed as the text it is", () => {
    const markdown = "# Hooks\n\nRun on SessionStart.\n\n```html\n<main>Example</main>\n```\n";
    expect(normalizeDocument(markdown, "text")).toBe(
      "# Hooks Run on SessionStart. ```html <main>Example</main> ```",
    );
  });
});

// What each vendor serves: the HTML sites with and without a charset, and GitHub's raw files as
// plain text. An unknown or missing type is hashed as text because parsing it could hide words.
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

const STORED = contentHashOf("stored page");
const OTHER = contentHashOf("moved page");
const RAW = "# Hooks\n\n<main>quoted</main>\n";
const RAW_HASH = contentHashOf("# Hooks <main>quoted</main>");
const HTML = { headers: { "content-type": "text/html; charset=utf-8" } };
const TEXT = { headers: { "content-type": "text/plain; charset=utf-8" } };

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
  type Page = [name: string, contentHash?: ContentHash, note?: string];
  const url = (name: string): string => `https://example.com/${name}`;
  const def = (id: string, ...pages: Page[]): VerifiedDefinition => ({
    id,
    verifiedAgainst: {
      pages: pages.map(([name, contentHash, note]) => ({ url: url(name), contentHash, note })),
    },
  });
  const answers = {
    [url("stable")]: () => new Response(PAGE, HTML),
    [url("raw")]: () => new Response(RAW, TEXT),
    [url("moved")]: () => new Response("<p>moved page</p>", HTML),
    [url("gone")]: () => new Response("", { status: 503 }),
    [url("slow")]: timeoutError,
    [url("unrecorded")]: () => new Response("<p>moved page</p>", HTML),
  };
  const table = (rows: string[]): string =>
    ["| id | url | note | verdict | stored | fetched |", "|---|---|---|---|---|---|", ...rows].join(
      "\n",
    );
  const row = (
    id: string,
    name: string,
    verdict: string,
    stored: string,
    fetched: string,
    note = "-",
  ) => `| ${id} | ${url(name)} | ${note} | ${verdict} | ${stored} | ${fetched} |`;
  const stableRow = row("stable", "stable", "match", PAGE_HASH, PAGE_HASH);
  const rawRow = row("raw", "raw", "match", RAW_HASH, RAW_HASH);
  const goneRow = row("gone", "gone", "unverifiable", STORED, "HTTP 503");

  // Every way a page can be unverifiable, as the rows the issue and the summary show: the
  // unrecorded page's row carries the hash an author pastes into the definition.
  const unverifiable = [
    def("gone", ["gone", STORED]),
    def("slow", ["slow", STORED]),
    def("offline", ["offline", STORED]),
    def("unrecorded", ["unrecorded"]),
  ];
  const unverifiableRows = [
    goneRow,
    row("slow", "slow", "unverifiable", STORED, "timeout after 20 s"),
    row(
      "offline",
      "offline",
      "unverifiable",
      STORED,
      "network error: getaddrinfo ENOTFOUND example.com",
    ),
    row("unrecorded", "unrecorded", "unverifiable", "(none)", OTHER),
  ];

  test("matches and unverifiable pages pass with the table in the summary", async () => {
    const outcome = await runHarnessDrift(
      [def("stable", ["stable", PAGE_HASH]), def("raw", ["raw", RAW_HASH]), ...unverifiable],
      fakeFetch(answers),
    );
    expect(outcome).toEqual({
      status: "pass",
      summary: [
        "## Harness documentation drift",
        "",
        "6 definitions: 2 match, 0 drift, 4 unverifiable",
        "6 pages: 2 match, 0 drift, 4 unverifiable",
        "",
        table([stableRow, rawRow, ...unverifiableRows]),
        "",
      ].join("\n"),
    });
  });

  test("one drifted page fails the definition and its row carries the note to re-check", async () => {
    const outcome = await runHarnessDrift(
      [
        def("multi", ["stable", PAGE_HASH], ["moved", STORED, "context-file order"]),
        def("partial", ["raw", RAW_HASH], ["gone", STORED]),
      ],
      fakeFetch(answers),
    );
    const headline = [
      "2 definitions: 0 match, 1 drift, 1 unverifiable",
      "4 pages: 2 match, 1 drift, 1 unverifiable",
    ].join("\n");
    const rows = table([
      row("multi", "stable", "match", PAGE_HASH, PAGE_HASH),
      row("multi", "moved", "DRIFT", STORED, OTHER, "context-file order"),
      row("partial", "raw", "match", RAW_HASH, RAW_HASH),
      row("partial", "gone", "unverifiable", STORED, "HTTP 503"),
    ]);
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
          "To clear a DRIFT row: open the page, re-verify the definition's facts it justifies, then set " +
            "that definition's `verifiedAgainst.date` to today and the page's `contentHash` to the fetched " +
            "value above. An unverifiable row never fails the run: either this run could not read the page, " +
            "or the definition records no hash for it yet and the fetched value is the one to record.",
          "",
        ].join("\n"),
      },
    });
  });
});

// Every page resolved when the hashes were recorded, so no definition is excused here.
test("every registered definition records the hash of each verified page", () => {
  const missing = HARNESSES.flatMap((def) =>
    def.verifiedAgainst.pages
      .filter((page) => page.contentHash === undefined)
      .map((page) => `${def.id}: ${page.url}`),
  );
  expect(missing).toEqual([]);
});
