import { claudeCode } from "./claude-code/index.ts";
import { cline } from "./cline/index.ts";
import { codex } from "./codex/index.ts";
import type { HarnessDefinition } from "./contract.ts";
import { copilot } from "./copilot/index.ts";
import { geminiCli } from "./gemini-cli/index.ts";

// One import line per definition folder; registry.test.ts fails on a folder missing from here.
export const HARNESSES: readonly HarnessDefinition[] = [
  claudeCode,
  codex,
  geminiCli,
  copilot,
  cline,
];
