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
    date: "2026-10-07",
    pages: [
      {
        url: "https://docs.warp.dev/knowledge-and-collaboration/rules",
        contentHash: contentHashLiteral(
          "sha256:7535af1dccba1e4f820698ae1596687d218a89d3d094265bd8a6c94747cd4f84",
        ),
      },
      {
        url: "https://docs.warp.dev/knowledge-and-collaboration/mcp",
        contentHash: contentHashLiteral(
          "sha256:76a4efca41ecb88282c4490e30217eb075351f1895875740f7812a6f2420192b",
        ),
        note: "~/.warp/.mcp.json",
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
