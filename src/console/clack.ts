import type { Writable } from "node:stream";
import {
  cancel,
  confirm,
  isCancel,
  multiselect,
  S_BAR,
  S_ERROR,
  S_STEP_ACTIVE,
  S_STEP_SUBMIT,
  S_WARN,
  text,
} from "@clack/prompts";
import pc from "picocolors";
import {
  type Console,
  type ConsoleMode,
  type InteractiveStreams,
  promptsAllowed,
  type Spinner,
} from "./contract.ts";
import { createFrameConsole, type FrameSymbols, type Prompter } from "./plain.ts";
import { STRINGS } from "./strings.ts";

// The same frame as the plain console, drawn with clack's glyphs and picocolors, plus the real
// prompts when the mode allows them. A TTY under `--yes` or inside an agent gets the glyphs and
// the spinner but no prompt: `confirm` takes the verb's silent branch and `text` and `multiselect`
// resolve to their silent answers, exactly as the plain console does.
export function createClackConsole(mode: ConsoleMode, streams: InteractiveStreams): Console {
  const prompts = promptsAllowed(mode);
  const symbols: FrameSymbols = {
    bar: pc.gray(S_BAR),
    step: pc.green(S_STEP_SUBMIT),
    warn: pc.yellow(S_WARN),
    error: pc.red(S_ERROR),
  };
  const output = streams.output;
  const common = { output, input: streams.input };
  const prompter: Prompter = {
    spinner(start) {
      return frameSpinner(output, symbols, start, mode.width);
    },
    async confirm(message, whenSilent) {
      if (!prompts) return whenSilent;
      const answer = await confirm({ ...common, message, initialValue: true });
      return answer === true;
    },
    async text(prompt) {
      if (!prompts) return null;
      const answer = await text({
        ...common,
        message: prompt.message,
        initialValue: prompt.initial,
        validate: (value) => prompt.validate(value ?? ""),
      });
      if (isCancel(answer)) {
        cancel(STRINGS.cancelled, common);
        return null;
      }
      return answer;
    },
    async multiselect(message, options, initial) {
      if (!prompts) return { kind: "silent" };
      const answer = await multiselect<string>({
        ...common,
        message,
        options,
        initialValues: initial,
        required: false,
      });
      if (isCancel(answer)) {
        cancel(STRINGS.cancelled, common);
        return { kind: "cancelled" };
      }
      return { kind: "chosen", values: answer };
    },
  };
  return createFrameConsole(mode, output, symbols, prompter);
}

const SPINNER_FRAMES = [S_STEP_ACTIVE, S_STEP_SUBMIT];
// Erase the whole line rather than overwrite it with spaces: the frame's length is not the
// message's, and a run of spaces wraps on a terminal narrower than the message.
const ERASE_LINE = `${String.fromCharCode(27)}[2K`;

// Clack's spinner installs SIGINT and SIGTERM listeners while it runs, which would displace the
// lock's exit hook (signal-exit yields to any other listener) and Node's own termination. This
// one animates on a timer only: a signal ends the process the ordinary way.
function frameSpinner(
  output: Writable,
  symbols: FrameSymbols,
  start: string,
  width: number,
): Spinner {
  // The frame is cut to the terminal width: carriage return and erase-line act on one row, so a
  // message that wrapped would leave its first row behind on every redraw.
  const message = start.slice(0, Math.max(0, width - 3));
  let frame = 0;
  const draw = (): void => {
    const glyph = pc.magenta(SPINNER_FRAMES[frame % SPINNER_FRAMES.length] ?? "");
    output.write(`\r${glyph}  ${message}`);
    frame += 1;
  };
  draw();
  const timer = setInterval(draw, 120);
  const finish = (line: string): void => {
    clearInterval(timer);
    output.write(`\r${ERASE_LINE}${line}\n`);
  };
  return {
    stop: (message) => finish(`${symbols.step}  ${message}`),
    fail: (message) => finish(`${symbols.error}  ${message}`),
  };
}
