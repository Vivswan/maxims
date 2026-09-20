#!/usr/bin/env bun
// The page probe of /docs-discipline: the readings a reviewer otherwise
// takes by eye, made exact.
//   a paragraph or list item over the word cap (default 70)  -> finding, exit 1
//   a table cell over the cell cap (default 15)              -> finding, exit 1
//   a repository path the prose names that does not exist    -> finding, exit 1
// Block structure comes from Bun's Markdown renderer, so what counts as prose
// is what Markdown renders as a paragraph or a tight list item, and a table
// contributes its cells, each against the cell cap: headings, code (fenced or
// indented), raw HTML, and images contribute nothing.
// Front matter is blanked before rendering; a BEGIN/END GENERATED region is
// dropped where the renderer sees its markers as HTML blocks, so a marker
// quoted inside a fence is code and changes nothing.
// A path is a backticked token with a slash and an extension (or ./, ../, a
// trailing slash), or a relative link destination; placeholders (<...>),
// globs, owner/repo slugs, and bare file names are left alone, since a page
// may name files the reader will create.

import { existsSync, readFileSync, realpathSync, statSync } from "node:fs";
import { dirname, isAbsolute, relative, resolve } from "node:path";

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
  readonly line: number;
  /** The prose as the reader sees it: link labels and code spans kept, markup gone. */
  readonly text: string;
}

export interface Scan {
  readonly units: Unit[];
  readonly codespans: { readonly text: string; readonly line: number }[];
  readonly links: { readonly href: string; readonly line: number }[];
}

// Marker bytes the renderer callbacks emit; blocks nest, inlines do not. P and L are prose
// (paragraph, list item), D a table cell; N is a block whose paths and links are checked but whose
// words are not counted; T is a table and R one of its rows, which only steer the line locator; S is
// a skipped block (code, raw HTML) carrying its source text, which the locator steps over.
const OPEN = "";
const INLINE_END = "";
const BLOCK_END = "";
const isBlockKind = (ch: string | undefined) =>
  ["P", "L", "D", "N", "T", "R", "S"].includes(ch ?? "");

/** The page with front matter blanked, line for line, so line numbers still match the file. */
function blankFrontMatter(text: string): string[] {
  const lines = text.split("\n").map((line) => line.replace(/\r$/, ""));
  const out = [...lines];
  // Only a closed block is front matter; a lone --- is a thematic break and the page is prose.
  if (lines[0] === "---") {
    const close = lines.indexOf("---", 1);
    if (close !== -1) for (let i = 0; i <= close; i++) out[i] = "";
  }
  return out;
}

// A blank line, or one that is only a blockquote prefix, such as the lines before a table.
const isBlank = (line: string) => /^\s*(>\s*)*$/.test(line);

/**
 * A source line and a raw content line reduced to one form: indentation and container prefixes
 * (blockquote, list marker) removed from both, so they compare equal wherever the renderer
 * stripped them.
 */
const bare = (line: string) => line.replace(/^\s*(?:>\s*|[-*+]\s+|\d{1,9}[.)]\s+)*/, "").trim();

// The separator under a table's header. A lone --- (a thematic break or a setext underline) is
// not one, hence the pipe.
const isSeparatorRow = (line: string) => {
  const body = bare(line);
  if (!body.includes("|")) return false;
  const cells = body.replace(/^\|/, "").replace(/\|$/, "").split("|");
  return cells.every((cell) => /^\s*:?-+:?\s*$/.test(cell));
};

const ENTITIES: Record<string, string> = {
  "&amp;": "&",
  "&lt;": "<",
  "&gt;": ">",
  "&quot;": '"',
  "&#39;": "'",
};
const unescapeEntities = (s: string) =>
  s.replace(/&(?:amp|lt|gt|quot|#39);/g, (m) => ENTITIES[m] ?? m);

/** Characters at block depth 0 of `s`: nested block segments (and their contents) removed, inline markers kept. */
function ownText(s: string): string {
  let out = "";
  let depth = 0;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i] as string;
    if (ch === OPEN && isBlockKind(s[i + 1])) depth++;
    else if (ch === BLOCK_END) depth--;
    else if (depth === 0) out += ch;
  }
  return out;
}

/** The nested block segments of `s`, in order, each with its markers. */
function nestedBlocks(s: string): string[] {
  const blocks: string[] = [];
  let depth = 0;
  let start = -1;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (ch === OPEN && isBlockKind(s[i + 1])) {
      if (depth === 0) start = i;
      depth++;
    } else if (ch === BLOCK_END) {
      depth--;
      if (depth === 0 && start !== -1) {
        blocks.push(s.slice(start, i + 1));
        start = -1;
      }
    }
  }
  return blocks;
}

/** Removes HTML comments innermost-first until none opens, so remains never reassemble into one. */
function stripComments(text: string): string {
  let out = text;
  for (let open = out.indexOf("<!--"); open !== -1; open = out.indexOf("<!--")) {
    const close = out.indexOf("-->", open + 4);
    out = close === -1 ? out.slice(0, open) : out.slice(0, open) + out.slice(close + 3);
  }
  return out;
}

/** Cuts each BEGIN region through the END marker of the same name; a BEGIN with no matching END, or a stray END, hides nothing. */
function dropGeneratedRegions(stream: string): string {
  let out = stream;
  const begin = new RegExp(`${OPEN}G([^${BLOCK_END}]*)${BLOCK_END}`);
  for (let m = begin.exec(out); m; m = begin.exec(out)) {
    const close = `${OPEN}g${m[1]}${BLOCK_END}`;
    const at = out.indexOf(close, m.index + m[0].length);
    out =
      at === -1
        ? out.slice(0, m.index) + out.slice(m.index + m[0].length)
        : out.slice(0, m.index) + out.slice(at + close.length);
  }
  return out.replace(new RegExp(`${OPEN}g[^${BLOCK_END}]*${BLOCK_END}`, "g"), "");
}

// Inline markers with the code text or the href captured.
const CODESPAN = `${OPEN}C([^${INLINE_END}]*)${INLINE_END}`;
const LINK = `${OPEN}A([^${INLINE_END}]*)${INLINE_END}`;

/**
 * The prose as the reader sees it. Inline HTML is invisible (a comment says nothing, a tag is at
 * most a break) and is dropped; a code span shows every character, so `<name>` inside one is a word.
 */
function visibleText(own: string): string {
  return own
    .replace(new RegExp(LINK, "g"), "")
    .split(new RegExp(`(${OPEN}C[^${INLINE_END}]*${INLINE_END})`))
    .map((part, index) =>
      index % 2 === 1 ? part.slice(2, -1) : stripComments(part.replace(/<\/?[a-zA-Z][^>]*>/g, " ")),
    )
    .join("");
}

export function scanPage(text: string): Scan {
  const lines = blankFrontMatter(text);
  const nothing = () => "";
  const same = (c: string) => c;
  const stream = Bun.markdown.render(lines.join("\n"), {
    text: same,
    strong: same,
    emphasis: same,
    strikethrough: same,
    blockquote: same,
    list: same,
    heading: (c: string) => `${OPEN}N${c}${BLOCK_END}`,
    code: (c: string) => `${OPEN}S${c}${BLOCK_END}`,
    table: (c: string) => `${OPEN}T${c}${BLOCK_END}`,
    tr: (c: string) => `${OPEN}R${c}${BLOCK_END}`,
    th: (c: string) => `${OPEN}D${c}${BLOCK_END}`,
    td: (c: string) => `${OPEN}D${c}${BLOCK_END}`,
    html: (c: string) => {
      // Only the documented marker comment, with its name, opens or closes a region. The skipped
      // block after a marker outlives the region cut when the marker closes one, so the cursor
      // passes the END line and the rows the region hid.
      const begin = /^\s*<!-- BEGIN GENERATED: (\S+)/.exec(c);
      const end = /^\s*<!-- END GENERATED: (\S+)/.exec(c);
      const skipped = `${OPEN}S${c}${BLOCK_END}`;
      if (begin) return `${OPEN}G${begin[1]}${BLOCK_END}${skipped}`;
      if (end) return `${OPEN}g${end[1]}${BLOCK_END}${skipped}`;
      return skipped;
    },
    hr: nothing,
    image: nothing,
    codespan: (c: string) => `${OPEN}C${c}${INLINE_END}`,
    link: (c: string, attrs: { href?: string }) => `${OPEN}A${attrs.href ?? ""}${INLINE_END}${c}`,
    paragraph: (c: string) => `${OPEN}P${c}${BLOCK_END}`,
    listItem: (c: string) => `${OPEN}L${c}${BLOCK_END}`,
  });

  const prose = dropGeneratedRegions(stream);

  const scan: Scan = { units: [], codespans: [], links: [] };
  let cursor = 0;
  // Rendered text has lost its markup (**bold**, [label](url) with the url between label and text),
  // so a line matches when it carries the unit's first two words, letters and digits only.
  const letters = (text: string) => text.replace(/[^A-Za-z0-9]+/g, "");
  const search = (needle: string): number => {
    const probes = unescapeEntities(needle).split(/\s+/).map(letters).filter(Boolean).slice(0, 2);
    if (probes.length === 0) return -1;
    for (let i = cursor; i < lines.length; i++) {
      const line = letters(lines[i] ?? "");
      if (probes.every((probe) => line.includes(probe))) return i;
    }
    return -1;
  };
  // Inside a table every unit sits on its row's line, which the table fixes; nothing is searched.
  let rowLine: number | null = null;
  const locate = (needle: string): number => {
    if (rowLine !== null) return rowLine;
    const found = search(needle);
    return found === -1 ? cursor : found;
  };
  const KINDS: Record<string, Unit["kind"] | undefined> = { P: "paragraph", L: "item", D: "cell" };
  // A skipped block's source lines pass under the cursor, or a fence quoting a table example would
  // be where the next table's header is looked for. Its content is verbatim source, so its first
  // non-blank line is matched whole: a line may have no letters at all, and a fence's info string
  // may repeat one. Fenced content excludes its fences, so the cursor lands on the closer.
  const skipRaw = (raw: string) => {
    const rawLines = raw.replace(/\n$/, "").split("\n");
    const start = rawLines.findIndex((l) => bare(l) !== "");
    if (start === -1) return;
    const needle = bare(rawLines[start] ?? "");
    const found = lines.findIndex((line, i) => i >= cursor && bare(line) === needle);
    if (found !== -1) cursor = found - start + rawLines.length;
  };
  // A table's rows are consecutive source lines: the header, its separator, then one line per body
  // row. No cell's text is searched for: a body row may repeat the header's words while the header
  // itself (a link with a suffix, an empty cell) matches nothing, so the separator anchors it.
  const visitTable = (inner: string) => {
    const rows = nestedBlocks(inner);
    const found = lines.findIndex(
      (line, i) => i >= cursor && !isBlank(line) && isSeparatorRow(lines[i + 1] ?? ""),
    );
    const header = found === -1 ? cursor : found;
    rows.forEach((row, index) => {
      rowLine = index === 0 ? header : header + 1 + index;
      visit(row);
    });
    rowLine = null;
    cursor = header + 1 + rows.length;
  };
  const visit = (block: string) => {
    const inner = block.slice(2, -1);
    if (block[1] === "S") {
      skipRaw(inner);
      return;
    }
    if (block[1] === "T") {
      visitTable(inner);
      return;
    }
    const kind = KINDS[block[1] ?? ""];
    const own = ownText(inner);
    const plain = visibleText(own);
    const firstLine = plain.split("\n").find((l) => l.trim() !== "") ?? "";
    const line = locate(firstLine);
    if (kind !== undefined && plain.trim() !== "") {
      scan.units.push({ kind, line: line + 1, text: unescapeEntities(plain) });
    }
    for (const m of own.matchAll(new RegExp(CODESPAN, "g"))) {
      const code = unescapeEntities(m[1] ?? "");
      scan.codespans.push({ text: code, line: locate(`\`${code}\``) + 1 });
    }
    for (const m of own.matchAll(new RegExp(LINK, "g"))) {
      const href = unescapeEntities(m[1] ?? "");
      scan.links.push({ href, line: locate(href) + 1 });
    }
    // The next unit starts after this one, so a repeated opening line finds its own line, not this
    // one again; a table moves the cursor itself, past its last row.
    if (plain.trim() !== "" && rowLine === null) cursor = line + plain.trim().split("\n").length;
    for (const nested of nestedBlocks(inner)) visit(nested);
  };
  for (const block of nestedBlocks(prose)) visit(block);
  return scan;
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
  return findings.sort((a, b) => a.line - b.line);
}

const USAGE = [
  "usage: docs-probe.mts [--root <dir>] [--max-words <n>] [--max-cell-words <n>] [--shape-only] <page.md>...",
  "  --root             the repository root paths resolve against (default: cwd)",
  "  --max-words        the cap on a paragraph or list item (default: 70)",
  "  --max-cell-words   the cap on a table cell (default: 15)",
  "  --shape-only       word counts only; skip the check that named paths exist",
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
