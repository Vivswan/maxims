import type {
  Console,
  ConsoleMode,
  SelectAnswer,
  SelectOption,
  Sink,
  Spinner,
  TextPrompt,
} from "./contract.ts";
import { moreItems, STRINGS } from "./strings.ts";

export type FrameSymbols = {
  bar: string;
  step: string;
  warn: string;
  error: string;
};

// The prompting half of a console; null means every prompt resolves to its silent branch.
export type Prompter = {
  spinner(start: string): Spinner;
  confirm(message: string, whenSilent: boolean): Promise<boolean>;
  text(prompt: TextPrompt): Promise<string | null>;
  multiselect(message: string, options: SelectOption[], initial: string[]): Promise<SelectAnswer>;
};

const ASCII: FrameSymbols = { bar: "|", step: "o", warn: "!", error: "x" };

const ITEM_DESCRIPTION_INDENT = 6;

// The frame `npx skills` draws: a gutter, a step glyph, a warning glyph, an error glyph. Every line
// is written whole, so a non-TTY reader (a CI log, an agent transcript) sees no cursor movement
// and no partial spinner frame. The plain console is this frame in ASCII with no prompter;
// `output` null is the silent console for --quiet and --json.
export function createPlainConsole(mode: ConsoleMode, output: Sink | null): Console {
  return createFrameConsole(mode, output, ASCII, null);
}

export function createFrameConsole(
  mode: ConsoleMode,
  output: Sink | null,
  symbols: FrameSymbols,
  prompter: Prompter | null,
): Console {
  const write = (line: string): void => {
    output?.write(`${line}\n`);
  };
  const { bar, step } = symbols;
  const textWidth = Math.max(20, mode.width - (visibleWidth(bar) + ITEM_DESCRIPTION_INDENT));
  const descriptionPrefix = `${bar}${" ".repeat(ITEM_DESCRIPTION_INDENT)}`;
  return {
    mode,
    intro() {
      write(bar);
      if (mode.agent !== null) {
        write(`${step}   ${mode.agent}  ${STRINGS.agentDetected}`);
        write(bar);
      }
    },
    gap: () => write(bar),
    step: (message) => write(`${step}  ${message}`),
    warn: (message) => write(`${symbols.warn}  ${message}`),
    error: (message) => write(`${symbols.error}  ${message}`),
    line: (text) => write(text),
    note(body, title) {
      write(`${step}  ${title}`);
      if (body !== "") for (const line of body.split("\n")) write(`   ${line}`);
    },
    item(name, description) {
      write(`${bar}    ${name}`);
      write(bar);
      for (const line of wrap(description, textWidth)) write(`${descriptionPrefix}${line}`);
      write(bar);
    },
    name(name) {
      write(`${bar}    ${name}`);
    },
    more(hidden) {
      write(`${bar}    ${moreItems(hidden)}`);
      write(bar);
    },
    spinner(start) {
      if (prompter !== null) return prompter.spinner(start);
      return {
        stop: (message) => write(`${step}  ${message}`),
        fail: (message) => write(`${symbols.error}  ${message}`),
      };
    },
    confirm: (message, whenSilent) =>
      prompter === null ? Promise.resolve(whenSilent) : prompter.confirm(message, whenSilent),
    text: (prompt) => (prompter === null ? Promise.resolve(null) : prompter.text(prompt)),
    multiselect: (message, options, initial) =>
      prompter === null
        ? Promise.resolve<SelectAnswer>({ kind: "silent" })
        : prompter.multiselect(message, options, initial),
    outro(message) {
      write(`${step}  ${message}`);
      write("");
    },
  };
}

// A colored glyph is one terminal column however many code units its escapes take.
function visibleWidth(text: string): number {
  return text.replace(ANSI_ESCAPE, "").length;
}

const ANSI_ESCAPE = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, "g");

// Greedy word wrap; a word longer than the width stays whole on its own line rather than being
// split, because a URL or a path cut in two is worse than an overlong line.
function wrap(text: string, width: number): string[] {
  const lines: string[] = [];
  let current = "";
  for (const word of text.split(/\s+/).filter((part) => part !== "")) {
    if (current === "") current = word;
    else if (current.length + 1 + word.length <= width) current = `${current} ${word}`;
    else {
      lines.push(current);
      current = word;
    }
  }
  if (current !== "") lines.push(current);
  return lines;
}
