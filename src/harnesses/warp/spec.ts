import { contentHashLiteral } from "../../memory/contract.ts";
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
    date: "2026-09-21",
    pages: [
      {
        url: "https://docs.warp.dev/knowledge-and-collaboration/rules",
        contentHash: contentHashLiteral(
          "sha256:cd2feee9ff5f88c387142d089900a2868fd66edfaec14651e7dcb0b69a9cab1d",
        ),
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
