import { ExitCode } from "../util/exit-codes.ts";
import { engineIo, SILENT } from "./shared/engine-io.ts";
import { type Command, usage } from "./shared/options.ts";

// Hidden from `--help`: a harness that starts its MCP servers eagerly spawns `maxims mcp-serve`
// and the sync runs before the agent reads a word. The server exposes zero tools; the quiet sync
// at start is its entire behavior. Both streams belong to the protocol, so the sync it starts
// prints nowhere and reads no hook payload.
export const mcpServe: Command = {
  summary: "serve the tool-less MCP stub whose start runs a quiet sync",
  usage: "mcp-serve",
  arity: 0,
  flags: [],
  async run(_args, ctx) {
    if (ctx.global.json) throw usage("mcp-serve speaks MCP on stdout; drop --json");
    const io = engineIo(ctx.io, { stdout: SILENT, readStdin: async () => null });
    // The server outlives its sync by the whole session, so the rung reasons land now rather
    // than when the harness closes stdin.
    await ctx.engine.serveMcpStub({
      runSync: () =>
        ctx.engine
          .runSync({ quiet: true, dryRun: ctx.global.dryRun, json: false, fetch: "due" }, io)
          .finally(ctx.flushRungLog),
      input: ctx.io.stdin,
      output: ctx.io.stdout,
      stderr: ctx.io.stderr,
    });
    return ExitCode.Ok;
  },
};
