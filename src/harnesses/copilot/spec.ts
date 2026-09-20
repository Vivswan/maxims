import type { HarnessSpec } from "../spec.ts";

// Copilot CLI reads its user files from $COPILOT_HOME before falling back to ~/.copilot; the
// instructions directory and the hooks directory both move with it. Without `applyTo` an
// instructions file is path-scoped by Copilot's own matching and silently stops being
// always-loaded, so the frontmatter is never omitted; `**` matches every file. Copilot picks `bash`
// on POSIX and `powershell` on Windows and never falls back between them, so both carry the same
// command or the hook is silently inert on one platform.
export const spec = {
  id: "copilot",
  displayName: "GitHub Copilot",
  tier: 1,
  verifiedAgainst: {
    url: "https://docs.github.com/en/copilot/reference/hooks-configuration",
    date: "2026-09-20",
  },
  globalRoot: { default: ".copilot", env: { name: "COPILOT_HOME" } },
  targets: {
    project: {
      kind: "rules-dir",
      dir: ".github/instructions",
      fileName: "maxims-{{slug}}.instructions.md",
      frontmatter: {
        always: { applyTo: "**" },
        scoped: { fields: {}, pathsKey: "applyTo", pathsAs: "comma-list" },
      },
    },
    global: {
      kind: "rules-dir",
      dir: "instructions",
      fileName: "maxims-{{slug}}.instructions.md",
      frontmatter: {
        always: { applyTo: "**" },
        scoped: { fields: {}, pathsKey: "applyTo", pathsAs: "comma-list" },
      },
    },
  },
  bodiesDir: { project: ".agents/memories", global: null },
  markers: "counted",
  expands: [],
  detect: { dirs: ["."] },
  hook: {
    kind: "file",
    path: { project: ".github/hooks/maxims.json", global: "hooks/maxims.json" },
    contentTemplate: [
      "{",
      '  "version": 1,',
      '  "hooks": {',
      '    "sessionStart": [',
      "      {",
      '        "type": "command",',
      '        "bash": "{{command}}",',
      '        "powershell": "{{command}}",',
      '        "timeoutSec": {{timeoutSeconds}}',
      "      }",
      "    ]",
      "  }",
      "}",
      "",
    ].join("\n"),
    executable: false,
    stdout: "json:additionalContext",
  },
  fixtures: { hookStdin: "hook-stdin.json" },
} satisfies HarnessSpec;
