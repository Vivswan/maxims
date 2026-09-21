import { contentHashLiteral } from "../../memory/contract.ts";
import type { HarnessSpec } from "../spec.ts";

// Cline rules without frontmatter are always active, so the file is the block and nothing more.
// Cline reads the hook's stdout as one JSON object, so sync's own output is discarded and the
// script answers for it; stdin carries task metadata sync never needs, and closing it keeps a
// session start from hanging on a reader. The hook only runs once the user turns on "Enable Hooks"
// in Cline's feature settings, which live in the editor's own storage: no file on disk reveals the
// switch, so the tier stays 1.
export const spec = {
  id: "cline",
  displayName: "Cline",
  tier: 1,
  verifiedAgainst: {
    date: "2026-09-21",
    pages: [
      {
        url: "https://raw.githubusercontent.com/cline/cline/main/.clinerules/hooks/README.md",
        contentHash: contentHashLiteral(
          "sha256:afeb7a02b27409a0c4f9e910d17f64fef8e16d97e5fddfc5728db82aa4c9e87e",
        ),
      },
      {
        url: "https://docs.cline.bot/customization/cline-rules",
        contentHash: contentHashLiteral(
          "sha256:8f388c3e9aa9be79c98e90a88c8df8639a3175e6a3478fea44db49a3302c9d88",
        ),
        note: ".clinerules and Documents/Cline/Rules",
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
  detect: { dirs: ["Documents/Cline", ".cline"] },
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
