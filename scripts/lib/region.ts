import { readPage } from "./page.ts";

// The name is spliced into a regex unescaped, so only regex-literal characters are admitted.
const REGION_NAME = /^[a-z0-9-]+$/;

/** A marker is a line of its own (up to three spaces in); one quoted mid-line or under `> ` is page text. */
function markerPattern(kind: "BEGIN" | "END", name: string): RegExp {
  const hint = kind === "BEGIN" ? String.raw`(?: \([^)\n]*\))?` : "";
  return new RegExp(`^ {0,3}<!-- ${kind} GENERATED: ${name}${hint} -->[ \\t]*\\r?$`, "gm");
}

/** Exactly one BEGIN then one END for `name`, else a throw naming the counts: a second marker pair would splice into the wrong one silently. */
export function regionBounds(text: string, name: string): { bodyStart: number; bodyEnd: number } {
  if (!REGION_NAME.test(name)) {
    throw new Error(`a region name is lowercase letters, digits, and dashes; got "${name}"`);
  }
  // A marker quoted inside a fence is page text about markers, not a region;
  // line counting on the raw text keeps the offsets the splice needs.
  const page = readPage(text);
  const live = (match: RegExpExecArray): boolean => {
    const line = text.slice(0, match.index).split(/\r\n|\n|\r/).length - 1;
    const lineText = page.text[line];
    // Indented code is quoted text as much as a fence is.
    return lineText !== undefined && !/^( {4}|\t)/.test(lineText);
  };
  const begins = [...text.matchAll(markerPattern("BEGIN", name))].filter(live);
  const ends = [...text.matchAll(markerPattern("END", name))].filter(live);
  const [begin] = begins;
  const [end] = ends;
  if (begin === undefined || end === undefined || begins.length !== 1 || ends.length !== 1) {
    throw new Error(
      `region "${name}" needs exactly one BEGIN and one END marker, found ${begins.length} and ${ends.length}`,
    );
  }
  if (end.index < begin.index + begin[0].length) {
    throw new Error(`region "${name}" has its END marker before its BEGIN marker`);
  }
  return { bodyStart: begin.index + begin[0].length, bodyEnd: end.index };
}
