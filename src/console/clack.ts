import {
  cancel,
  confirm,
  isCancel,
  multiselect,
  S_BAR,
  S_ERROR,
  S_STEP_SUBMIT,
  S_WARN,
  spinner,
  text,
} from "@clack/prompts";
import pc from "picocolors";
import {
  type Console,
  type ConsoleMode,
  type InteractiveStreams,
  promptsAllowed,
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
      const s = spinner({ output });
      s.start(start);
      return { stop: (message) => s.stop(message), fail: (message) => s.error(message) };
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
