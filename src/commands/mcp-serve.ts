import { ExitCode } from "../util/exit-codes.ts";
import type { Command } from "./shared/options.ts";

// Hidden from `--help`: a harness that starts its MCP servers eagerly spawns `maxims mcp-serve`
// and the sync runs before the agent reads a word. The server exposes zero tools; the quiet sync
// at start is its entire behavior.
export const mcpServe: Command = {
  summary: "serve the tool-less MCP stub whose start runs a quiet sync",
  usage: "mcp-serve",
  arity: 0,
  flags: [],
  async run(_args, ctx) {
    await ctx.engine.serveMcpStub({
      runSync: () =>
        ctx.engine.runSync(
          { quiet: true, dryRun: ctx.global.dryRun, json: false, noFetch: false, force: false },
          ctx.io,
        ),
      input: ctx.io.stdin,
      output: ctx.io.stdout,
      stderr: ctx.io.stderr,
    });
    return ExitCode.Ok;
  },
};
