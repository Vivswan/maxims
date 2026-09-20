import { amp } from "./amp/index.ts";
import { claudeCode } from "./claude-code/index.ts";
import { cline } from "./cline/index.ts";
import { codex } from "./codex/index.ts";
import type { HarnessDefinition } from "./contract.ts";
import { copilot } from "./copilot/index.ts";
import { cursor } from "./cursor/index.ts";
import { devin } from "./devin/index.ts";
import { dsh } from "./dsh/index.ts";
import { geminiCli } from "./gemini-cli/index.ts";
import { opencode } from "./opencode/index.ts";
import { pi } from "./pi/index.ts";
import { warp } from "./warp/index.ts";
import { windsurf } from "./windsurf/index.ts";
import { zed } from "./zed/index.ts";

// One import line per definition folder; registry.test.ts fails on a folder missing from here.
export const HARNESSES: readonly HarnessDefinition[] = [
  claudeCode,
  codex,
  geminiCli,
  copilot,
  cursor,
  cline,
  opencode,
  dsh,
  devin,
  windsurf,
  zed,
  amp,
  warp,
  pi,
];
