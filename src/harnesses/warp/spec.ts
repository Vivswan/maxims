import { toDefinition } from "../from-spec.ts";
import type { HarnessSpec } from "../spec.ts";

// Warp applies the ALL CAPS `AGENTS.md` at the repository root and in the current directory, and
// a `WARP.md` beside it takes priority; global rules live in Warp Drive, not in a file. Warp has
// no hook system, so the MCP stub carries freshness.
export const spec = {
  id: "warp",
  displayName: "Warp",
  tier: 2,
  verifiedAgainst: {
    date: "2026-10-10",
    sources: [
      {
        kind: "file",
        repo: "warpdotdev/docs",
        ref: "main",
        path: "src/content/docs/agents/capabilities/rules.mdx",
        claims: [
          "Warp automatically applies the `AGENTS.md` (or `WARP.md`) in the root and in the current directory.",
          "If both `WARP.md` and `AGENTS.md` exist in the same directory, `WARP.md` takes priority.",
          "The filename must be in **all caps** for Warp to recognize it",
          "Global Rules",
        ],
        note: "the all-caps AGENTS.md at the root and in the current directory, WARP.md over it, global rules only in the app",
      },
      {
        kind: "file",
        repo: "warpdotdev/docs",
        ref: "main",
        path: "src/content/docs/agents/capabilities/mcp.mdx",
        claims: [
          "| Warp | `~/.warp/.mcp.json` | `.warp/.mcp.json` at project root |",
          "mcpServers",
          "Global Warp servers auto-spawn by default.",
          "Project-scoped servers never auto-spawn",
        ],
        note: "mcpServers in ~/.warp/.mcp.json, which auto-spawns; the project .warp/.mcp.json never does, so it gets no stub",
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
    // The app's data directory differs per platform and `~/.warp` appears on demand.
    dirs: [".warp", ".config/warp-terminal", "Library/Group Containers/2BBY89MBSN.dev.warp"],
  },
  hook: { kind: "none" },
  // Global servers auto-spawn when Warp starts. A project `.warp/.mcp.json` exists too, but its
  // servers never auto-spawn and need a manual toggle each session, so a stub there syncs nothing.
  mcp: { path: { project: null, global: ".warp/.mcp.json" }, serversPath: ["mcpServers"] },
  fixtures: { config: "mcp.json" },
} satisfies HarnessSpec;

export const warp = toDefinition(spec);
