import type { Readable, Writable } from "node:stream";
import { createPlainConsole } from "./plain.ts";

// Where a line of output goes: the process stream in the bin, a capturing function in a test.
export type Sink = {
  write(chunk: string): unknown;
};

// Derived once from the streams, the environment and the flags; every prompt decision below reads
// it, so a verb never asks "is this interactive" itself. `agent` is the detected agent's id or
// null; on a TTY it suppresses every prompt and prints the banner.
export type ConsoleMode = {
  tty: boolean;
  stdinTty: boolean;
  agent: string | null;
  yes: boolean;
  quiet: boolean;
  json: boolean;
  width: number;
};

export type Spinner = {
  stop(message: string): void;
  fail(message: string): void;
};

export type SelectOption = {
  value: string;
  label: string;
  hint?: string;
};

export type TextPrompt = {
  message: string;
  initial: string;
  validate: (value: string) => string | undefined;
};

// `confirm` resolves to `whenSilent` wherever the mode forbids a prompt (non-TTY, agent, --yes,
// --quiet, --json): the verb names its safe branch and the mode decides whether to ask. `text`
// resolves to null and `multiselect` to `silent` in the same situations.
export interface Console {
  readonly mode: ConsoleMode;
  intro(): void;
  gap(): void;
  step(message: string): void;
  warn(message: string): void;
  error(message: string): void;
  line(text: string): void;
  note(body: string, title: string): void;
  item(name: string, description: string): void;
  name(name: string): void;
  more(hidden: number): void;
  spinner(start: string): Spinner;
  confirm(message: string, whenSilent: boolean): Promise<boolean>;
  text(prompt: TextPrompt): Promise<string | null>;
  multiselect(message: string, options: SelectOption[], initial: string[]): Promise<SelectAnswer>;
  outro(message: string): void;
}

// A multiselect either answers, is cancelled by the user (Ctrl-C), or could not be asked at all;
// the caller treats the last two differently: one ends the run, the other falls back.
export type SelectAnswer =
  | { kind: "chosen"; values: string[] }
  | { kind: "cancelled" }
  | { kind: "silent" };

export type InteractiveStreams = {
  output: Writable;
  input: Readable;
};

export type CreateConsoleInput = {
  mode: ConsoleMode;
  output: Sink;
  interactive: InteractiveStreams | null;
};

// A prompt needs a terminal on both ends: a piped stdin cannot answer, whatever stdout is.
export function promptsAllowed(mode: ConsoleMode): boolean {
  return mode.tty && mode.stdinTty && mode.agent === null && !mode.yes && !mode.quiet && !mode.json;
}

// The clack renderer loads only for a TTY that shows full output: a hook run, a CI run and a
// --json run all take the plain renderer, which has no dependency beyond this folder.
export async function createConsole(input: CreateConsoleInput): Promise<Console> {
  const { mode } = input;
  const silent = mode.quiet || mode.json;
  if (!silent && mode.tty && input.interactive !== null) {
    const { createClackConsole } = await import("./clack.ts");
    return createClackConsole(mode, input.interactive);
  }
  return createPlainConsole(mode, silent ? null : input.output);
}
