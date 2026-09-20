import { ExitCode, MaximsError } from "../../util/exit-codes.ts";
import type { HarnessDefinition } from "../contract.ts";
import { reconcileBridge } from "./bridge.ts";

// dsh renders every instruction file it discovers into ONE 65,536-byte block and truncates the
// most specific file when the total exceeds it, so a block that pushes AGENTS.md over the line
// would load cut in half. The block carries framing that counts against the same budget: a
// `<system-reminder>` frame, an intro sentence, and an `Instructions from: <path>` heading per
// file. The allowance covers that framing for this file with a long path; the other files dsh
// loads alongside it share the budget too and are outside what maxims can see.
export const DSH_INSTRUCTION_BUDGET = 65_536;
export const DSH_RENDER_ALLOWANCE = 1_024;
export const DSH_FILE_BUDGET = DSH_INSTRUCTION_BUDGET - DSH_RENDER_ALLOWANCE;

// `surroundingText` is the file with any earlier maxims block already excised; the sum is what
// dsh would read. Refusing rather than truncating keeps the shape of the rule cap.
export function checkBudget(surroundingText: string, block: string): number {
  const total = Buffer.byteLength(surroundingText) + Buffer.byteLength(block);
  if (total > DSH_FILE_BUDGET) {
    throw new MaximsError(
      ExitCode.RuleCapExceeded,
      `AGENTS.md would be ${total} bytes; dsh renders at most ${DSH_INSTRUCTION_BUDGET} including its own framing`,
      { hint: "install fewer memories with --memory, or trim the file's own content" },
    );
  }
  return total;
}

// Tier 1 through the `dsh-hooks-claude-code` bridge, with its caveats in force: the bridge reads
// its hooks file once at process start (a change needs a dsh restart), dsh has no per-project
// config discovery (the bridge is mounted machine-wide whatever the install scope), and dsh's own
// docs steer new integrations toward native Cordis plugins, which would make this the same
// plugin-file shape OpenCode uses.
export const dsh: HarnessDefinition = {
  id: "dsh",
  displayName: "DeepSeek Harness",
  tier: 1,
  targets: {
    project: { kind: "shared-block", file: "AGENTS.md" },
    global: { kind: "shared-block", file: ".dsh/AGENTS.md" },
  },
  bodiesDir: (scope) => (scope === "project" ? ".agents/memories" : null),
  hook: { kind: "custom", reconcile: reconcileBridge },
  markers: "counted",
  // Documented: "`.claude/rules/`, and `@path` imports are not interpreted".
  expands: ["none"],
  byteBudget: DSH_FILE_BUDGET,
  // dsh documents no session marker of its own; `DSH_HOME` is what its shell-env plugin exports.
  detect: (ctx) => Boolean(ctx.env.DSH_HOME),
  verifiedAgainst: {
    url: "https://raw.githubusercontent.com/deepseek-ai/deepseek-harness/master/packages/context/agent-instructions/README.md",
    date: "2026-09-20",
  },
  fixtures: { config: "config.yml", hookStdin: "hook-stdin.json" },
};
