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
    url: "https://docs.warp.dev/knowledge-and-collaboration/rules",
    date: "2026-09-20",
    contentHash: contentHashLiteral(
      "sha256:8bb458d10895a0344c908be66f9871d840bb4132ab62fcf7ecc6bf06b79339fe",
    ),
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
