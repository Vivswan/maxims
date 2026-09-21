import { Writable } from "node:stream";
import type { Runner } from "../sources/github/ladder.ts";
import { maximsHome } from "../util/home.ts";
import type { EngineBundle } from "./types.ts";

// What a run may replace in the real engine: the HTTP, `gh` and git runner the fetch ladder
// climbs (a scripted one in a test), and whether resolver warnings may reach stderr (a hook run
// stays silent). The harness list is the built-in registry plus the user's `harnesses.json` in
// the maxims home `env` names.
export type EngineOptions = {
  runner?: Runner;
  quiet: boolean;
  env: NodeJS.ProcessEnv;
};

// The bin's engine, loaded only when a verb runs so `--help`, `--version` and a usage error never
// pay for the planner, the fetch ladder or the harness registry: every module below is imported
// here and nowhere on the static path from the bin entry.
export async function createEngine(options: EngineOptions): Promise<EngineBundle> {
  const [
    { runSync },
    { runRemove },
    { runList },
    { achievedTier, planHookOnly },
    { serveMcpStub },
    { HARNESSES },
    { loadUserDefinedHarnesses },
    { createResolvers },
  ] = await Promise.all([
    import("./sync.ts"),
    import("./remove.ts"),
    import("./list.ts"),
    import("../harnesses/hook-writer.ts"),
    import("../harnesses/mcp-stub/server.ts"),
    import("../harnesses/registry.ts"),
    import("../harnesses/user-defined.ts"),
    import("./shared/resolvers.ts"),
  ]);
  const warn = options.quiet
    ? () => undefined
    : (line: string) => process.stderr.write(`maxims: ${line}\n`);
  const harnesses = [...HARNESSES, ...(await loadUserDefinedHarnesses(maximsHome(options.env)))];
  // Which rung failed is the engine's to record beside the failure it keeps; printed here it would
  // stand beside the run's own line about the same fetch.
  const resolvers = createResolvers({
    warn,
    rung: () => undefined,
    env: options.env,
    ...(options.runner === undefined ? {} : { runner: options.runner }),
  });
  return {
    harnesses,
    resolvers,
    engine: {
      runSync,
      runRemove,
      runList,
      planHookAlone: (def, scope, ctx, wanted) => planHookOnly({ def, scope, ctx, wanted }),
      achievedTier,
      serveMcpStub: (stub) =>
        serveMcpStub({
          runSync: stub.runSync,
          input: stub.input,
          output: writableOver(stub.output),
          stderr: writableOver(stub.stderr),
        }),
    },
  };
}

function writableOver(sink: { write(chunk: string): unknown }): Writable {
  return new Writable({
    write(chunk: Buffer | string, _encoding, callback) {
      sink.write(typeof chunk === "string" ? chunk : chunk.toString("utf8"));
      callback();
    },
  });
}
