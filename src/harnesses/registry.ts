import { amp } from "./amp/spec.ts";
import { claudeCode } from "./claude-code/spec.ts";
import { cline } from "./cline/spec.ts";
import { codex } from "./codex/spec.ts";
import type { HarnessDefinition } from "./contract.ts";
import { copilot } from "./copilot/spec.ts";
import { cursor } from "./cursor/spec.ts";
import { devin } from "./devin/spec.ts";
import { dsh } from "./dsh/spec.ts";
import { geminiCli } from "./gemini-cli/spec.ts";
import { opencode } from "./opencode/spec.ts";
import { pi } from "./pi/spec.ts";
import { warp } from "./warp/spec.ts";
import { windsurf } from "./windsurf/spec.ts";
import { zed } from "./zed/spec.ts";

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
