import { toDefinition } from "../from-spec.ts";
import type { HarnessSpec } from "../spec.ts";

// Cline rules without frontmatter are always active, so the file is the block and nothing more.
// Cline reads workspace rules from .clinerules and from .cline/rules. Its own Rules panel creates
// new ones in .clinerules. Global rules default to Documents/Cline/Rules; Cline also searches
// ~/.cline/rules and ~/Cline/Rules.
// Cline reads the hook's stdout as one JSON object, so sync's own output is discarded and the
// script answers for it; stdin carries task metadata sync never needs, and closing it keeps a
// session start from hanging on a reader. The "Enable Hooks" switch that turns hooks off lives in
// the editor's own storage, not in a file, so there is no tierCheck: a user who switched them off
// is reported at tier 1 all the same.
export const spec = {
  id: "cline",
  displayName: "Cline",
  tier: 1,
  verifiedAgainst: {
    date: "2026-10-10",
    sources: [
      {
        kind: "file",
        repo: "cline/cline",
        ref: "main",
        path: "sdk/packages/shared/src/storage/paths.ts",
        claims: [
          'DEPRECATED_CONFIG_DIR = ".clinerules"',
          'CLINE_CONFIG_DIR = ".cline"',
          'RULES_CONFIG_DIRECTORY_NAME = "rules"',
          '"Cline", "Rules"',
        ],
        note: ".clinerules, .cline/rules and Documents/Cline/Rules",
      },
      {
        kind: "file",
        repo: "cline/cline",
        ref: "main",
        path: "apps/vscode/src/core/storage/disk.ts",
        claims: [
          'clineRules: ".clinerules"',
          'hooksDir: ".clinerules/hooks"',
          '"Documents", "Cline", "Rules"',
          '"Documents", "Cline", "Hooks"',
        ],
        note: ".clinerules/hooks and Documents/Cline/Hooks",
      },
      {
        kind: "file",
        repo: "cline/cline",
        ref: "main",
        path: "apps/vscode/src/core/hooks/hook-factory.ts",
        claims: ["TaskStart", "JSON.parse(stdout)", "output.cancel !== undefined"],
        note: "the TaskStart hook and its JSON stdout",
      },
      {
        kind: "file",
        repo: "cline/cline",
        ref: "main",
        path: "apps/vscode/src/shared/storage/state-keys.ts",
        claims: ["hooksEnabled: { default: true as boolean }"],
        note: "hooks on by default",
      },
      {
        kind: "file",
        repo: "cline/cline",
        ref: "main",
        path: "apps/vscode/src/sdk/hooks-adapter.ts",
        claims: ['stateManager.getGlobalSettingsKey("hooksEnabled")', "if (!hooksEnabled())"],
        note: "the Enable Hooks switch, read from the editor's storage and not from a file",
      },
      {
        kind: "file",
        repo: "cline/cline",
        ref: "main",
        path: ".clinerules/hooks/README.md",
        claims: ["TaskStart", "chmod +x"],
        note: "an executable file named for the event",
      },
      {
        kind: "file",
        repo: "cline/cline",
        ref: "main",
        path: "docs/customization/cline-rules.mdx",
        claims: [
          ".clinerules/",
          ".cline/rules/",
          "~/Documents/Cline/Rules",
          "~/.cline/rules",
          "~/Cline/Rules",
        ],
        note: ".clinerules as where new workspace rules go and Documents/Cline/Rules as the global default; .cline/rules, ~/.cline/rules and ~/Cline/Rules also searched",
      },
    ],
  },
  targets: {
    project: { kind: "rules-dir", dir: ".clinerules", fileName: "maxims-{{slug}}.md" },
    global: { kind: "rules-dir", dir: "Documents/Cline/Rules", fileName: "maxims-{{slug}}.md" },
  },
  bodiesDir: { project: ".agents/memories", global: null },
  markers: "counted",
  expands: [],
  detect: { dirs: ["Documents/Cline", ".cline", "Cline/Rules"] },
  hook: {
    kind: "file",
    path: { project: ".clinerules/hooks/TaskStart", global: "Documents/Cline/Hooks/TaskStart" },
    contentTemplate: [
      "#!/usr/bin/env sh",
      "# Written by maxims. Remove it with `maxims remove` or delete this file; edits are overwritten.",
      "{{command}} </dev/null >/dev/null 2>&1",
      `printf '%s\\n' '{"cancel": false}'`,
      "",
    ].join("\n"),
    executable: true,
    stdout: "none",
  },
  fixtures: { hookStdin: "hook-stdin.json" },
} satisfies HarnessSpec;

export const cline = toDefinition(spec);
