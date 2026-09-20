import type { HarnessSpec } from "../spec.ts";

// dsh renders every instruction file it discovers into ONE 65,536-byte block and truncates the
// most specific file when the total exceeds it, so a block that pushes AGENTS.md over the line
// would load cut in half. The block carries framing that counts against the same budget: a
// `<system-reminder>` frame, an intro sentence, and an `Instructions from: <path>` heading per
// file. The 1,024-byte allowance covers that framing for this file with a long path; the other
// files dsh loads alongside it share the budget too and are outside what maxims can see.
// Documented: "`.claude/rules/`, and `@path` imports are not interpreted".
//
// Tier 1 through the `dsh-hooks-claude-code` bridge in quirks.ts, with its caveats in force: the
// bridge reads its hooks file once at process start (a change needs a dsh restart), dsh has no
// per-project config discovery (the bridge is mounted machine-wide whatever the install scope),
// and dsh's own docs steer new integrations toward native Cordis plugins, which would make this
// the same plugin-file shape OpenCode uses.
export const spec = {
  id: "dsh",
  displayName: "DeepSeek Harness",
  tier: 1,
  verifiedAgainst: {
    url: "https://raw.githubusercontent.com/deepseek-ai/deepseek-harness/master/packages/context/agent-instructions/README.md",
    date: "2026-09-20",
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
