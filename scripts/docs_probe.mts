#!/usr/bin/env bun
// The page probe of /docs-discipline: the readings a reviewer otherwise
// takes by eye, made exact.
//   a paragraph or list item over the word cap (default 70)  -> finding, exit 1
//   a table cell over the cell cap (default 15)              -> finding, exit 1
//   a repository path the prose names that does not exist    -> finding, exit 1
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
// may name files the reader will create.
// An anchor is judged against the ids the target page renders: each heading's
// slug as GitHub and the docs site make it (github-slugger, repeats numbered)
// and an `id` or `name` attribute on a tag; a comment renders no tag.

import { existsSync, readFileSync, realpathSync, statSync } from "node:fs";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import { decodeNamedCharacterReference } from "decode-named-character-reference";
import GithubSlugger from "github-slugger";
import { parse, postprocess, preprocess } from "micromark";
import { gfmStrikethrough } from "micromark-extension-gfm-strikethrough";
import { gfmTable } from "micromark-extension-gfm-table";
import { gfmTaskListItem } from "micromark-extension-gfm-task-list-item";
import { decodeNumericCharacterReference } from "micromark-util-decode-numeric-character-reference";
import { normalizeIdentifier } from "micromark-util-normalize-identifier";
import type { Event, Token, TokenizeContext } from "micromark-util-types";

export const DEFAULT_MAX_WORDS = 70;
export const DEFAULT_MAX_CELL_WORDS = 15;

export interface Finding {
  readonly file: string;
  /** One-based line where the unit or token starts. */
  readonly line: number;
  readonly message: string;
}

export interface ProbeOptions {
  /** Repository root every slash path resolves against. */
  readonly root: string;
  readonly maxWords: number;
  /** The cap on one table cell; a cell holds one fact, and the explanation goes below the table. */
  readonly maxCellWords: number;
  /** false: word counts only, for pages that describe another repository's files. */
  readonly paths: boolean;
}

export interface Unit {
  readonly kind: "paragraph" | "item" | "cell";
  /** The line of the first word the reader sees, which a tag or a comment opening the unit is not. */
  readonly line: number;
  /** The prose as the reader sees it: link labels and code spans kept, markup gone. */
  readonly text: string;
}

export interface Scan {
  readonly units: Unit[];
  readonly codespans: { readonly text: string; readonly line: number }[];
  readonly links: { readonly href: string; readonly line: number }[];
  /** Every id the rendered page answers a fragment with: heading slugs and tag ids. */
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

/** Only the documented marker comment, with its name, opens or closes a generated region. */
const REGION_MARKER = /^\s*<!-- (BEGIN|END) GENERATED: (\S+)/;

interface Marker {
  readonly kind: "BEGIN" | "END";
  readonly name: string;
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
 * Whether the list's items are separated by blank lines, or one holds a blank line between two
 * blocks, read the way micromark's compiler reads it: a blank line directly in the list, not one
 * inside a nested container and not one right after an item marker. Blank lines after the last
 * item sit after the list's exit and are never seen here.
 */
function isLoose(events: readonly Event[], enter: number): boolean {
  const list = events[enter]?.[1];
  let nested = 0;
  let atMarker = false;
  for (let i = enter + 1; i < events.length; i++) {
    const event = events[i];
    if (event === undefined || event[1] === list) break;
    const [step, token] = event;
    if (token._container) {
      atMarker = false;
      nested += step === "enter" ? 1 : -1;
    } else if (token.type === "listItemPrefix") {
      if (step === "exit") atMarker = true;
    } else if (token.type === "lineEndingBlank") {
      if (step === "enter" && nested === 0) {
        if (!atMarker) return true;
        atMarker = false;
      }
    } else if (token.type !== "linePrefix") atMarker = false;
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

/** A link or image being read: its destination and its label arrive from nested tokens. */
interface Media {
  readonly kind: "link" | "image";
  /** The destination's line once one is read: a wrapped link is fixed where its target is written. */
  line: number;
  /** The label as written, since a definition is matched on source text, not on what it shows. */
  label: string;
  reference: string | null;
  href: string | null;
}

// Tokens whose text the reader sees, as micromark types them. Everything else in the inline
// stream is markup (sequences, markers, padding, a task list's checkbox) or hidden (a destination,
// a title, an alt text) and contributes nothing.
const VISIBLE = new Set([
  "data",
  "codeTextData",
  "characterEscapeValue",
  "autolinkProtocol",
  "autolinkEmail",
]);
// Tokens whose content is gathered into a collector of its own and dispatched when they close. A
// heading's is dropped: its words are not counted, and its code spans and links were recorded as
// they closed.
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
// Tokens whose inline content the reader never sees: an image's alt text, a destination's title,
// the line breaks inside a comment or a tag wrapped over several lines.
const SINKS = new Set(["image", "resource", "reference", "definition", "htmlText"]);

const regionMarker = (token: Token, context: TokenizeContext): Marker[] => {
  const m = REGION_MARKER.exec(context.sliceSerialize(token));
  const kind = m?.[1];
  if (kind !== "BEGIN" && kind !== "END") return [];
  return [{ kind, name: m?.[2] ?? "", start: token.start.line, end: token.end.line }];
};

export function scanPage(text: string): Scan {
  const events = postprocess(
    parse({ extensions: [gfmStrikethrough(), gfmTable(), gfmTaskListItem()] })
      .document()
      .write(preprocess()(blankFrontMatter(text), undefined, true)),
  );
  const hidden = hiddenRanges(
    events.flatMap(([step, token, context]) =>
      step === "enter" && token.type === "htmlFlow" ? regionMarker(token, context) : [],
    ),
  );
  const isHidden = (line: number) => hidden.some(([from, to]) => line >= from && line <= to);

  const units: MutableUnit[] = [];
  const codespans: Scan["codespans"] = [];
  const links: Scan["links"] = [];
  const anchors = new Set<string>();
  // One slugger per page: GitHub numbers a repeated heading in document order, and so does the site.
  const slugger = new GithubSlugger();
  const tagIds = (html: string) => {
    const tags = html.replace(/<!--[\s\S]*?-->/g, "").matchAll(TAG_ID);
    for (const m of tags) if (m[1] !== undefined) anchors.add(m[1]);
  };
  const pendingLinks: Media[] = [];
  // A definition's line is where a reference link's destination is written, and where it is fixed.
  const definitions = new Map<string, { href: string; line: number }>();
  const scopes: Scope[] = [];
  const collectors: Collector[] = [];
  const media: Media[] = [];
  // A definition's destination string is absent when the destination is empty (`<>`), so the
  // definition is registered when the whole token closes; a destination on the line after the
  // label is reported on its own line, where the fix is made.
  let definition = { label: "", href: "", line: 0 };
  // GFM keeps as many cells per row as the header declares and drops the rest unrendered.
  let columns = 0;
  let column = 0;
  let overflow = false;

  const append = (piece: string, line: number | null) => {
    const top = collectors[collectors.length - 1];
    if (top === undefined) return;
    top.text += piece;
    if (top.line === null && piece.trim() !== "") top.line = line;
  };
  // Inside an image's alt text or a dropped cell nothing is recorded: the reader never sees it.
  const muted = () => overflow || media.some((m) => m.kind === "image");
  const record = (line: number) => !muted() && !isHidden(line);

  // A tight item's prose is one unit however a fence or a heading splits it, so the item keeps
  // the unit open until its next marker; a loose item's paragraphs stand alone.
  const emitParagraph = (c: Collector) => {
    if (c.line === null || isHidden(c.line)) return;
    const top = scopes[scopes.length - 1];
    if (top?.kind !== "list" || top.loose) {
      units.push({ kind: "paragraph", line: c.line, text: c.text });
    } else if (top.unit === null) {
      top.unit = { kind: "item", line: c.line, text: c.text };
      units.push(top.unit);
    } else top.unit.text += `\n${c.text}`;
  };

  events.forEach(([step, token, context], index) => {
    const type = token.type;
    const source = () => context.sliceSerialize(token);
    const target = media[media.length - 1];
    if (step === "enter") {
      if (type === "listUnordered" || type === "listOrdered")
        scopes.push({ kind: "list", loose: isLoose(events, index), unit: null });
      else if (type === "blockQuote") scopes.push({ kind: "quote" });
      else if (type === "listItemPrefix") {
        const top = scopes[scopes.length - 1];
        if (top?.kind === "list") top.unit = null;
      } else if (type === "table") columns = 0;
      else if (type === "tableRow") column = 0;
      else if (type === "tableHeader") columns++;
      else if (type === "tableData") overflow = column++ >= columns;
      else if (type === "link" || type === "image") {
        media.push({ kind: type, line: token.start.line, label: "", reference: null, href: null });
      } else if (type === "referenceString") {
        if (target) target.reference = source();
      } else if (type === "definition")
        definition = { label: "", href: "", line: token.start.line };
      else if (type === "definitionLabelString") definition.label = source();
      else if (type === "resource") {
        // `[a]()` is an inline link with an empty destination, not a reference.
        if (target) target.href = "";
      } else if (type === "htmlFlow") tagIds(source());
      else if (type === "htmlText") {
        // A comment says nothing; a tag is at most a break between words, and may carry an id.
        const html = source();
        tagIds(html);
        append(html.startsWith("<!--") ? "" : " ", null);
      } else if (type === "characterReference")
        append(decodeCharacterReference(source()), token.start.line);
      else if (type === "lineEnding") append("\n", null);
      else if (VISIBLE.has(type)) {
        append(source(), token.start.line);
        if (type === "autolinkProtocol" && record(token.start.line))
          links.push({ href: source(), line: token.start.line });
        if (type === "autolinkEmail" && record(token.start.line))
          links.push({ href: `mailto:${source()}`, line: token.start.line });
      }
      if (COLLECTED.has(type) || SINKS.has(type)) collectors.push({ text: "", line: null });
      return;
    }
    if (type === "listUnordered" || type === "listOrdered" || type === "blockQuote") scopes.pop();
    if (type === "table") columns = 0;
    if (type === "link" || type === "image") {
      const done = media.pop();
      if (done?.kind === "link" && record(done.line)) pendingLinks.push(done);
    }
    if (SINKS.has(type)) collectors.pop();
    if (type === "definition") {
      const key = normalizeIdentifier(definition.label);
      if (!definitions.has(key))
        definitions.set(key, { href: definition.href, line: definition.line });
    }
    if (!COLLECTED.has(type)) return;
    const c = collectors.pop();
    if (c === undefined) return;
    if (type === "paragraph") emitParagraph(c);
    else if (type === "atxHeading" || type === "setextHeading") {
      // The rendered text is slugged, so a tag's break and a wrapped line are one space each.
      anchors.add(slugger.slug(c.text.replace(/\s+/g, " ").trim()));
    } else if (type === "tableHeader" || type === "tableData") {
      if (c.line !== null && !overflow && !isHidden(c.line))
        units.push({ kind: "cell", line: c.line, text: c.text });
      overflow = false;
    } else if (type === "codeText") {
      // GFM lets a cell hold a pipe inside code only escaped, and renders the pipe alone; an
      // escaped backslash stays as written, as in the table extension's own compiler.
      const code =
        columns > 0 ? c.text.replace(/\\([\\|])/g, (m, ch) => (ch === "|" ? ch : m)) : c.text;
      append(code, c.line);
      if (record(token.start.line)) codespans.push({ text: code, line: token.start.line });
    } else if (type === "labelText") {
      append(c.text, c.line);
      if (target) target.label = source();
    } else if (type === "resourceDestinationString") {
      if (target) {
        target.href = c.text;
        target.line = token.start.line;
      }
    } else if (type === "definitionDestinationString") {
      definition.href = c.text;
      definition.line = token.start.line;
    }
  });

  // A reference link is a link only where its definition exists, so the lookup always lands.
  for (const m of pendingLinks) {
    if (m.href !== null) links.push({ href: m.href, line: m.line });
    else {
      const defined = definitions.get(normalizeIdentifier(m.reference ?? m.label));
      if (defined !== undefined) links.push(defined);
    }
  }
  return { units, codespans, links, anchors };
}

export function wordCount(text: string): number {
  return text.split(/\s+/).filter(Boolean).length;
}

const SCHEME = /^[a-z][a-z0-9+.-]*:/i;
const EXTENSION = /\.[a-z0-9]{1,10}$/i;

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

/** True when `file` is `root` or sits under it, judged by the relative path so the host's separator does not matter. */
function withinRoot(root: string, file: string): boolean {
  const rel = relative(resolve(root), file);
  return !rel.startsWith("..") && !isAbsolute(rel);
}

/** The root, the page's directory, and every directory between: a skill's reference page names `scripts/x.mts` from the skill folder. */
function bases(root: string, pageDir: string): string[] {
  const out = [pageDir];
  for (let dir = pageDir; dir !== root && dir.startsWith(root); dir = dirname(dir))
    out.push(dirname(dir));
  return out;
}

/**
 * A slash path is checked only when its first segment exists at one of the bases:
 * `agents/openai.yaml` in a page about some other layout names nothing here and is left alone,
 * while `skills/gone/SKILL.md` under a real `skills/` is the stale pointer the probe exists for.
 */
function verdict(
  root: string,
  pageDir: string,
  path: string,
): "ok" | "missing" | "foreign" | "outside" {
  const dirs = path.startsWith("./") || path.startsWith("../") ? [pageDir] : bases(root, pageDir);
  const hits = dirs.map((base) => resolve(base, path)).filter((file) => existsSync(file));
  if (hits.some((file) => withinRoot(root, file))) return "ok";
  if (hits.length > 0) return "outside";
  const first = path.split("/")[0] ?? "";
  const anchored =
    first === "." || first === ".." || dirs.some((base) => existsSync(resolve(base, first)));
  return anchored ? "missing" : "foreign";
}

/** The file a relative link addresses: no fragment, no query, percent-escapes decoded when they are valid. */
function linkPath(href: string): string {
  const bare = href.split("#")[0]?.split("?")[0] ?? "";
  try {
    return decodeURIComponent(bare);
  } catch {
    return bare;
  }
}

export function probePage(text: string, file: string, options: ProbeOptions): Finding[] {
  const findings: Finding[] = [];
  const pageDir = dirname(resolve(options.root, file));
  const scan = scanPage(text);
  for (const unit of scan.units) {
    const words = wordCount(unit.text);
    if (unit.kind === "cell") {
      if (words > options.maxCellWords) {
        findings.push({
          file,
          line: unit.line,
          message: `table cell of ${words} words; the cap is ${options.maxCellWords}. Move the explanation below the table`,
        });
      }
    } else if (words > options.maxWords) {
      const noun = unit.kind === "item" ? "list item" : "paragraph";
      findings.push({
        file,
        line: unit.line,
        message: `${noun} of ${words} words; the cap is ${options.maxWords}. Split it, or turn its facts into bullets, a table, or numbered steps`,
      });
    }
  }
  if (!options.paths) return findings;
  for (const { text: code, line } of scan.codespans) {
    const path = pathCandidate(code);
    const state = path ? verdict(options.root, pageDir, path) : "foreign";
    if (state === "missing") findings.push({ file, line, message: `\`${path}\` does not exist` });
    if (state === "outside")
      findings.push({ file, line, message: `\`${path}\` escapes the repository` });
  }
  for (const { href, line } of scan.links) {
    const target = linkPath(href);
    if (target === "" || SCHEME.test(target) || isAbsolute(target)) continue;
    const resolved = resolve(pageDir, target);
    if (!withinRoot(options.root, resolved)) {
      findings.push({ file, line, message: `link target ${target} escapes the repository` });
    } else if (!existsSync(resolved)) {
      findings.push({ file, line, message: `link target ${target} does not exist` });
    }
  }
  // A fragment is judged on the ids the target page renders. A target that is missing or outside
  // the repository was reported above, and a fragment on a file that is not markdown (a line
  // number in a source file) names nothing a heading could answer.
  const anchorsOf = new Map<string, Set<string>>();
  for (const { href, line } of scan.links) {
    const hash = href.indexOf("#");
    if (hash === -1) continue;
    const fragment = linkFragment(href.slice(hash + 1));
    const target = linkPath(href);
    if (fragment === "" || SCHEME.test(target) || isAbsolute(target)) continue;
    let anchors = scan.anchors;
    if (target !== "") {
      const resolved = resolve(pageDir, target);
      if (!MARKDOWN.test(resolved) || !withinRoot(options.root, resolved) || !existsSync(resolved))
        continue;
      anchors =
        anchorsOf.get(resolved) ??
        (() => {
          const scanned = scanPage(readFileSync(resolved, "utf8")).anchors;
          anchorsOf.set(resolved, scanned);
          return scanned;
        })();
    }
    if (!anchors.has(fragment)) {
      const page = target === "" ? file : target;
      findings.push({ file, line, message: `anchor #${fragment} not found on ${page}` });
    }
  }
  return findings.sort((a, b) => a.line - b.line);
}

const MARKDOWN = /\.(?:md|markdown)$/i;

/** The fragment as the browser matches it against an id: percent-escapes decoded when they are valid. */
function linkFragment(raw: string): string {
  try {
    return decodeURIComponent(raw);
  } catch {
    return raw;
  }
}

const USAGE = [
  "usage: docs-probe.mts [--root <dir>] [--max-words <n>] [--max-cell-words <n>] [--shape-only] <page.md>...",
  "  --root             the repository root paths resolve against (default: cwd)",
  "  --max-words        the cap on a paragraph or list item (default: 70)",
  "  --max-cell-words   the cap on a table cell (default: 15)",
  "  --shape-only       word counts only; skip the checks that named paths, link targets, and anchors exist",
  "exit 0: every page is clean; 1: findings, one per line as page:line: message; 2: usage or an unreadable page",
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
  let root = realpath(process.cwd());
  let maxWords = DEFAULT_MAX_WORDS;
  let maxCellWords = DEFAULT_MAX_CELL_WORDS;
  let paths = true;
  const pages: string[] = [];
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index] ?? "";
    const value = () => {
      const next = argv[++index];
      if (next === undefined) throw new Error(`${arg} needs a value\n${USAGE}`);
      return next;
    };
    if (arg === "--root") {
      root = realpath(value());
      if (!statSync(root, { throwIfNoEntry: false })?.isDirectory())
        throw new Error(`--root ${root} is not a directory`);
    } else if (arg === "--max-words") {
      maxWords = Number(value());
      if (!Number.isInteger(maxWords) || maxWords < 1)
        throw new Error(`--max-words needs a positive integer\n${USAGE}`);
    } else if (arg === "--max-cell-words") {
      maxCellWords = Number(value());
      if (!Number.isInteger(maxCellWords) || maxCellWords < 1)
        throw new Error(`--max-cell-words needs a positive integer\n${USAGE}`);
    } else if (arg === "--shape-only") paths = false;
    else if (arg.startsWith("-")) throw new Error(`unknown option ${arg}\n${USAGE}`);
    else pages.push(arg);
  }
  if (pages.length === 0) throw new Error(USAGE);
  return { root, maxWords, maxCellWords, paths, pages };
}

if (import.meta.main) {
  let options: CliOptions;
  const findings: Finding[] = [];
  try {
    options = parseArgs(process.argv.slice(2));
    for (const page of options.pages) {
      const absolute = realpath(page);
      if (!statSync(absolute, { throwIfNoEntry: false })?.isFile())
        throw new Error(`${page} is not a readable file`);
      const label = relative(options.root, absolute) || page;
      findings.push(...probePage(readFileSync(absolute, "utf8"), label, options));
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
