import { parseContentHash } from "../../memory/contract.ts";
import type { HarnessSpec } from "../spec.ts";

// dsh renders every instruction file it finds into ONE 65,536-byte block and truncates the most
// specific file when the total exceeds it, so a block that pushes AGENTS.md over the line would
// load cut in half. Framing counts against the same budget (a `<system-reminder>` frame, an intro
// sentence, an `Instructions from: <path>` heading per file); the 1,024-byte allowance covers it
// for this file with a long path, while the other files dsh loads share the budget unseen by
// maxims. Documented: "`.claude/rules/`, and `@path` imports are not interpreted".
//
// Tier 1 rides the `dsh-hooks-claude-code` bridge in quirks.ts, with its caveats in force: it is
// mounted machine-wide in `$DSH_HOME/cordis.patch.yml` whatever the install scope, and it reads
// its hooks file once at process start, so a changed hook needs a dsh restart.
export const spec = {
  id: "dsh",
  displayName: "DeepSeek Harness",
  tier: 1,
  verifiedAgainst: {
    url: "https://raw.githubusercontent.com/deepseek-ai/deepseek-harness/master/packages/context/agent-instructions/README.md",
    date: "2026-09-20",
    contentHash:
      parseContentHash("sha256:4aaff5814a41d41b14d3ebeb12126d1eb7974180fe4ec42414f8641f6bf440fb") ??
      undefined,
  },
  globalRoot: { default: ".dsh", env: { name: "DSH_HOME" } },
  targets: {
    project: { kind: "shared-block", file: "AGENTS.md" },
    global: { kind: "shared-block", file: "AGENTS.md" },
  },
  bodiesDir: { project: ".agents/memories", global: null },
  markers: "counted",
  expands: ["none"],
  byteBudget: 65_536 - 1_024,
  detect: { dirs: ["."] },
  hook: { kind: "none" },
  fixtures: { config: "config.yml", hookStdin: "hook-stdin.json" },
} satisfies HarnessSpec;
