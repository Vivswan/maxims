import { parseContentHash } from "../../memory/contract.ts";
import type { HarnessSpec } from "../spec.ts";

// Zed reads exactly one project instruction file, the first of nine names that exists at the
// worktree root, so the block goes into whichever the repository already has and only a bare
// repository gets an AGENTS.md. The config directory follows `$XDG_CONFIG_HOME/zed` on Linux and
// FreeBSD (`~/.config/zed` on macOS regardless). Zed has no hook system; its MCP servers live
// under `context_servers` in settings.json.
export const spec = {
  id: "zed",
  displayName: "Zed",
  tier: 2,
  verifiedAgainst: {
    url: "https://zed.dev/docs/ai/instructions",
    date: "2026-09-20",
    contentHash:
      parseContentHash("sha256:22f2de60f9767faa275d538380f075f236e2400905a0ba7663265311bacec515") ??
      undefined,
  },
  globalRoot: { default: ".config/zed", env: { name: "XDG_CONFIG_HOME", subdir: "zed" } },
  targets: {
    project: {
      kind: "shared-block",
      file: "AGENTS.md",
      precedence: [
        ".rules",
        ".cursorrules",
        ".windsurfrules",
        ".clinerules",
        ".github/copilot-instructions.md",
        "AGENT.md",
        "AGENTS.md",
        "CLAUDE.md",
        "GEMINI.md",
      ],
    },
    global: { kind: "shared-block", file: "AGENTS.md" },
  },
  bodiesDir: { project: ".agents/memories", global: null },
  markers: "counted",
  expands: [],
  detect: { dirs: ["."] },
  hook: { kind: "none" },
  mcp: {
    path: { project: ".zed/settings.json", global: "settings.json" },
    serversPath: ["context_servers"],
  },
  fixtures: { config: "settings.json" },
} satisfies HarnessSpec;
