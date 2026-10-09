import { contentHashLiteral } from "../../memory/contract.ts";
import type { HarnessSpec } from "../spec.ts";

// Copilot CLI reads its user files from $COPILOT_HOME before falling back to ~/.copilot; the
// instructions directory and the hooks directory both move with it. Without `applyTo` an
// instructions file is path-scoped by Copilot's own matching and silently stops being
// always-loaded, so the frontmatter is never omitted; `**` matches every file. Copilot runs `bash`
// on POSIX and `powershell` on Windows; the cloud agent ignores `powershell`. The cross-platform
// `command` key only fills in an absent `bash` or `powershell`, so the explicit pair stays.
export const spec = {
  id: "copilot",
  displayName: "GitHub Copilot",
  tier: 1,
  verifiedAgainst: {
    date: "2026-10-09",
    pages: [
      {
        url: "https://docs.github.com/en/copilot/reference/hooks-configuration",
        contentHash: contentHashLiteral(
          "sha256:799ddf1ec9dbc46b44f48b720d224e343832dc1d84cc56c96d68c90db6bbe560",
        ),
      },
      {
        url: "https://docs.github.com/en/copilot/how-tos/configure-custom-instructions/add-repository-instructions",
        contentHash: contentHashLiteral(
          "sha256:0aaf0909ed8cf0740eedb39fed49711d8e0bc1b31f899bb7e5fe87551d10dd31",
        ),
        note: ".github/instructions and the applyTo frontmatter",
      },
      {
        url: "https://docs.github.com/en/copilot/reference/copilot-cli-reference/cli-config-dir-reference",
        contentHash: contentHashLiteral(
          "sha256:ed0ee4efb7abcb34681bfa7070c0aa3ddd59301e7a60fcde91c56af98297c144",
        ),
        note: "COPILOT_HOME and the hooks and instructions directories under it",
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
