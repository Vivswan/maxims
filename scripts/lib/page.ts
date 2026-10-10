import { parse, postprocess, preprocess } from "micromark";

export interface Fence {
  /** Zero-based line of the opening fence. */
  line: number;
  /** Zero-based line of the closing fence, or the last line of a fence that never closes: the end of the block quote or list item holding it, or of the page. */
  end: number;
  /** The info string names mermaid; other fences are text the page quotes. */
  mermaid: boolean;
  body: string;
}

/** Every line ending micromark recognizes (LF, CRLF, a lone CR) splits a line, so `Page.lines` and the token positions count the same lines. */
function normalizedLines(markdown: string): string[] {
  return markdown.split(/\r\n|\n|\r/);
}

const MERMAID_INFO = /^\s*mermaid\s*$/;

interface OpenFence {
  line: number;
  marker?: string;
  infoLine?: string;
  fenceTokens: number;
  values: Map<number, string>;
}

/**
 * A blank line inside a fence has no codeFlowValue token, so the body is rebuilt from the tokens
 * present. One codeFencedFence token means the fence never closed and ends where the codeFenced
 * token does: with the block quote or list item holding it, or the page. The opener's text after
 * the marker is judged whole: micromark moves a space into the meta token but keeps a NBSP in info.
 */
function fences(markdown: string): Fence[] {
  const events = postprocess(
    parse()
      .document()
      .write(preprocess()(markdown, undefined, true)),
  );
  const found: Fence[] = [];
  let open: OpenFence | undefined;
  for (const [step, token, context] of events) {
    if (step === "enter") {
      if (token.type === "codeFenced")
        open = { line: token.start.line - 1, fenceTokens: 0, values: new Map() };
      else if (token.type === "codeFencedFence" && open !== undefined) open.fenceTokens += 1;
      continue;
    }
    if (open === undefined) continue;
    if (open.fenceTokens === 1 && token.type === "codeFencedFenceSequence")
      open.marker = context.sliceSerialize(token);
    else if (open.fenceTokens === 1 && token.type === "codeFencedFence")
      open.infoLine = context.sliceSerialize(token).slice(open.marker?.length);
    else if (token.type === "codeFlowValue")
      open.values.set(token.start.line - 1, context.sliceSerialize(token));
    else if (token.type === "codeFenced") {
      const closed = open.fenceTokens === 2;
      const end = token.end.line - 1;
      const body: string[] = [];
      for (let line = open.line + 1; line <= (closed ? end - 1 : end); line++)
        body.push(open.values.get(line) ?? "");
      found.push({
        line: open.line,
        end,
        mermaid: MERMAID_INFO.test(open.infoLine ?? ""),
        body: body.join("\n"),
      });
      open = undefined;
    }
  }
  return found;
}

/** The live mermaid diagrams of `markdown`. */
export function mermaidFences(markdown: string): Fence[] {
  return readPage(markdown).fences.filter((fence) => fence.mermaid);
}

export interface Page {
  lines: readonly string[];
  fences: readonly Fence[];
  /**
   * `lines[i]` when line i is page text, undefined inside any fence: headings, region markers, and
   * demonstration lines are read from here only, so a quoted example never steers the walk.
   */
  text: ReadonlyArray<string | undefined>;
}

export function readPage(markdown: string): Page {
  const lines = normalizedLines(markdown);
  const all = fences(markdown);
  const text = lines.map((line, index) =>
    all.some((fence) => index >= fence.line && index <= fence.end) ? undefined : line,
  );
  return { lines, fences: all, text };
}
