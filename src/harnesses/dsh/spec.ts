import { toDefinition } from "../from-spec.ts";
import type { HarnessSpec } from "../spec.ts";
import { bridgeReconciler } from "./quirks.ts";

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
    date: "2026-10-09",
    sources: [
      {
        kind: "file",
        repo: "deepseek-ai/deepseek-harness",
        ref: "master",
        path: "packages/util/home-paths/src/index.ts",
        claims: ["DSH_HOME_ENV = 'DSH_HOME'", "'.dsh'"],
        note: "DSH_HOME and ~/.dsh",
      },
      {
        kind: "file",
        repo: "deepseek-ai/deepseek-harness",
        ref: "master",
        path: "packages/context/agent-instructions/src/render.ts",
        claims: ["USER_GLOBAL_FILE = 'AGENTS.md'", "truncateUtf8", "Instructions from:"],
        note: "the rendered block and its truncation",
      },
      {
        kind: "file",
        repo: "deepseek-ai/deepseek-harness",
        ref: "master",
        path: "packages/context/agent-instructions/src/config.ts",
        claims: ["'AGENTS.md', 'CLAUDE.md'", "maxBytes"],
        note: "the instruction file names and the byte cap",
      },
      {
        kind: "file",
        repo: "deepseek-ai/deepseek-harness",
        ref: "master",
        path: "packages/bundle/base/cordis.patch.yml",
        claims: ["id: agent-instructions", "maxBytes: 65536"],
        note: "the 65,536-byte render budget",
      },
      {
        kind: "file",
        repo: "deepseek-ai/deepseek-harness",
        ref: "master",
        path: "apps/cli/src/profile-boot.ts",
        claims: ["join(resolveDshHome(), PROFILE_PATCH_FILENAME)"],
        note: "$DSH_HOME/cordis.patch.yml",
      },
      {
        kind: "file",
        repo: "deepseek-ai/deepseek-harness",
        ref: "master",
        path: "packages/boot/app-boot/src/profile.ts",
        claims: ["PROFILE_PATCH_FILENAME = 'cordis.patch.yml'"],
        note: "the patch file's name",
      },
      {
        kind: "file",
        repo: "deepseek-ai/deepseek-harness",
        ref: "master",
        path: "packages/experimental/hooks-claude-code/src/index.ts",
        claims: [
          "JSON.parse(readFileSync(config.configPath, 'utf8'))",
          "runPoint('SessionStart', source, sessionStartPayload(agent, source)",
        ],
        note: "the bridge reads its config file and registers SessionStart",
      },
      {
        kind: "file",
        repo: "deepseek-ai/deepseek-harness",
        ref: "master",
        path: "packages/experimental/hook-protocol/src/runner.ts",
        claims: ["hook.timeoutSec * 1000"],
        note: "the hook timeout is in seconds",
      },
      {
        kind: "file",
        repo: "deepseek-ai/deepseek-harness",
        ref: "master",
        path: "packages/experimental/hooks-claude-code/package.json",
        claims: ['"@deepseek-ai/dsh-hooks-claude-code"'],
        note: "the dsh-hooks-claude-code plugin",
      },
      {
        kind: "file",
        repo: "deepseek-ai/deepseek-harness",
        ref: "master",
        path: "packages/context/agent-instructions/README.md",
        claims: ["`.claude/rules/`, and `@path` imports are not interpreted"],
        note: "no rules directory and no @path expansion",
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

export const dsh = toDefinition(spec, (declared) => ({ reconcile: bridgeReconciler(declared) }));
