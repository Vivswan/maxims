import { toDefinition } from "../from-spec.ts";
import type { HarnessSpec } from "../spec.ts";

// Without `applyTo` an instructions file is path-scoped by Copilot's own matching and silently
// stops being always-loaded, so the frontmatter is never omitted. Copilot picks `bash` on POSIX and
// `powershell` on Windows and never falls back between them, so both carry the same command or the
// hook is silently inert on one platform.
export const spec = {
  id: "copilot",
  displayName: "GitHub Copilot",
  tier: 1,
  verifiedAgainst: {
    date: "2026-10-07",
    sources: [
      {
        kind: "file",
        repo: "github/docs",
        ref: "main",
        path: "content/copilot/reference/hooks-reference.md",
        claims: [
          ".github/hooks/*.json",
          "COPILOT_HOME",
          "sessionStart",
          "timeoutSec",
          "Only `additionalContext` is consumed for `sessionStart`",
          '"bash"',
          '"powershell"',
        ],
        note: "the hooks files, the sessionStart event and its fields",
      },
      {
        kind: "file",
        repo: "github/docs",
        ref: "main",
        path: "content/copilot/reference/copilot-cli-reference/cli-config-dir-reference.md",
        claims: ["`~/.copilot`", "instructions/", "hooks/", "COPILOT_HOME"],
        note: "COPILOT_HOME and the hooks and instructions directories under it",
      },
      {
        kind: "file",
        repo: "github/docs",
        ref: "main",
        path: "data/reusables/copilot/custom-instructions-path.md",
        claims: [".github/instructions", ".instructions.md", "applyTo"],
        note: ".github/instructions and the applyTo frontmatter",
      },
    ],
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

export const copilot = toDefinition(spec);
