import { claudeCode } from "./claude-code/index.ts";
import type { HarnessDefinition } from "./contract.ts";

// One import line per definition folder; registry.test.ts fails on a folder missing from here.
export const HARNESSES: readonly HarnessDefinition[] = [claudeCode];
