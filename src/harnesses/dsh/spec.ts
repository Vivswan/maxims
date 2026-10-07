import { contentHashLiteral } from "../../memory/contract.ts";
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
    date: "2026-10-07",
    pages: [
      {
        url: "https://raw.githubusercontent.com/deepseek-ai/deepseek-harness/master/packages/context/agent-instructions/README.md",
        contentHash: contentHashLiteral(
          "sha256:de0e367c272f5e03405660f57345c137221e6b93d1cda4ac468535aba21902de",
        ),
      },
      {
        url: "https://raw.githubusercontent.com/deepseek-ai/deepseek-harness/master/docs/config-catalog.md",
        contentHash: contentHashLiteral(
          "sha256:220e84a26db4565c5f920d0f316b3e13ef6610dd78a147cb020e73d38e36af1e",
        ),
        note: "DSH_HOME and the dsh-hooks-claude-code plugin",
      },
      {
        url: "https://raw.githubusercontent.com/deepseek-ai/deepseek-harness/master/apps/cli/reference/README.md",
        contentHash: contentHashLiteral(
          "sha256:90425b20f567a72be0568384f2b8e8b0f18f4e0a8a0b478db9e6ff8844ce68bf",
        ),
        note: "the 65,536-byte render budget and $DSH_HOME/cordis.patch.yml",
      },
    ],
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
