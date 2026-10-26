#!/usr/bin/env bun
// The page test: every box that names a file names one that exists, every
// symbol after the path is exported by that file, every concept diagram has a
// "Demonstrated by:" line whose links resolve, and the number of concept
// diagrams is pinned. Existence only: a caption-only box passes untouched, and
// a demonstration link is checked to resolve, not to test its diagram's claim.
//
// Label grammar, per <br> segment:
//   starts with a path (top-level directory, slash, segments)  -> binds that path; the rest are its exported symbols
//   no path, a path bound earlier in the label                 -> more symbols of the bound path
//   no path, nothing bound yet                                 -> a caption; a slash or `()` inside it is reported
// A symbol is an ECMAScript identifier name, so `$run` and a Unicode-letter export are symbols too.
// Diagrams inside a generated region are the declaration's, not the author's,
// and need no demonstration line.

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, resolve } from "node:path";
import type { StaticExport, StaticExportEntry } from "oxc-parser";
import { isInside } from "../src/util/fs.ts";
import { parseSync, pathLabel, resolveImport, SOURCE_EXTENSIONS } from "./arch_lint.mts";
import { parseArgv, type Refuser, usageRefuser } from "./lib/argv.ts";
import { linkFile } from "./lib/links.ts";
import { type Fence, type Page, readPage } from "./lib/page.ts";
import { parseMarker, type RegionMarker } from "./lib/region.ts";

const SYMBOL_TOKEN = /^[\p{ID_Start}$_][\p{ID_Continue}$\u200C\u200D]*(?:\(\))?$/u;
const DEMONSTRATED = "Demonstrated by:";

const exportOriginsByFile = new Map<string, ReadonlyMap<string, string>>();

/** A relative `from "./m"` on the entry; a package request, or no request, is undefined. */
function relativeRequest(entry: StaticExportEntry): string | undefined {
  const request = entry.moduleRequest?.value;
  if (request === undefined || !/^\.\.?\//.test(request)) return undefined;
  return request;
}

// `export { x as y } from "./m"`, and `import { x } from "./m"; export { x as y }`, which the
// module record already folds into the same shape, keep the binding of ./m, not a new one here.
function namedExportOrigin(
  file: string,
  name: string,
  entry: StaticExportEntry,
  visiting: ReadonlySet<string>,
): string {
  const request = relativeRequest(entry);
  const imported = entry.importName.kind === "Name" ? entry.importName.name : null;
  if (request === undefined || imported === null) return `${file}#${name}`;

  const target = resolveImport(file, request);
  return exportOrigins(target, visiting).get(imported) ?? `${target}#${imported}`;
}

function addStarredExports(
  starred: Map<string, Set<string>>,
  target: string,
  visiting: ReadonlySet<string>,
): void {
  for (const [name, origin] of exportOrigins(target, visiting)) {
    if (name === "default") continue;

    const origins = starred.get(name) ?? new Set<string>();
    origins.add(origin);
    starred.set(name, origins);
  }
}

interface CollectedExports {
  /** name -> the binding a named or default export declares. */
  direct: Map<string, string>;

  /** name -> every binding a star re-export reached under that name. */
  starred: Map<string, Set<string>>;
}

function collectExports(
  file: string,
  exports: readonly StaticExport[],
  visiting: ReadonlySet<string>,
): CollectedExports {
  const direct = new Map<string, string>();
  const starred = new Map<string, Set<string>>();
  for (const statement of exports) {
    for (const entry of statement.entries) {
      if (entry.exportName.kind === "Default") {
        direct.set("default", `${file}#default`);
        continue;
      }

      if (entry.exportName.name !== null) {
        const origin = namedExportOrigin(file, entry.exportName.name, entry, visiting);
        direct.set(entry.exportName.name, origin);
        continue;
      }

      const request = relativeRequest(entry);
      if (request !== undefined) addStarredExports(starred, resolveImport(file, request), visiting);
    }
  }
  return { direct, starred };
}

// A name reached through two star paths is one export when both end at the same binding and no
// export at all when they do not, as ECMAScript resolves it; a direct export wins over any star.
function withStarredExports(collected: CollectedExports): Map<string, string> {
  const names = new Map(collected.direct);
  for (const [name, origins] of collected.starred) {
    if (names.has(name) || origins.size !== 1) continue;

    names.set(name, [...origins][0] as string);
  }
  return names;
}

/**
 * The names `file` exports, each with the module that declares its binding: `export { a as b }`
 * exports b, a default export is `default`, `export * from` brings the target's names (its default
 * stays behind, as in the language), `export * as ns` is `ns`. A name reached through two star
 * paths is one export when both paths end at the same binding and no export at all when they do
 * not, as ECMAScript resolves it. A star cycle contributes nothing on the second visit; only a
 * top-level result is cached.
 */
export function exportOrigins(
  file: string,
  visiting: ReadonlySet<string> = new Set(),
): ReadonlyMap<string, string> {
  const cached = exportOriginsByFile.get(file);
  if (cached) return cached;

  if (visiting.has(file)) return new Map();

  const inner = new Set([...visiting, file]);
  const { module } = parseSync(file, readFileSync(file, "utf8"));
  const names = withStarredExports(collectExports(file, module.staticExports, inner));
  if (visiting.size === 0) exportOriginsByFile.set(file, names);
  return names;
}

export function exportedNames(file: string): ReadonlySet<string> {
  return new Set(exportOrigins(file).keys());
}

// A node definition wherever it sits: an id, an opening shape run (`[`, `((`, `{{`, `[/`, `[\`, `>` ...), and what follows it.
const NODE_DEFINITION = /(?<![\w"-])([A-Za-z_][\w-]*)([[({>]+[/\\]?)(?![-|])/g;

// The quoted label and its closing shape run, a slanted shape's `/` or `\` before the bracket included.
const QUOTED_LABEL = /^"([^"]*)"[/\\]?[\])}]+/;

// Edge-label text is not a node: `-->|run()|`, `-- run() -->`, `== run() ==>`, `-. run() .->`. Text-form label text holds no node or arrow character, so `a --- b["x"] --> c` is two bare links, not one label.
const EDGE_LABEL = /\|[^|\n]*\||(?:--|==|-\.)\s[^\n[\](){}|>=.-]+\s(?:-->|---|==>|===|\.->|\.-)/g;

// The flowchart header alone is dropped, not its whole line: `flowchart LR; a["x"]` defines a node.
const FLOWCHART_HEADER = /^\s*(?:flowchart|graph)(?:\s+(?:TB|TD|BT|LR|RL))?\b\s*;?/;

/**
 * `text` with every edge-label span blanked to spaces, offsets kept. A `|` or
 * arrow inside a quoted label is label text, so the spans are found on a copy
 * whose quoted contents are masked, then blanked in the original.
 */
function blankEdgeLabels(text: string): string {
  // Regex offsets are UTF-16 indices; slicing the string keeps that unit, where a
  // code-point array would shift every span after an astral character.
  const masked = text.replace(/"[^"\n]*"/g, (quoted) => `"${"_".repeat(quoted.length - 2)}"`);
  let blanked = text;
  for (const match of masked.matchAll(EDGE_LABEL)) {
    const end = match.index + match[0].length;
    blanked = `${blanked.slice(0, match.index)}${" ".repeat(match[0].length)}${blanked.slice(end)}`;
  }
  return blanked;
}

/** The quoted labels of a mermaid block's nodes; an unquoted label is reported, since the pins cannot read it. */
export function nodeLabels(mermaid: string): { labels: string[]; problems: string[] } {
  const labels: string[] = [];
  const problems: string[] = [];
  const reportedLines = new Set<number>();
  const headed = FLOWCHART_HEADER.test(mermaid)
    ? mermaid.replace(FLOWCHART_HEADER, "")
    : mermaid.split("\n").slice(1).join("\n");
  // A `%%` line is a Mermaid comment: a node written there is not drawn, so it is not checked.
  // Blanking keeps every offset, so a reported line is read back from `drawn` as written.
  const drawn = headed
    .split("\n")
    .map((line) => (line.trimStart().startsWith("%%") ? "" : line))
    .join("\n");
  const body = blankEdgeLabels(drawn);
  const quotedSpans = [...body.matchAll(/"[^"]*"/g)].map(
    (span) => [span.index, span.index + span[0].length] as const,
  );
  for (const match of body.matchAll(NODE_DEFINITION)) {
    if (quotedSpans.some(([start, end]) => match.index > start && match.index < end)) continue;
    const rest = body.slice(match.index + match[0].length);
    const quoted = rest.match(QUOTED_LABEL);
    if (quoted === null) {
      const lineStart = body.lastIndexOf("\n", match.index) + 1;
      if (!reportedLines.has(lineStart)) {
        reportedLines.add(lineStart);
        const line = drawn.slice(lineStart).split("\n")[0] ?? "";
        problems.push(
          `node "${line.trim()}" has an unquoted label; quote it so the pins can read it`,
        );
      }
      continue;
    }
    labels.push(quoted[1] ?? "");
  }
  return { labels, problems };
}

export interface PageCheckOptions {
  /** The repository root the label paths are relative to. */
  root: string;

  /** The top-level directories a label path may start with (default: the directories under root). */
  pathRoots?: readonly string[];

  /** The URL prefix an absolute demonstration link must carry to map onto a repository file. */
  repoUrl?: string;

  /** The page's own path, for resolving relative demonstration links. */
  pagePath?: string;
}

function defaultPathRoots(root: string): string[] {
  return readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
}

interface LabelCode {
  path: string;
  symbols: string[];
}

/** A label read by its grammar: each code segment with the path it binds, and the captions that look like code. */
function readLabel(
  label: string,
  pathRoots: readonly string[],
): { codes: LabelCode[]; problems: string[] } {
  // A path starts under a top-level directory, or is a root-level file with a source or document extension (main.ts, README.md).
  const rootFile = `[\\w.-]+(?:${[...SOURCE_EXTENSIONS, ".md", ".yml", ".yaml", ".json"].map(RegExp.escape).join("|")})`;
  const pathToken = new RegExp(
    `^(?:(?:${pathRoots.map(RegExp.escape).join("|")})/[\\w./-]*|${rootFile})$`,
  );
  const codes: LabelCode[] = [];
  const problems: string[] = [];
  let bound: string | undefined;
  for (const segment of label.split("<br>")) {
    const tokens = segment
      .trim()
      .split(/[\s,]+/)
      .filter((token) => token !== "");
    const [head] = tokens;
    if (head !== undefined && pathToken.test(head)) {
      bound = head;
      codes.push({ path: head, symbols: tokens.slice(1) });
      continue;
    }

    if (bound !== undefined) {
      codes.push({ path: bound, symbols: tokens });
      continue;
    }

    if (segment.includes("/") || segment.includes("()")) {
      problems.push(
        `"${label}": "${segment.trim()}" looks like code but reads as a caption; a code segment starts with a path under ${pathRoots.join(", ")}`,
      );
    }
  }
  return { codes, problems };
}

function symbolProblems(
  label: string,
  path: string,
  file: string,
  symbols: readonly string[],
): string[] {
  const problems: string[] = [];
  for (const symbol of symbols) {
    if (!SYMBOL_TOKEN.test(symbol)) {
      problems.push(
        `"${label}": "${symbol}" is neither a symbol nor a path; after a path, a label lists only exported symbols`,
      );
      continue;
    }

    const name = symbol.replace(/\(\)$/, "");
    if (path.endsWith("/") || statSync(file).isDirectory()) {
      problems.push(`"${label}": ${path} is a directory, so it exports no ${name}`);
    } else if (!exportedNames(file).has(name)) {
      problems.push(`"${label}": ${path} exports no ${name}`);
    }
  }
  return problems;
}

/** Problems with one label, as `"label": problem`. */
export function labelProblems(
  label: string,
  root: string,
  pathRoots: readonly string[] = defaultPathRoots(root),
): string[] {
  const { codes, problems } = readLabel(label, pathRoots);
  const missing = new Set<string>();
  for (const { path, symbols } of codes) {
    const file = resolve(root, path);
    if (path.split("/").includes("..") || !isInside(root, file)) {
      problems.push(`"${label}": ${path} escapes the repository`);
      continue;
    }

    if (!existsSync(file)) {
      if (!missing.has(path)) {
        missing.add(path);
        problems.push(`"${label}": ${path} does not exist`);
      }
      continue;
    }

    problems.push(...symbolProblems(label, path, file, symbols));
  }
  return problems;
}

type PlacedMarker = RegionMarker & { line: number };

/** The region markers of a page, each with the line it sits on, in page order. */
function regionMarkers(page: Page): PlacedMarker[] {
  const markers: PlacedMarker[] = [];
  for (const [line, text] of page.text.entries()) {
    if (text === undefined) continue;

    const marker = parseMarker(text);
    if (marker !== null) markers.push({ ...marker, line });
  }
  return markers;
}

/** Every BEGIN GENERATED marker needs the END marker of the same name after it; an unmatched one would hide every later diagram. */
function regionProblems(page: Page): string[] {
  const problems: string[] = [];
  let open: PlacedMarker | undefined;
  for (const marker of regionMarkers(page)) {
    const at = `line ${marker.line + 1}: ${marker.kind} GENERATED: ${marker.name}`;
    if (marker.kind === "BEGIN") {
      if (open)
        problems.push(`${at} opens inside the region ${open.name} opened at line ${open.line + 1}`);
      open = marker;
      continue;
    }

    if (open === undefined) problems.push(`${at} closes no open region`);
    else if (open.name !== marker.name)
      problems.push(`${at} closes the region ${open.name} opened at line ${open.line + 1}`);
    open = undefined;
  }

  if (open) problems.push(`line ${open.line + 1}: BEGIN GENERATED: ${open.name} is never closed`);
  return problems;
}

function insideGeneratedRegion(page: Page, line: number): boolean {
  let open = false;
  for (const [index, text] of page.text.entries()) {
    if (index === line) return open;
    if (text === undefined) continue;
    const marker = parseMarker(text);
    if (marker?.kind === "BEGIN") open = true;
    else if (marker?.kind === "END") open = false;
  }
  return open;
}

/** The repository file a demonstration link names, or a problem string. */
function resolveLink(
  link: string,
  options: PageCheckOptions,
): { file: string } | { problem: string } {
  const target = linkFile(link);
  if (/^[a-z]+:\/\//.test(target)) {
    if (options.repoUrl === undefined) {
      return {
        problem: `"${link}" is an absolute link; pass --repo-url <prefix> so it can be resolved`,
      };
    }
    if (!target.startsWith(options.repoUrl)) {
      return { problem: `"${link}" is not a ${options.repoUrl} link` };
    }
    const file = resolve(options.root, target.slice(options.repoUrl.length));
    if (!isInside(options.root, file))
      return { problem: `"${link}" resolves outside the repository` };
    return { file };
  }
  if (options.pagePath === undefined) {
    return { problem: `"${link}" is a relative link, but the page's own path is unknown` };
  }
  const file = resolve(dirname(options.pagePath), target);
  if (!isInside(options.root, file)) {
    return { problem: `"${link}" resolves outside the repository` };
  }
  return { file };
}

/** The concept diagrams of a page: the mermaid fences outside generated regions. */
function conceptFences(page: Page): Fence[] {
  return page.fences.filter((fence) => fence.mermaid && !insideGeneratedRegion(page, fence.line));
}

/** Link destinations as Markdown reads them, so a title or angle brackets never become part of the path. */
function markdownLinks(line: string, page: Page): string[] {
  const links: string[] = [];
  // Reference-style links resolve through definitions elsewhere on the page, so those ride along.
  const definitions = page.text.filter(
    (text): text is string => text !== undefined && /^ {0,3}\[[^\]]+\]:\s+\S/.test(text),
  );
  Bun.markdown.render([line, "", ...definitions].join("\n"), {
    link: (children: string, attrs: { href?: string }) => {
      links.push(attrs.href ?? "");
      return children;
    },
  });
  return links;
}

/** The lines of page text matching `pattern`. */
function textLines(page: Page, pattern: RegExp): number[] {
  return [...page.text.keys()].filter((line) => {
    const text = page.text[line];
    return text !== undefined && pattern.test(text);
  });
}

function nodeProblems(page: Page, root: string, pathRoots: readonly string[]): string[] {
  const problems: string[] = [];
  for (const fence of page.fences) {
    if (!fence.mermaid) continue;

    const nodes = nodeLabels(fence.body);
    problems.push(...nodes.problems);
    for (const label of nodes.labels) {
      problems.push(...labelProblems(label, root, pathRoots));
    }
  }
  return problems;
}

/** The lines that open a section, sorted: ATX headings, plus Setext ones (a text line under a line of = or - signs). */
function headingLines(page: Page): number[] {
  return [
    // Up to three leading spaces and an empty heading are still ATX headings to Markdown.
    ...textLines(page, /^ {0,3}#{1,6}(?:\s|$)/),
    ...textLines(page, /\S/).filter((line) => {
      const under = page.text[line + 1];
      const text = page.text[line] ?? "";
      return (
        under !== undefined &&
        /^ {0,3}(=+|-+)\s*$/.test(under) &&
        !/^\s*([-*+]|\d+\.)\s|^\s*\|/.test(text)
      );
    }),
  ].sort((x, y) => x - y);
}

/** Why a demonstration link proves nothing: it does not resolve, names no file, or names a directory. */
function linkProblem(link: string, options: PageCheckOptions): string | undefined {
  const resolved = resolveLink(link, options);
  if ("problem" in resolved) return resolved.problem;
  if (!existsSync(resolved.file)) return `"${link}" names a file that does not exist`;
  if (statSync(resolved.file).isDirectory())
    return `"${link}" names a directory, not a test or scenario file`;
  return undefined;
}

function demonstrationProblems(page: Page, options: PageCheckOptions): string[] {
  const headings = headingLines(page);
  const demonstrations = textLines(page, /^Demonstrated by:/);
  const problems: string[] = [];
  // One demonstration line proves one diagram: two fences under one heading need two lines.
  const claimed = new Set<number>();
  for (const fence of conceptFences(page)) {
    const sectionEnd = headings.find((line) => line > fence.end) ?? page.lines.length;
    const demoLine = demonstrations.find(
      (line) => line > fence.end && line < sectionEnd && !claimed.has(line),
    );
    const at = `line ${fence.line + 1}`;
    if (demoLine === undefined) {
      problems.push(`${at}: the diagram has no "${DEMONSTRATED}" line before the next heading`);
      continue;
    }

    claimed.add(demoLine);
    const links = markdownLinks(page.lines[demoLine] ?? "", page);
    if (links.length === 0) {
      problems.push(`${at}: the "${DEMONSTRATED}" line links nothing`);
    }

    for (const link of links) {
      const problem = linkProblem(link, options);
      if (problem !== undefined) problems.push(`${at}: ${problem}`);
    }
  }
  return problems;
}

/**
 * Every problem in one page: a node naming a missing path or an unexported
 * symbol, a concept diagram without its "Demonstrated by:" line before the
 * next heading, or a demonstration link that does not resolve to a file.
 */
export function diagramProblems(markdown: string, options: PageCheckOptions): string[] {
  const pathRoots = options.pathRoots ?? defaultPathRoots(options.root);
  const page = readPage(markdown);
  return [
    ...regionProblems(page),
    ...nodeProblems(page, options.root, pathRoots),
    ...demonstrationProblems(page, options),
  ];
}

/** The concept diagrams and demonstration lines a page carries. */
export function conceptCounts(markdown: string): { diagrams: number; demonstrations: number } {
  const page = readPage(markdown);
  return {
    diagrams: conceptFences(page).length,
    demonstrations: textLines(page, /^Demonstrated by:/).length,
  };
}

const USAGE = [
  "usage: bun scripts/check_architecture_page.mts --page <path> [--root <dir>] [--repo-url <prefix>] [--expect-diagrams <n>]",
  "  --page             the architecture page to check",
  "  --root             the repository root the label paths are relative to (default: cwd)",
  "  --repo-url         the URL prefix an absolute demonstration link maps onto the root with",
  "                     (e.g. https://github.com/owner/repo/blob/main/); relative links resolve from the page",
  "  --expect-diagrams  the number of concept diagrams the page must carry",
  "exit 0: the page names real code; 1: problems, each printed; 2: usage or an unreadable page",
].join("\n");

interface CliOptions extends PageCheckOptions {
  pagePath: string;
  expectDiagrams?: number;
}

function parseArgs(argv: readonly string[]): CliOptions {
  const refuse: Refuser = usageRefuser(USAGE);
  const { values } = parseArgv(
    {
      args: [...argv],
      options: {
        page: { type: "string" },
        root: { type: "string", default: process.cwd() },
        "repo-url": { type: "string" },
        "expect-diagrams": { type: "string" },
      },
    },
    refuse,
  );
  const count = values["expect-diagrams"];
  if (count !== undefined && !/^\d+$/.test(count)) refuse("--expect-diagrams needs a whole number");
  if (values.page === undefined) refuse("--page is required");
  return {
    root: resolve(values.root),
    pagePath: resolve(values.page),
    repoUrl: values["repo-url"],
    expectDiagrams: count === undefined ? undefined : Number(count),
  };
}

if (import.meta.main) {
  let options: CliOptions;
  try {
    options = parseArgs(process.argv.slice(2));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(2);
  }
  const pageLabel = pathLabel(options.root, options.pagePath);
  if (!existsSync(options.pagePath)) {
    console.error(`check-architecture-page: ${pageLabel} does not exist`);
    process.exit(2);
  }
  try {
    const markdown = readFileSync(options.pagePath, "utf8");
    const problems = diagramProblems(markdown, options);
    const counts = conceptCounts(markdown);
    if (options.expectDiagrams !== undefined && counts.diagrams !== options.expectDiagrams) {
      problems.push(
        `expected ${options.expectDiagrams} concept diagrams, found ${counts.diagrams}; change --expect-diagrams only when a diagram was added or removed on purpose`,
      );
    }
    if (counts.demonstrations !== counts.diagrams) {
      problems.push(
        `${counts.diagrams} concept diagrams but ${counts.demonstrations} "${DEMONSTRATED}" lines; one line per diagram`,
      );
    }
    if (problems.length > 0) {
      console.error(
        `check-architecture-page: ${pageLabel}: ${problems.length} problem(s)\n  ${problems.join("\n  ")}`,
      );
      process.exit(1);
    }
    console.log(
      `check-architecture-page: ${pageLabel} names real code (concept diagrams: ${counts.diagrams})`,
    );
  } catch (error) {
    console.error(
      `check-architecture-page: ${error instanceof Error ? error.message : String(error)}`,
    );
    process.exit(2);
  }
}
