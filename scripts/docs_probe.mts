#!/usr/bin/env bun
// The page probe of /docs-discipline: the readings a reviewer otherwise
// takes by eye, made exact.
//   a paragraph or list item over the word cap (default 70)  -> finding, exit 1
//   a table cell over the cell cap (default 15)              -> finding, exit 1
//   a path the prose names that the repository does not track -> finding, exit 1
//   a link whose #anchor names no heading or id on its target -> finding, exit 1
// Block structure and line numbers come from micromark's tokens, so what
// counts as prose is what CommonMark parses as a paragraph or a tight list
// item, and a GFM table contributes its cells, each against the cell cap:
// headings, code (fenced or indented), raw HTML, and images contribute nothing.
// Front matter is blanked before parsing; a BEGIN/END GENERATED region is
// dropped where the parser sees its markers as HTML blocks, so a marker
// quoted inside a fence is code and changes nothing.
// A path is a backticked token with a slash and an extension (or ./, ../, a
// trailing slash), or a relative link destination; placeholders (<...>),
// globs, owner/repo slugs, and bare file names are left alone, since a page
// may name files the reader will create. What the repository owns is what
// git tracks, never what the checkout happens to hold: a `.claude/` an agent
// created locally must not turn `.claude/settings.json` into a stale pointer.
// An anchor is judged against the ids the target page renders: each heading's
// slug as GitHub and the docs site make it (github-slugger, repeats numbered)
// and an `id` or `name` attribute on a tag; a comment renders no tag.

import { existsSync, readFileSync, realpathSync, statSync } from "node:fs";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { decodeNamedCharacterReference } from "decode-named-character-reference";
import GithubSlugger from "github-slugger";
import { parse, postprocess, preprocess } from "micromark";
import { gfmStrikethrough } from "micromark-extension-gfm-strikethrough";
import { gfmTable } from "micromark-extension-gfm-table";
import { gfmTaskListItem } from "micromark-extension-gfm-task-list-item";
import { decodeNumericCharacterReference } from "micromark-util-decode-numeric-character-reference";
import { normalizeIdentifier } from "micromark-util-normalize-identifier";
import type { Event, Token, TokenizeContext } from "micromark-util-types";
import { isInside } from "../src/util/fs.ts";
import { parseArgv, positiveInteger, type Refuser, usageRefuser } from "./lib/argv.ts";
import { linkFile } from "./lib/links.ts";
import { parseMarker, type RegionMarker } from "./lib/region.ts";
import { captureOrThrow } from "./lib/spawn.ts";

export const DEFAULT_MAX_WORDS = 70;
export const DEFAULT_MAX_CELL_WORDS = 15;

/** One finding on a page, at the one-based line where the unit or token starts. */
export interface Finding {
  readonly file: string;
  readonly line: number;
  readonly message: string;
}

export interface ProbeOptions {
  /** Repository root every slash path resolves against. */
  readonly root: string;

  /** The cap on a paragraph or a list item. */
  readonly maxWords: number;

  /** The cap on one table cell; a cell holds one fact, and the explanation goes below the table. */
  readonly maxCellWords: number;

  /** What the repository owns, for the path checks; null: word counts only, for pages that describe another repository's files. */
  readonly tracked: TrackedPaths | null;
}

/** Every file git tracks, every directory above one, and the root itself (`""`), as slash paths relative to the root. */
export type TrackedPaths = ReadonlySet<string>;

export function trackedPaths(files: Iterable<string>): TrackedPaths {
  const out = new Set<string>([""]);
  for (const file of files) {
    out.add(file);
    for (let slash = file.lastIndexOf("/"); slash > 0; slash = file.lastIndexOf("/", slash - 1))
      out.add(file.slice(0, slash));
  }
  return out;
}

/**
 * The variables that point git at a repository: a `GIT_DIR` or `GIT_INDEX_FILE` a git hook hands
 * down would list another repository, or nothing. The command itself needs no repository.
 * GIT_CONFIG_GLOBAL and GIT_CONFIG_SYSTEM are not on git's list and survive: a checkout may need
 * the safe.directory override they carry.
 */
function gitRepositoryEnv(): Set<string> {
  const names = captureOrThrow("git", ["rev-parse", "--local-env-vars"])
    .split("\n")
    .filter(Boolean);
  if (names.length === 0)
    throw new Error(
      "git rev-parse --local-env-vars named nothing; the listing cannot be kept to the root's repository",
    );
  return new Set(names);
}

/**
 * The files git tracks under `root`, as git prints them: slash-separated, relative to the root.
 * The child gets none of the repository-pointing variables, and a listing of nothing passes every
 * page, so an empty listing is refused rather than read as "nothing to check".
 */
function gitTrackedFiles(root: string): string[] {
  const stripped = gitRepositoryEnv();
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env))
    if (value !== undefined && !stripped.has(key)) env[key] = value;
  const files = captureOrThrow("git", ["-C", root, "ls-files", "-z"], { env })
    .split("\0")
    .filter(Boolean);
  if (files.length === 0)
    throw new Error(`git tracks nothing under ${root}; the path checks need a tracked tree`);
  return files;
}

/**
 * One stretch of prose the reader sees, judged against a word cap.
 *   line -> the first word's, which a tag or a comment opening the unit is not
 *   text -> as the reader sees it: link labels and code spans kept, markup gone
 */
export interface Unit {
  readonly kind: "paragraph" | "item" | "cell";
  readonly line: number;
  readonly text: string;
}

/** What one page yields to the probes; `anchors` is every id the rendered page answers a fragment with: heading slugs and tag ids. */
export interface Scan {
  readonly units: Unit[];
  readonly codespans: { readonly text: string; readonly line: number }[];
  readonly links: { readonly href: string; readonly line: number }[];
  readonly anchors: Set<string>;
}

/** The page with front matter blanked, line for line, so line numbers still match the file. */
function blankFrontMatter(text: string): string {
  const lines = text.split("\n").map((line) => line.replace(/\r$/, ""));
  // Only a closed block is front matter; a lone --- is a thematic break and the page is prose.
  if (lines[0] === "---") {
    const close = lines.indexOf("---", 1);
    if (close !== -1) for (let i = 0; i <= close; i++) lines[i] = "";
  }
  return lines.join("\n");
}

/** The character a reference such as `&amp;`, `&#35;` or `&#x23;` stands for, as the reader sees it. */
function decodeCharacterReference(reference: string): string {
  const numeric = /^&#([xX]?)([0-9a-fA-F]+);$/.exec(reference);
  if (numeric) return decodeNumericCharacterReference(numeric[2] ?? "", numeric[1] ? 16 : 10);
  return decodeNamedCharacterReference(reference.slice(1, -1)) || reference;
}

/** An `id` or `name` attribute inside a tag opening; text that merely spells one renders no anchor. */
const TAG_ID = /<[a-zA-Z][^<>]*?\s(?:id|name)="([^"]+)"/g;

interface Marker extends RegionMarker {
  readonly start: number;
  readonly end: number;
}

/** Each BEGIN through the first END of the same name, as a closed line range; a BEGIN with no END, or a stray END, hides nothing. */
function hiddenRanges(markers: readonly Marker[]): [number, number][] {
  const out: [number, number][] = [];
  for (let i = 0; i < markers.length; i++) {
    const open = markers[i];
    if (open === undefined || open.kind !== "BEGIN") continue;
    const close = markers.findIndex((m, j) => j > i && m.kind === "END" && m.name === open.name);
    const end = markers[close];
    if (end === undefined) continue;
    out.push([open.start, end.end]);
    i = close;
  }
  return out;
}

/**
 * The list's events up to its exit, with those inside a nested list or quote dropped: a blank line
 * there is the nested block's. The nested block's own opening and closing stay, since either ends
 * a stretch after an item marker.
 */
function ownEvents(events: readonly Event[], enter: number): Event[] {
  const list = events[enter]?.[1];
  const own: Event[] = [];
  let nested = 0;
  for (let i = enter + 1; i < events.length; i++) {
    const event = events[i];
    if (event === undefined || event[1] === list) break;

    const [step, token] = event;
    if (token._container) nested += step === "enter" ? 1 : -1;
    if (nested === 0 || token._container) own.push(event);
  }
  return own;
}

/** Whether the walk still sits right after an item marker, where a blank line is the item's empty first line, not a separator. */
function afterMarker(atMarker: boolean, step: Event[0], token: Token): boolean {
  if (token.type === "listItemPrefix") return step === "exit" || atMarker;
  if (token.type === "linePrefix") return atMarker;
  if (token.type === "lineEndingBlank") return step === "exit" && atMarker;
  return false;
}

/**
 * Whether the list's items are separated by blank lines, or one holds a blank line between two
 * blocks, read the way micromark's compiler reads it: a blank line directly in the list, not one
 * inside a nested container and not one right after an item marker. Blank lines after the last
 * item sit after the list's exit and are never seen here.
 */
function isLoose(events: readonly Event[], enter: number): boolean {
  let atMarker = false;
  for (const [step, token] of ownEvents(events, enter)) {
    if (token.type === "lineEndingBlank" && step === "enter" && !atMarker) return true;
    atMarker = afterMarker(atMarker, step, token);
  }
  return false;
}

type Scope =
  | { readonly kind: "list"; readonly loose: boolean; unit: MutableUnit | null }
  | { readonly kind: "quote" };

type MutableUnit = { readonly kind: Unit["kind"]; readonly line: number; text: string };

/** Text gathered while a token is open, and the line of its first visible character. */
interface Collector {
  text: string;
  line: number | null;
}

/**
 * A link or image being read: its destination and its label arrive from nested tokens.
 *   line  -> the destination's, once one is read: a wrapped link is fixed where its target is written
 *   label -> as written, since a definition is matched on source text, not on what it shows
 */
interface Media {
  readonly kind: "link" | "image";
  line: number;
  label: string;
  reference: string | null;
  href: string | null;
}

/** The state of one page's event walk; `scan` is what it yields once the last token has closed. */
interface Walk {
  /** The whole stream: a list's looseness is read ahead from where it opens. */
  readonly events: readonly Event[];

  /** The line ranges a BEGIN/END GENERATED region hides. */
  readonly hidden: readonly [number, number][];

  /** What the page yields, filled as tokens close. */
  readonly scan: Scan;

  /** One per page: GitHub numbers a repeated heading in document order, and so does the site. */
  readonly slugger: GithubSlugger;

  /** The open lists and quotes, innermost last. */
  readonly scopes: Scope[];

  /** The open collected and sunk tokens, innermost last. */
  readonly collectors: Collector[];

  /** The open links and images, innermost last. */
  readonly media: Media[];

  /** Closed links, resolved against the definitions once the whole page is read. */
  readonly pendingLinks: Media[];

  /** By normalized label; a definition's line is where a reference link's destination is written, and where it is fixed. */
  readonly definitions: Map<string, { href: string; line: number }>;

  /** The definition being read, registered when its whole token closes: an empty destination (`<>`) has no destination string. */
  definition: { label: string; href: string; line: number };

  /** The header's cell count: GFM keeps as many cells per row and drops the rest unrendered. */
  columns: number;

  /** The index of the cell being read within its row. */
  column: number;

  /** Whether the cell being read is one GFM drops. */
  overflow: boolean;
}

/** Text the reader sees; the rest of the inline stream is markup (sequences, markers, padding, a task list's checkbox) or hidden (a destination, a title, an alt text) and contributes nothing. */
const VISIBLE = new Set([
  "data",
  "codeTextData",
  "characterEscapeValue",
  "autolinkProtocol",
  "autolinkEmail",
]);

/** Gathered into a collector of its own and dispatched when it closes; a heading's is dropped, its words uncounted, its code spans and links recorded as they closed. */
const COLLECTED = new Set([
  "paragraph",
  "tableHeader",
  "tableData",
  "atxHeading",
  "setextHeading",
  "codeText",
  "labelText",
  "resourceDestinationString",
  "definitionDestinationString",
]);

/** Inline content the reader never sees: an image's alt text, a destination's title, the line breaks inside a comment or a tag wrapped over several lines. */
const SINKS = new Set(["image", "resource", "reference", "definition", "htmlText"]);

/** The GENERATED marker an HTML-flow token spells, with its line range; nothing for any other HTML. */
const regionMarker = (token: Token, context: TokenizeContext): Marker[] => {
  const marker = parseMarker(context.sliceSerialize(token));
  return marker === null ? [] : [{ ...marker, start: token.start.line, end: token.end.line }];
};

/** Whether a line sits inside a BEGIN/END GENERATED region. */
function isHidden(walk: Walk, line: number): boolean {
  return walk.hidden.some(([from, to]) => line >= from && line <= to);
}

/** Inside an image's alt text or a dropped cell nothing is recorded: the reader never sees it. */
function muted(walk: Walk): boolean {
  return walk.overflow || walk.media.some((m) => m.kind === "image");
}

/** Whether a code span or a link at `line` is one the reader sees, so the probes read it. */
function record(walk: Walk, line: number): boolean {
  return !muted(walk) && !isHidden(walk, line);
}

/** A piece of text lands in the innermost open collector, which takes the line of its first visible character. */
function append(walk: Walk, piece: string, line: number | null): void {
  const top = walk.collectors.at(-1);
  if (top === undefined) return;
  top.text += piece;
  if (top.line === null && piece.trim() !== "") top.line = line;
}

/** Every `id` or `name` the tags of an HTML stretch carry; a comment renders no tag. */
function tagIds(walk: Walk, html: string): void {
  const tags = html.replace(/<!--[\s\S]*?-->/g, "").matchAll(TAG_ID);
  for (const m of tags) if (m[1] !== undefined) walk.scan.anchors.add(m[1]);
}

/** A new item marker ends the item before it, so the next paragraph opens a unit of its own. */
function startItem(walk: Walk): void {
  const list = walk.scopes.at(-1);
  if (list?.kind === "list") list.unit = null;
}

/** A comment says nothing; a tag is at most a break between words, and may carry an id. */
function enterHtmlText(walk: Walk, html: string): void {
  tagIds(walk, html);
  append(walk, html.startsWith("<!--") ? "" : " ", null);
}

function enterVisible(walk: Walk, token: Token, context: TokenizeContext): void {
  const text = context.sliceSerialize(token);
  const line = token.start.line;
  append(walk, text, line);

  if (token.type === "autolinkProtocol" && record(walk, line))
    walk.scan.links.push({ href: text, line });
  if (token.type === "autolinkEmail" && record(walk, line))
    walk.scan.links.push({ href: `mailto:${text}`, line });
}

/**
 * A tight item's prose is one unit however a fence or a heading splits it, so the item keeps
 * the unit open until its next marker; a loose item's paragraphs stand alone.
 */
function emitParagraph(walk: Walk, c: Collector): void {
  if (c.line === null || isHidden(walk, c.line)) return;

  const top = walk.scopes.at(-1);
  if (top?.kind !== "list" || top.loose) {
    walk.scan.units.push({ kind: "paragraph", line: c.line, text: c.text });
  } else if (top.unit === null) {
    top.unit = { kind: "item", line: c.line, text: c.text };
    walk.scan.units.push(top.unit);
  } else top.unit.text += `\n${c.text}`;
}

/** A cell within the header's column count is a unit; a cell GFM drops is not. */
function emitCell(walk: Walk, c: Collector): void {
  if (c.line !== null && !walk.overflow && !isHidden(walk, c.line))
    walk.scan.units.push({ kind: "cell", line: c.line, text: c.text });
  walk.overflow = false;
}

function exitCodeText(walk: Walk, c: Collector, line: number): void {
  // GFM lets a cell hold a pipe inside code only escaped, and renders the pipe alone; an
  // escaped backslash stays as written, as in the table extension's own compiler.
  const code =
    walk.columns > 0 ? c.text.replace(/\\([\\|])/g, (m, ch) => (ch === "|" ? ch : m)) : c.text;
  append(walk, code, c.line);
  if (record(walk, line)) walk.scan.codespans.push({ text: code, line });
}

/** A closed link waits for the definitions; an image is dropped with its alt text. */
function exitMedia(walk: Walk): void {
  const done = walk.media.pop();
  if (done?.kind === "link" && record(walk, done.line)) walk.pendingLinks.push(done);
}

/** A label's first definition wins, as CommonMark reads it. */
function exitDefinition(walk: Walk): void {
  const key = normalizeIdentifier(walk.definition.label);
  if (!walk.definitions.has(key))
    walk.definitions.set(key, { href: walk.definition.href, line: walk.definition.line });
}

function enterToken(walk: Walk, event: Event, index: number): void {
  const [, token, context] = event;
  const type = token.type;
  const source = () => context.sliceSerialize(token);
  const target = walk.media.at(-1);

  switch (type) {
    case "listUnordered":
    case "listOrdered":
      walk.scopes.push({ kind: "list", loose: isLoose(walk.events, index), unit: null });
      break;
    case "blockQuote":
      walk.scopes.push({ kind: "quote" });
      break;
    case "listItemPrefix":
      startItem(walk);
      break;
    case "table":
      walk.columns = 0;
      break;
    case "tableRow":
      walk.column = 0;
      break;
    case "tableHeader":
      walk.columns++;
      break;
    case "tableData":
      walk.overflow = walk.column >= walk.columns;
      walk.column++;
      break;
    case "link":
    case "image":
      walk.media.push({
        kind: type,
        line: token.start.line,
        label: "",
        reference: null,
        href: null,
      });
      break;
    case "referenceString":
      if (target) target.reference = source();
      break;
    case "resource":
      // `[a]()` is an inline link with an empty destination, not a reference.
      if (target) target.href = "";
      break;
    case "definition":
      walk.definition = { label: "", href: "", line: token.start.line };
      break;
    case "definitionLabelString":
      walk.definition.label = source();
      break;
    case "htmlFlow":
      tagIds(walk, source());
      break;
    case "htmlText":
      enterHtmlText(walk, source());
      break;
    case "characterReference":
      append(walk, decodeCharacterReference(source()), token.start.line);
      break;
    case "lineEnding":
      append(walk, "\n", null);
      break;
    default:
      if (VISIBLE.has(type)) enterVisible(walk, token, context);
  }

  if (COLLECTED.has(type) || SINKS.has(type)) walk.collectors.push({ text: "", line: null });
}

function exitCollected(walk: Walk, token: Token, context: TokenizeContext): void {
  const c = walk.collectors.pop();
  if (c === undefined) return;

  const target = walk.media.at(-1);
  switch (token.type) {
    case "paragraph":
      emitParagraph(walk, c);
      break;
    case "atxHeading":
    case "setextHeading":
      // The rendered text is slugged, so a tag's break and a wrapped line are one space each.
      walk.scan.anchors.add(walk.slugger.slug(c.text.replace(/\s+/g, " ").trim()));
      break;
    case "tableHeader":
    case "tableData":
      emitCell(walk, c);
      break;
    case "codeText":
      exitCodeText(walk, c, token.start.line);
      break;
    case "labelText":
      append(walk, c.text, c.line);
      if (target) target.label = context.sliceSerialize(token);
      break;
    case "resourceDestinationString":
      if (target) {
        target.href = c.text;
        target.line = token.start.line;
      }
      break;
    case "definitionDestinationString":
      walk.definition.href = c.text;
      walk.definition.line = token.start.line;
      break;
  }
}

function exitToken(walk: Walk, event: Event): void {
  const [, token, context] = event;
  const type = token.type;

  switch (type) {
    case "listUnordered":
    case "listOrdered":
    case "blockQuote":
      walk.scopes.pop();
      break;
    case "table":
      walk.columns = 0;
      break;
    case "link":
    case "image":
      exitMedia(walk);
      break;
    case "definition":
      exitDefinition(walk);
      break;
  }

  if (SINKS.has(type)) walk.collectors.pop();
  if (COLLECTED.has(type)) exitCollected(walk, token, context);
}

/** Where a closed link points: its own destination, or its definition's, which is where a reference link is fixed. */
function resolvedLink(walk: Walk, m: Media): { href: string; line: number } | undefined {
  if (m.href !== null) return { href: m.href, line: m.line };
  return walk.definitions.get(normalizeIdentifier(m.reference ?? m.label));
}

function newWalk(events: readonly Event[]): Walk {
  const markers = events.flatMap(([step, token, context]) =>
    step === "enter" && token.type === "htmlFlow" ? regionMarker(token, context) : [],
  );
  return {
    events,
    hidden: hiddenRanges(markers),
    scan: { units: [], codespans: [], links: [], anchors: new Set() },
    slugger: new GithubSlugger(),
    scopes: [],
    collectors: [],
    media: [],
    pendingLinks: [],
    definitions: new Map(),
    definition: { label: "", href: "", line: 0 },
    columns: 0,
    column: 0,
    overflow: false,
  };
}

/** What one page yields, read off micromark's event stream: every token's opening and closing moves the walk, and the reference links resolve once every definition is read. */
export function scanPage(text: string): Scan {
  const events = postprocess(
    parse({ extensions: [gfmStrikethrough(), gfmTable(), gfmTaskListItem()] })
      .document()
      .write(preprocess()(blankFrontMatter(text), undefined, true)),
  );
  const walk = newWalk(events);

  for (const [index, event] of events.entries()) {
    if (event[0] === "enter") enterToken(walk, event, index);
    else exitToken(walk, event);
  }

  // A reference link is a link only where its definition exists, so the lookup always lands.
  for (const m of walk.pendingLinks) {
    const link = resolvedLink(walk, m);
    if (link !== undefined) walk.scan.links.push(link);
  }

  return walk.scan;
}

export function wordCount(text: string): number {
  return text.split(/\s+/).filter(Boolean).length;
}

const SCHEME = /^[a-z][a-z0-9+.-]*:/i;
const EXTENSION = /\.[a-z0-9]{1,10}$/i;
const MARKDOWN = /\.(?:md|markdown)$/i;

/** The repository path a backticked token names, or null when the token is not one. */
export function pathCandidate(token: string): string | null {
  let path = token
    .trim()
    .replace(/[.,;:]+$/, "")
    .replace(/:\d+(?:-\d+)?$/, "")
    .replace(/[.,;:]+$/, "");
  if (path === "" || /[<>*?${}|\s~[\]]/.test(path) || SCHEME.test(path) || /^[-/]/.test(path))
    return null;
  if (path.startsWith("./") || path.startsWith("../") || path.endsWith("/")) {
    path = path.replace(/\/$/, "");
    return path === "" || path === "." || path === ".." ? null : path;
  }
  return path.includes("/") && EXTENSION.test(path) ? path : null;
}

/** `file` under `root` as a slash path: the form git lists and a finding shows, on every platform. */
function slashRelative(root: string, file: string): string {
  return relative(root, file).split(sep).join("/");
}

/** The root, the page's directory, and every directory between: a skill's reference page names `scripts/x.mts` from the skill folder. */
function bases(root: string, pageDir: string): string[] {
  const out = [pageDir];
  for (let dir = pageDir; dir !== root && dir.startsWith(root); dir = dirname(dir))
    out.push(dirname(dir));
  return out;
}

/**
 * A slash path that resolves outside the root escapes the repository. Inside it, a path is missing
 * only when its first segment is tracked at one of the bases: `agents/openai.yaml` in a page about
 * some other layout names nothing here and is left alone, while `skills/gone/SKILL.md` under a
 * tracked `skills/` is the stale pointer the probe exists for.
 */
function verdict(
  tracked: TrackedPaths,
  root: string,
  pageDir: string,
  path: string,
): "ok" | "missing" | "foreign" | "outside" {
  const owned = (file: string) => tracked.has(slashRelative(root, file));
  if (path.startsWith("./") || path.startsWith("../")) {
    const file = resolve(pageDir, path);
    if (!isInside(root, file)) return "outside";
    return owned(file) ? "ok" : "missing";
  }
  const dirs = bases(root, pageDir);
  const files = dirs.map((base) => resolve(base, path));
  if (files.some(owned)) return "ok";
  if (files.some((file) => !isInside(root, file))) return "outside";
  const first = path.split("/")[0] ?? "";
  return dirs.some((base) => owned(resolve(base, first))) ? "missing" : "foreign";
}

/** The page under probe: `file` as a finding names it, `dir` where its relative paths resolve, `root` the repository they must stay inside. */
interface Page {
  readonly file: string;
  readonly dir: string;
  readonly root: string;
}

/** The fragment as the browser matches it against an id: percent-escapes decoded when they are valid. */
function linkFragment(raw: string): string {
  try {
    return decodeURIComponent(raw);
  } catch {
    return raw;
  }
}

/** The finding's text for a unit over its cap, with the fix the kind calls for. */
function capMessage(kind: Unit["kind"], words: number, cap: number): string {
  if (kind === "cell")
    return `table cell of ${words} words; the cap is ${cap}. Move the explanation below the table`;
  const noun = kind === "item" ? "list item" : "paragraph";
  return `${noun} of ${words} words; the cap is ${cap}. Split it, or turn its facts into bullets, a table, or numbered steps`;
}

/** Every unit over its cap: a cell against the cell cap, a paragraph or an item against the word cap. */
function wordCapFindings(units: readonly Unit[], page: Page, options: ProbeOptions): Finding[] {
  const findings: Finding[] = [];
  for (const unit of units) {
    const words = wordCount(unit.text);
    const cap = unit.kind === "cell" ? options.maxCellWords : options.maxWords;
    if (words > cap)
      findings.push({
        file: page.file,
        line: unit.line,
        message: capMessage(unit.kind, words, cap),
      });
  }
  return findings;
}

/** Every backticked path that names nothing git tracks, or resolves outside the repository. */
function pathFindings(codespans: Scan["codespans"], page: Page, tracked: TrackedPaths): Finding[] {
  const findings: Finding[] = [];
  for (const { text: code, line } of codespans) {
    const path = pathCandidate(code);
    if (path === null) continue;

    const state = verdict(tracked, page.root, page.dir, path);
    if (state === "missing")
      findings.push({ file: page.file, line, message: `\`${path}\` does not exist` });
    if (state === "outside")
      findings.push({ file: page.file, line, message: `\`${path}\` escapes the repository` });
  }
  return findings;
}

/** Every relative link whose target is missing or outside the repository; a URL or an absolute path is not judged. */
function linkTargetFindings(links: Scan["links"], page: Page): Finding[] {
  const findings: Finding[] = [];
  for (const { href, line } of links) {
    const target = linkFile(href);
    if (target === "" || SCHEME.test(target) || isAbsolute(target)) continue;

    const resolved = resolve(page.dir, target);
    if (!isInside(page.root, resolved)) {
      findings.push({
        file: page.file,
        line,
        message: `link target ${target} escapes the repository`,
      });
    } else if (!existsSync(resolved)) {
      findings.push({ file: page.file, line, message: `link target ${target} does not exist` });
    }
  }
  return findings;
}

/** The fragment and target of a link that names an anchor the probe judges; null for no fragment, a URL, or an absolute path. */
function anchorLink(href: string): { readonly fragment: string; readonly target: string } | null {
  const hash = href.indexOf("#");
  if (hash === -1) return null;

  const fragment = linkFragment(href.slice(hash + 1));
  const target = linkFile(href);
  if (fragment === "" || SCHEME.test(target) || isAbsolute(target)) return null;

  return { fragment, target };
}

/**
 * The ids a linked page renders, read once per target. A target that is missing or outside the
 * repository was reported by the link check, and a fragment on a file that is not markdown (a line
 * number in a source file) names nothing a heading could answer: null, and the fragment is not judged.
 */
function targetAnchors(
  resolved: string,
  root: string,
  cache: Map<string, Set<string>>,
): Set<string> | null {
  if (!MARKDOWN.test(resolved) || !isInside(root, resolved) || !existsSync(resolved)) return null;

  const cached = cache.get(resolved);
  if (cached !== undefined) return cached;

  const anchors = scanPage(readFileSync(resolved, "utf8")).anchors;
  cache.set(resolved, anchors);
  return anchors;
}

/** Every fragment that names no heading slug or tag id on its target page, the page's own ids judged from its scan. */
function anchorFindings(scan: Scan, page: Page): Finding[] {
  const findings: Finding[] = [];
  const anchorsOf = new Map<string, Set<string>>();
  for (const { href, line } of scan.links) {
    const link = anchorLink(href);
    if (link === null) continue;

    const anchors =
      link.target === ""
        ? scan.anchors
        : targetAnchors(resolve(page.dir, link.target), page.root, anchorsOf);
    if (anchors === null || anchors.has(link.fragment)) continue;

    const shown = link.target === "" ? page.file : link.target;
    findings.push({
      file: page.file,
      line,
      message: `anchor #${link.fragment} not found on ${shown}`,
    });
  }
  return findings;
}

export function probePage(text: string, file: string, options: ProbeOptions): Finding[] {
  const page: Page = { file, dir: dirname(resolve(options.root, file)), root: options.root };
  const scan = scanPage(text);
  const findings = wordCapFindings(scan.units, page, options);
  if (options.tracked === null) return findings;

  findings.push(...pathFindings(scan.codespans, page, options.tracked));
  findings.push(...linkTargetFindings(scan.links, page));
  findings.push(...anchorFindings(scan, page));
  return findings.sort((a, b) => a.line - b.line);
}

const USAGE = [
  "usage: bun scripts/docs_probe.mts [--root <dir>] [--max-words <n>] [--max-cell-words <n>] [--shape-only] <page.md>...",
  "  --root             the repository root paths resolve against; what git tracks there is what exists (default: cwd)",
  "  --max-words        the cap on a paragraph or list item (default: 70)",
  "  --max-cell-words   the cap on a table cell (default: 15)",
  "  --shape-only       word counts only; skip the checks that named paths, link targets, and anchors exist",
  "exit 0: every page is clean; 1: findings, one per line as page:line: message; 2: usage, an unreadable page, or a root git cannot list",
].join("\n");

interface CliOptions {
  readonly root: string;
  readonly maxWords: number;
  readonly maxCellWords: number;
  readonly paths: boolean;
  readonly pages: readonly string[];
}

/** Symlinked temp dirs (macOS /var -> /private/var) would otherwise make the page label a ../ chain. */
function realpath(path: string): string {
  const absolute = resolve(path);
  return existsSync(absolute) ? realpathSync.native(absolute) : absolute;
}

export function parseArgs(argv: readonly string[]): CliOptions {
  const refuse: Refuser = usageRefuser(USAGE);
  const { values, positionals } = parseArgv(
    {
      args: [...argv],
      options: {
        root: { type: "string", default: process.cwd() },
        "max-words": { type: "string" },
        "max-cell-words": { type: "string" },
        "shape-only": { type: "boolean", default: false },
      },
      allowPositionals: true,
    },
    refuse,
  );
  const root = realpath(values.root);
  if (!statSync(root, { throwIfNoEntry: false })?.isDirectory())
    throw new Error(`--root ${root} is not a directory`);
  const maxWords =
    values["max-words"] === undefined
      ? DEFAULT_MAX_WORDS
      : positiveInteger("--max-words", values["max-words"], refuse);
  const maxCellWords =
    values["max-cell-words"] === undefined
      ? DEFAULT_MAX_CELL_WORDS
      : positiveInteger("--max-cell-words", values["max-cell-words"], refuse);
  if (positionals.length === 0) throw new Error(USAGE);
  return { root, maxWords, maxCellWords, paths: !values["shape-only"], pages: positionals };
}

if (import.meta.main) {
  let options: CliOptions;
  const findings: Finding[] = [];
  try {
    options = parseArgs(process.argv.slice(2));
    const probe: ProbeOptions = {
      root: options.root,
      maxWords: options.maxWords,
      maxCellWords: options.maxCellWords,
      tracked: options.paths ? trackedPaths(gitTrackedFiles(options.root)) : null,
    };
    for (const page of options.pages) {
      const absolute = realpath(page);
      if (!statSync(absolute, { throwIfNoEntry: false })?.isFile())
        throw new Error(`${page} is not a readable file`);
      const label = slashRelative(options.root, absolute) || page;
      findings.push(...probePage(readFileSync(absolute, "utf8"), label, probe));
    }
  } catch (error) {
    console.error(`docs-probe: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(2);
  }
  if (findings.length === 0) {
    console.log(
      `docs-probe: ${options.pages.length} page(s) clean (cap ${options.maxWords} words, ${options.maxCellWords} per table cell)`,
    );
    process.exit(0);
  }
  console.error(`docs-probe: ${findings.length} finding(s)`);
  for (const finding of findings)
    console.error(`  ${finding.file}:${finding.line}: ${finding.message}`);
  process.exit(1);
}
