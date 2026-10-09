// Re-reads every source a harness definition was verified against and checks the facts the
// definition recorded: a JSON pointer that must resolve in a published schema, or a literal claim
// that must appear in a repository file or a documentation page. A fact that vanished is dated
// to a 24-hour window instead of waiting for someone to look. A pass means every source was read
// and every claim held: a source the run could not read fails it, since a run that read nothing
// proves nothing about the facts.
import { isDeepStrictEqual } from "node:util";
import jsonpointer from "jsonpointer";
import { HTMLElement, type Node, parse } from "node-html-parser";
import type { PointerCheck, VerifiedSource } from "../../src/harnesses/contract.ts";
import { HARNESSES } from "../../src/harnesses/registry.ts";
import { markdownTable, type Outcome } from "./report.ts";

export const FETCH_TIMEOUT_MS = 20_000;
const USER_AGENT = "maxims-nightly";

// Two constructs node-html-parser reads wrongly on its own: a doctype rides along as page text,
// and a raw-text element's end tag is found only as the exact `</name>`, so `</script >` swallows
// the rest of the page.
const DOCTYPE = /<!DOCTYPE[^>]*>/gi;
const UNSEEN_END_TAG = /<\/(script|style|noscript)\s+>/gi;

// The elements whose bodies the parser drops (false) are the ones no reader with scripts enabled
// sees; sites embed the page's own data as JSON in them, so a claim would hold there on an
// identifier no reader was shown. `pre` is left out of the list so its inner markup is parsed
// instead of read as text.
const PARSE_OPTIONS = {
  lowerCaseTagName: true,
  blockTextElements: { script: false, style: false, noscript: false },
};

// A raw file is read as the text it is; only an HTML page is parsed, so markup quoted inside a
// markdown code fence never counts as the page's structure.
export type Media = "html" | "text";

export function mediaOf(contentType: string | null): Media {
  const type = (contentType ?? "").split(";")[0]?.trim().toLowerCase();
  return type === "text/html" || type === "application/xhtml+xml" ? "html" : "text";
}

// The words outside the content element are left out: a site's sidebar names every page on the
// site, so a claim such as `hooks` would hold on a page that lost its hooks section.
const CONTENT_SELECTORS = ["main", "article", '[role="main"]'];

// A reader sees a block element start on its own line, so its words never join the words beside
// it. The parser's `textContent` glues `<p>SessionStart</p><p>SessionEnd</p>` into one word, and
// its `structuredText` drops the space a line break carries between inline elements, so the walk
// is this file's own: a block's words get a space on each side, everything else reads as is.
const BLOCK_TAGS = new Set(
  [
    "address",
    "article",
    "aside",
    "blockquote",
    "br",
    "dd",
    "details",
    "dialog",
    "div",
    "dl",
    "dt",
    "fieldset",
    "figcaption",
    "figure",
    "footer",
    "form",
    "h1",
    "h2",
    "h3",
    "h4",
    "h5",
    "h6",
    "header",
    "hgroup",
    "hr",
    "li",
    "main",
    "nav",
    "ol",
    "p",
    "pre",
    "section",
    "summary",
    "table",
    "tbody",
    "td",
    "tfoot",
    "th",
    "thead",
    "tr",
    "ul",
  ].map((tag) => tag.toUpperCase()),
);

function wordsOf(node: Node): string {
  if (!(node instanceof HTMLElement)) return node.textContent;
  const inner = node.childNodes.map(wordsOf).join("");
  return BLOCK_TAGS.has(node.tagName) ? ` ${inner} ` : inner;
}

const squashWhitespace = (text: string): string => text.replace(/\s+/g, " ");

export function normalizeDocument(body: string, media: Media): string {
  if (media === "text") return squashWhitespace(body).trim();
  const root = parse(body.replace(DOCTYPE, "").replace(UNSEEN_END_TAG, "</$1>"), PARSE_OPTIONS);
  const content =
    CONTENT_SELECTORS.map((selector) => root.querySelector(selector)).find(
      (element) => element !== null,
    ) ?? root;
  return squashWhitespace(wordsOf(content)).trim();
}

// A claim is a literal phrase, matched case-sensitively with every whitespace run on both sides
// read as one space. A claim that begins or ends in an ASCII word character must begin or end at
// a word boundary, so `hooks` never holds on `webhooks`; `.claude/rules` needs none before its dot.
const WORD = "[A-Za-z0-9_-]";
const WORD_FIRST = new RegExp(`^${WORD}`);
const WORD_LAST = new RegExp(`${WORD}$`);

export function claimPresent(text: string, claim: string): boolean {
  const literal = squashWhitespace(claim).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const before = WORD_FIRST.test(claim) ? `(?<!${WORD})` : "";
  const after = WORD_LAST.test(claim) ? `(?!${WORD})` : "";
  return new RegExp(`${before}${literal}${after}`).test(text);
}

export type Fetched =
  | { kind: "body"; text: string; media: Media }
  | { kind: "status"; status: number }
  | { kind: "timeout" }
  | { kind: "error"; message: string };

export function sourceUrl(source: VerifiedSource): string {
  return source.kind === "file"
    ? `https://raw.githubusercontent.com/${source.repo}/${source.ref}/${source.path}`
    : source.url;
}

export async function fetchSource(url: string, fetchImpl: typeof fetch): Promise<Fetched> {
  try {
    const response = await fetchImpl(url, {
      headers: { "User-Agent": USER_AGENT },
      redirect: "follow",
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    if (response.status !== 200) return { kind: "status", status: response.status };
    const media = mediaOf(response.headers.get("content-type"));
    return { kind: "body", text: await response.text(), media };
  } catch (error) {
    if (error instanceof Error && error.name === "TimeoutError") return { kind: "timeout" };
    return { kind: "error", message: error instanceof Error ? error.message : String(error) };
  }
}

export type Verdict = "match" | "DRIFT" | "UNREACHABLE";

// Worst first, at both levels: a definition is the worst of its sources, the run the worst of its
// definitions.
const RANKED: readonly Verdict[] = ["DRIFT", "UNREACHABLE", "match"];

function worstOf(verdicts: readonly [Verdict, ...Verdict[]]): Verdict {
  return verdicts.reduce((worst, verdict) =>
    RANKED.indexOf(verdict) < RANKED.indexOf(worst) ? verdict : worst,
  );
}

export type VerifiedDefinition = {
  id: string;
  verifiedAgainst: { sources: readonly [VerifiedSource, ...VerifiedSource[]] };
};

export type Row = {
  id: string;
  kind: VerifiedSource["kind"];
  url: string;
  note: string;
  verdict: Verdict;
  result: string;
};

export type Judged = { id: string; verdict: Verdict; rows: readonly [Row, ...Row[]] };

const NO_NOTE = "-";

type Reading = Pick<Row, "verdict" | "result">;

function readClaims(text: string, claims: readonly string[]): Reading {
  const missing = claims.filter((claim) => !claimPresent(text, claim));
  if (missing.length === 0) return { verdict: "match", result: `${claims.length} claims hold` };
  return { verdict: "DRIFT", result: `missing: ${missing.map((c) => `\`${c}\``).join(", ")}` };
}

// A pointer paired with a value drifts when the schema still has the key but says something else,
// and the row quotes both so a reader sees whether the fact or the definition moved. JSON carries
// no undefined, so an undefined lookup is a missing pointer; a document that is not an object
// (jsonpointer refuses a primitive and trips on null) is no schema at all.
function readSchema(text: string, paths: readonly PointerCheck[]): Reading {
  let document: unknown;
  try {
    document = JSON.parse(text);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { verdict: "UNREACHABLE", result: `not JSON: ${message}` };
  }
  if (typeof document !== "object" || document === null)
    return { verdict: "UNREACHABLE", result: `not a JSON object: ${JSON.stringify(document)}` };
  const missing: string[] = [];
  const differing: string[] = [];
  for (const check of paths) {
    const pointer = typeof check === "string" ? check : check.pointer;
    const value: unknown = jsonpointer.get(document, pointer);
    if (value === undefined) missing.push(`\`${pointer}\``);
    else if (typeof check !== "string" && !isDeepStrictEqual(value, check.equals))
      differing.push(
        `\`${pointer}\` is ${JSON.stringify(value)}, not ${JSON.stringify(check.equals)}`,
      );
  }
  if (missing.length === 0 && differing.length === 0)
    return { verdict: "match", result: `${paths.length} pointers resolve` };
  const parts = [...(missing.length === 0 ? [] : [`missing: ${missing.join(", ")}`]), ...differing];
  return { verdict: "DRIFT", result: parts.join("; ") };
}

// A source that answered anything but its content is UNREACHABLE: its row shows the answer where
// the reading would be, and the run reads nothing of the facts it carries.
function read(source: VerifiedSource, fetched: Fetched): Reading {
  switch (fetched.kind) {
    case "status":
      return { verdict: "UNREACHABLE", result: `HTTP ${fetched.status}` };
    case "timeout":
      return { verdict: "UNREACHABLE", result: `timeout after ${FETCH_TIMEOUT_MS / 1000} s` };
    case "error":
      return { verdict: "UNREACHABLE", result: `network error: ${fetched.message}` };
    case "body":
      switch (source.kind) {
        case "schema":
          return readSchema(fetched.text, source.paths);
        case "file":
          return readClaims(normalizeDocument(fetched.text, "text"), source.claims);
        case "page":
          return readClaims(normalizeDocument(fetched.text, fetched.media), source.claims);
      }
  }
}

export function judgeSource(id: string, source: VerifiedSource, fetched: Fetched): Row {
  return {
    id,
    kind: source.kind,
    url: sourceUrl(source),
    note: source.note ?? NO_NOTE,
    ...read(source, fetched),
  };
}

export function judgeDefinition(id: string, rows: readonly [Row, ...Row[]]): Judged {
  const [first, ...rest] = rows;
  return { id, verdict: worstOf([first.verdict, ...rest.map((row) => row.verdict)]), rows };
}

export function renderRows(rows: readonly Row[]): string {
  return markdownTable(
    ["id", "kind", "source", "note", "verdict", "result"],
    rows.map((row) => [row.id, row.kind, row.url, row.note, row.verdict, row.result]),
  );
}

const FIX = [
  "To clear a DRIFT row: open the source, re-verify the definition's facts it justifies, fix the",
  "definition or its claims to what the source states now, and set that definition's",
  "`verifiedAgainst.date` to today. An UNREACHABLE row shows the answer the source gave in place",
  "of its content: the run read nothing of that source, so it fails until the source reads again",
  "or the definition points at one that does. The run passes only when every claim of every",
  "source of every definition holds.",
].join(" ");

function tally(label: string, verdicts: readonly Verdict[]): string {
  const count = (verdict: Verdict): number => verdicts.filter((v) => v === verdict).length;
  return (
    `${verdicts.length} ${label}: ${count("match")} match, ${count("DRIFT")} drift, ` +
    `${count("UNREACHABLE")} unreachable`
  );
}

// A run that judged nothing has no row to go red, so an emptied registry fails rather than
// passing as every source matching.
export function summarize(judged: readonly Judged[]): Outcome {
  const rows = judged.flatMap((entry) => entry.rows);
  const headline = [
    tally(
      "definitions",
      judged.map((entry) => entry.verdict),
    ),
    tally(
      "sources",
      rows.map((row) => row.verdict),
    ),
  ].join("\n");
  const summary = `## Harness documentation drift\n\n${headline}\n\n${renderRows(rows)}\n`;
  const [first, ...rest] = judged;
  if (first !== undefined && worstOf([first.verdict, ...rest.map((e) => e.verdict)]) === "match")
    return { status: "pass", summary };
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
  definitions: readonly VerifiedDefinition[] = HARNESSES,
  fetchImpl: typeof fetch = fetch,
): Promise<Outcome> {
  const judge = async (id: string, source: VerifiedSource): Promise<Row> =>
    judgeSource(id, source, await fetchSource(sourceUrl(source), fetchImpl));
  const judged = await Promise.all(
    definitions.map(async (def) => {
      const [first, ...rest] = def.verifiedAgainst.sources;
      return judgeDefinition(
        def.id,
        await Promise.all([judge(def.id, first), ...rest.map((source) => judge(def.id, source))]),
      );
    }),
  );
  return summarize(judged);
}
