// Re-reads every source a harness definition was verified against and checks the facts the
// definition recorded: a JSON pointer that must resolve in a published schema, or a literal claim
// that must appear in a repository file or a documentation page. A fact that vanished is dated
// to a 24-hour window instead of waiting for someone to look. A pass means every source was read
// and every claim held: a source the run could not read fails it, since a run that read nothing
// proves nothing about the facts.
import { getNodeValue, type ParseError, parseTree, printParseErrorCode } from "jsonc-parser";
import jsonpointer from "jsonpointer";
import { count } from "../../src/console/strings.ts";
import type { PointerCheck, VerifiedSource } from "../../src/harnesses/contract.ts";
import { HARNESSES } from "../../src/harnesses/registry.ts";
import { markdownTable, type Outcome } from "./report.ts";

export const FETCH_TIMEOUT_MS = 20_000;
const USER_AGENT = "maxims-nightly";

// Every source is read as the text it is (a raw repository file, a markdown rendition of a page),
// with each whitespace run as one space, so a claim holds across a line break.
const squashWhitespace = (text: string): string => text.replace(/\s+/g, " ");

export function normalizeText(body: string): string {
  return squashWhitespace(body).trim();
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
  | { kind: "body"; text: string; mediaType: string }
  | { kind: "redirect"; location: string }
  | { kind: "status"; status: number }
  | { kind: "timeout" }
  | { kind: "error"; message: string };

export function sourceUrl(source: VerifiedSource): string {
  return source.kind === "file"
    ? `https://raw.githubusercontent.com/${source.repo}/${source.ref}/${source.path}`
    : source.url;
}

// The Content-Type without its parameters, lower-cased, so a page read can tell a rendered HTML
// page from the markdown it expects; a missing header reads as an empty type.
export function mediaTypeOf(contentType: string | null): string {
  return (contentType ?? "").split(";")[0]?.trim().toLowerCase() ?? "";
}

// A redirect is not followed: a vendor that moved a page answers a landing page at the new URL,
// and a landing page can hold a claim by accident, so the move must show in the row instead. A
// 3xx with no Location (a 304, a bare redirect) names nowhere, so it reads as its status.
export async function fetchSource(url: string, fetchImpl: typeof fetch): Promise<Fetched> {
  try {
    const response = await fetchImpl(url, {
      headers: { "User-Agent": USER_AGENT },
      redirect: "manual",
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    const location = response.headers.get("location");
    if (response.status >= 300 && response.status < 400 && location !== null)
      return { kind: "redirect", location: new URL(location, url).href };
    if (response.status !== 200) return { kind: "status", status: response.status };
    return {
      kind: "body",
      text: await response.text(),
      mediaType: mediaTypeOf(response.headers.get("content-type")),
    };
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

// A missing claim or pointer is quoted as a JSON string: claims carry backticks, which a
// backtick fence in a markdown cell would end early.
const quoted = (items: readonly string[]): string =>
  items.map((item) => JSON.stringify(item)).join(", ");

function readClaims(text: string, claims: readonly string[]): Reading {
  const missing = claims.filter((claim) => !claimPresent(text, claim));
  if (missing.length === 0)
    return { verdict: "match", result: count(claims.length, "claim holds", "claims hold") };
  return { verdict: "DRIFT", result: `missing: ${quoted(missing)}` };
}

// jsonc-parser's getNodeValue builds every object with a null prototype, so an object's inherited
// member such as `toString` never answers a pointer (`{}` with `/toString` once read as match). An
// array keeps Array.prototype, so a pointer into one still answers `length` and inherited members.
function readSchema(text: string, paths: readonly PointerCheck[]): Reading {
  const errors: ParseError[] = [];
  const root = parseTree(text, errors, { allowTrailingComma: false, disallowComments: true });
  const [first] = errors;
  if (first !== undefined) {
    const reason = `${printParseErrorCode(first.error)} at offset ${first.offset}`;
    return { verdict: "UNREACHABLE", result: `not JSON: ${reason}` };
  }
  if (root === undefined) return { verdict: "UNREACHABLE", result: "not JSON: no value" };
  const document: unknown = getNodeValue(root);
  if (typeof document !== "object" || document === null || Array.isArray(document))
    return { verdict: "UNREACHABLE", result: `not a JSON object: ${JSON.stringify(document)}` };
  const missing: string[] = [];
  const differing: string[] = [];
  for (const check of paths) {
    const pointer = typeof check === "string" ? check : check.pointer;
    const value: unknown = jsonpointer.get(document, pointer);
    if (value === undefined) missing.push(pointer);
    else if (typeof check !== "string" && value !== check.equals)
      differing.push(
        `${JSON.stringify(pointer)} is ${JSON.stringify(value)}, not ${JSON.stringify(check.equals)}`,
      );
  }
  if (missing.length === 0 && differing.length === 0)
    return {
      verdict: "match",
      result: count(paths.length, "pointer resolves", "pointers resolve"),
    };
  const parts = [...(missing.length === 0 ? [] : [`missing: ${quoted(missing)}`]), ...differing];
  return { verdict: "DRIFT", result: parts.join("; ") };
}

// A source that answered anything but its content is UNREACHABLE: its row shows the answer where
// the reading would be, and the run reads nothing of the facts it carries. A text source (a file
// or a page) that answers a rendered HTML document is one of those: its claims were written
// against a raw file or a markdown rendition, and nav text or embedded data would hold them by
// accident.
const HTML_TYPES = new Set(["text/html", "application/xhtml+xml"]);

function read(source: VerifiedSource, fetched: Fetched): Reading {
  switch (fetched.kind) {
    case "redirect":
      return { verdict: "UNREACHABLE", result: `moved to ${fetched.location}` };
    case "status":
      return { verdict: "UNREACHABLE", result: `HTTP ${fetched.status}` };
    case "timeout":
      return { verdict: "UNREACHABLE", result: `timeout after ${FETCH_TIMEOUT_MS / 1000} s` };
    case "error":
      return { verdict: "UNREACHABLE", result: `network error: ${fetched.message}` };
    case "body":
      if (source.kind === "schema") return readSchema(fetched.text, source.paths);
      if (HTML_TYPES.has(fetched.mediaType))
        return { verdict: "UNREACHABLE", result: `answered ${fetched.mediaType}` };
      return readClaims(normalizeText(fetched.text), source.claims);
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
  "definition or its claims and pointers to what the source states now, and set that definition's",
  "`verifiedAgainst.date` to today. An UNREACHABLE row shows the answer the source gave in place",
  "of its content: the run read nothing of that source, so it fails until the source reads again",
  "or the definition points at one that does. The run passes only when every claim and pointer of",
  "every source of every definition holds.",
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
