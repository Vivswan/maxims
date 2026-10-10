import type { HarnessSpec } from "../spec.ts";

// Warp applies the ALL CAPS `AGENTS.md` at the repository root and in the current directory, and
// a `WARP.md` beside it takes priority; global rules live in Warp Drive, not in a file. Warp has
// no hook system, so the tier-2 mechanisms carry freshness; its global MCP servers launch when
// Warp starts. The app's data directories differ per platform and `~/.warp` appears on demand, so
// detection accepts any of them.
export const spec = {
  id: "warp",
  displayName: "Warp",
  tier: 2,
  verifiedAgainst: {
    date: "2026-10-07",
    sources: [
      {
        kind: "file",
        repo: "warpdotdev/docs",
        ref: "main",
        path: "src/content/docs/agents/capabilities/rules.mdx",
        claims: [
          "If both `WARP.md` and `AGENTS.md` exist in the same directory, `WARP.md` takes priority.",
          "Global Rules",
        ],
        note: "WARP.md over AGENTS.md in the project, global rules only in the app",
      },
      {
        kind: "file",
        repo: "warpdotdev/docs",
        ref: "main",
        path: "src/content/docs/agents/capabilities/mcp.mdx",
        claims: ["~/.warp/.mcp.json", "mcpServers", ".warp/.mcp.json"],
        note: "mcpServers in ~/.warp/.mcp.json",
      },
    ],
  },
  targets: {
    project: { kind: "shared-block", file: "AGENTS.md", precedence: ["WARP.md", "AGENTS.md"] },
    global: null,
  },
  bodiesDir: { project: ".agents/memories", global: null },
  markers: "counted",
  expands: [],
  detect: {
    dirs: [".warp", ".config/warp-terminal", "Library/Group Containers/2BBY89MBSN.dev.warp"],
  },
  hook: { kind: "none" },
  mcp: { path: { project: null, global: ".warp/.mcp.json" }, serversPath: ["mcpServers"] },
  fixtures: { config: "mcp.json" },
} satisfies HarnessSpec;
