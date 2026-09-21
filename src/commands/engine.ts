import { Writable } from "node:stream";
import type { Runner } from "../sources/github/ladder.ts";
import { maximsHome } from "../util/home.ts";
import { appendRefreshLog } from "../util/log.ts";
import type { CommonOptions, EngineBundle, EngineIo } from "./types.ts";

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
  const home = maximsHome(options.env);
  const harnesses = [...HARNESSES, ...(await loadUserDefinedHarnesses(home))];
  const rungs = rungLog(home);
  const resolvers = createResolvers({
    warn,
    rung: rungs.rung,
    env: options.env,
    ...(options.runner === undefined ? {} : { runner: options.runner }),
  });
  return {
    harnesses,
    resolvers,
    engine: {
      runSync: (verbOptions, io) => rungs.logged(verbOptions, io, () => runSync(verbOptions, io)),
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

type RungLog = {
  rung: (line: string) => void;
  logged<T>(options: CommonOptions, io: EngineIo, run: () => Promise<T>): Promise<T>;
};

// Which rung of a fetch failed and why belongs in refresh.log alone, never beside the run's own
// line about the same fetch on a terminal. The ladder reports a rung the moment it fails and the
// resolvers outlive any one run, so the lines wait here and land once the sync that fetched has
// written its own, stamped the same way; a dry run writes nothing, these included. Only `sync`
// fetches: `remove` never does and `list` reads what is installed.
function rungLog(home: string): RungLog {
  const pending: string[] = [];
  return {
    rung: (line) => pending.push(line),
    async logged(options, io, run) {
      try {
        return await run();
      } finally {
        const lines = pending.splice(0);
        if (!options.dryRun) {
          const stamp = io.now().toISOString();
          const mode = options.quiet ? "sync --quiet" : "sync";
          for (const line of lines) {
            await appendRefreshLog(home, `${stamp} ${mode}: fetch rung failed: ${line}`).catch(
              () => undefined,
            );
          }
        }
      }
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
