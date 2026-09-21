// Re-fetches every harness definition's verified documentation page and compares its content hash
// with the one the definition recorded, so a page that moved is dated to a 24-hour window instead
// of waiting for someone to look.
import { HTMLElement, type Node, parse } from "node-html-parser";
import { HARNESSES } from "../../src/harnesses/registry.ts";
import { type ContentHash, contentHashOf } from "../../src/memory/contract.ts";
import { markdownTable, type Outcome } from "./report.ts";

export const FETCH_TIMEOUT_MS = 20_000;
const USER_AGENT = "maxims-nightly";

// Two constructs node-html-parser reads wrongly on its own: a doctype rides along as page text,
// and a raw-text element's end tag is found only as the exact `</name>`, so `</script >` swallows
// the rest of the page.
const DOCTYPE = /<!DOCTYPE[^>]*>/gi;
const UNSEEN_END_TAG = /<\/(script|style|noscript)\s+>/gi;

// The elements whose bodies the parser drops (false) are the ones no reader with scripts enabled
// sees; sites restamp build ids and nonces into them on every deploy. `pre` is left out of the
// list so its inner markup is parsed instead of hashed as text.
const PARSE_OPTIONS = {
  lowerCaseTagName: true,
  blockTextElements: { script: false, style: false, noscript: false },
};

// A raw markdown file is hashed as the text it is; only an HTML page is parsed, so markup quoted
// inside a markdown code fence never counts as the page's structure.
export type Media = "html" | "text";

export function mediaOf(contentType: string | null): Media {
  const type = (contentType ?? "").split(";")[0]?.trim().toLowerCase();
  return type === "text/html" || type === "application/xhtml+xml" ? "html" : "text";
}

// The one normalization behind every stored hash: changing it repaints every definition as drift,
// so the harness_drift test pins a sample's exact normalized text and hash. Two things a redeploy
// changes with no word of the page changed are left out: the words outside the content element
// (the site's sidebar and footer, which every new page on the site rewrites) and the build date a
// footer prints, matched inside `footer` elements only, by the shapes seen on vendor sites rather
// than by any date, so a dated fact or a code sample elsewhere on the page keeps its words:
//
//   Starlight              Last updated: Sep 21, 2026     Last updated: 2026-09-21
//   Starlight 0.41 (Warp)  Last updated Sep 16, 2026
//   Docusaurus             Last updated on September 21, 2026
const CONTENT_SELECTORS = ["main", "article", '[role="main"]'];
const MONTH = "(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*";
const BUILD_STAMP = new RegExp(
  `Last (?:updated|modified)(?::| on)? (?:${MONTH} \\d{1,2}, \\d{4}|\\d{4}-\\d{2}-\\d{2})`,
  "g",
);

const squashWhitespace = (text: string): string => text.replace(/\s+/g, " ");

// The parser's own text getter everywhere but inside a footer, so a line break still reads as a
// space and entities decode as the parser decodes them.
function wordsOf(node: Node): string {
  if (!(node instanceof HTMLElement)) return node.textContent;
  if (node.tagName === "FOOTER")
    return squashWhitespace(node.textContent).replace(BUILD_STAMP, " ");
  if (node.querySelector("footer") === null) return node.textContent;
  return node.childNodes.map(wordsOf).join("");
}

export function normalizeDocument(body: string, media: Media): string {
  if (media === "text") return squashWhitespace(body).trim();
  const root = parse(body.replace(DOCTYPE, "").replace(UNSEEN_END_TAG, "</$1>"), PARSE_OPTIONS);
  const content =
    CONTENT_SELECTORS.map((selector) => root.querySelector(selector)).find(
      (element) => element !== null,
    ) ?? root;
  return squashWhitespace(wordsOf(content)).trim();
}

export type Fetched =
  | { kind: "page"; hash: ContentHash }
  | { kind: "status"; status: number }
  | { kind: "timeout" }
  | { kind: "error"; message: string };

export async function fetchPageHash(url: string, fetchImpl: typeof fetch): Promise<Fetched> {
  try {
    const response = await fetchImpl(url, {
      headers: { "User-Agent": USER_AGENT },
      redirect: "follow",
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    if (response.status !== 200) return { kind: "status", status: response.status };
    const media = mediaOf(response.headers.get("content-type"));
    return { kind: "page", hash: contentHashOf(normalizeDocument(await response.text(), media)) };
  } catch (error) {
    if (error instanceof Error && error.name === "TimeoutError") return { kind: "timeout" };
    return { kind: "error", message: error instanceof Error ? error.message : String(error) };
  }
}

export type Verdict = "match" | "DRIFT" | "unverifiable";

export type VerifiedPage = {
  id: string;
  verifiedAgainst: { url: string; contentHash?: ContentHash };
};

export type Row = {
  id: string;
  url: string;
  verdict: Verdict;
  stored: string;
  fetched: string;
};

const NO_HASH = "(none)";

// A missing stored hash still reports the fetched one, which is what a definition's author pastes
// into `verifiedAgainst.contentHash`.
export function judgeDefinition(def: VerifiedPage, fetched: Fetched): Row {
  const { url, contentHash } = def.verifiedAgainst;
  const stored = contentHash ?? NO_HASH;
  const row = (verdict: Verdict, fetchedText: string): Row => ({
    id: def.id,
    url,
    verdict,
    stored,
    fetched: fetchedText,
  });
  switch (fetched.kind) {
    case "status":
      return row("unverifiable", `HTTP ${fetched.status}`);
    case "timeout":
      return row("unverifiable", `timeout after ${FETCH_TIMEOUT_MS / 1000} s`);
    case "error":
      return row("unverifiable", `network error: ${fetched.message}`);
    case "page":
      if (contentHash === undefined) return row("unverifiable", fetched.hash);
      return row(fetched.hash === contentHash ? "match" : "DRIFT", fetched.hash);
  }
}

export function renderRows(rows: readonly Row[]): string {
  return markdownTable(
    ["id", "url", "verdict", "stored", "fetched"],
    rows.map((row) => [row.id, row.url, row.verdict, row.stored, row.fetched]),
  );
}

const FIX = [
  "To clear a DRIFT row: open the page, re-verify the definition against it, then set that",
  "definition's `verifiedAgainst.date` to today and `verifiedAgainst.contentHash` to the fetched",
  "value above. An unverifiable row never fails the run: either this run could not read the page,",
  "or the definition records no hash yet and the fetched value is the one to record.",
].join(" ");

export function summarize(rows: readonly Row[]): Outcome {
  const count = (verdict: Verdict): number => rows.filter((row) => row.verdict === verdict).length;
  const drift = count("DRIFT");
  const headline =
    `${rows.length} definitions: ${count("match")} match, ${drift} drift, ` +
    `${count("unverifiable")} unverifiable`;
  const summary = `## Harness documentation drift\n\n${headline}\n\n${renderRows(rows)}\n`;
  if (drift === 0) return { status: "pass", summary };
  return {
    status: "fail",
    summary,
    report: {
      title: "Harness documentation drift",
      body: `${headline}\n\n${renderRows(rows)}\n\n${FIX}\n`,
    },
  };
}

export async function runHarnessDrift(
  definitions: readonly VerifiedPage[] = HARNESSES,
  fetchImpl: typeof fetch = fetch,
): Promise<Outcome> {
  const rows = await Promise.all(
    definitions.map(async (def) =>
      judgeDefinition(def, await fetchPageHash(def.verifiedAgainst.url, fetchImpl)),
    ),
  );
  return summarize(rows);
}
