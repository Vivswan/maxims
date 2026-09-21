import type { Sink } from "../../console/contract.ts";
import { ExitCode, MaximsError } from "../../util/exit-codes.ts";
import type { CliIo, EngineIo, SymlinkSupport } from "../types.ts";
import { ReportedMaximsError } from "./errors.ts";
import { probeSymlinkSupport } from "./fs-probe.ts";
import { readHookStdin } from "./stdin.ts";

// What the engine may take from the process on this run: where its lines go, and whether it may
// read stdin for a hook payload. `mcp-serve` owns both streams for its protocol, so its sync
// prints nowhere and reads nothing.
export type EngineIoOptions = {
  stdout: Sink;
  stderr?: Sink;
  readStdin?: () => Promise<string | null>;
};

// The one mapping from what the command line holds to what the engine takes. The symlink probe
// runs at most once per run, on the first bodies write that asks.
export function engineIo(io: CliIo, options: EngineIoOptions): EngineIo {
  let symlink: Promise<SymlinkSupport> | null = null;
  return {
    stdout: (text) => options.stdout.write(text),
    stderr: (text) => (options.stderr ?? io.stderr).write(text),
    resolvers: io.resolvers,
    harnesses: io.harnesses,
    now: io.now,
    env: io.env,
    cwd: io.cwd,
    readStdin: options.readStdin ?? (() => readHookStdin(io.stdin)),
    symlinkSupport: () => {
      symlink ??= probeSymlinkSupport();
      return symlink;
    },
  };
}

// A verb that frames its own output (add, install, update, link, disable) hands the engine sinks
// that keep nothing: the report carries every notice and failure the frame prints, and the plan
// and the `--json` document are the verb's to render once. A failure the engine printed into
// those sinks was seen by nobody, so it is rethrown as an ordinary error for the frame to print.
export const SILENT: Sink = { write: () => undefined };

export async function framed<T>(io: CliIo, run: (engine: EngineIo) => Promise<T>): Promise<T> {
  try {
    return await run(engineIo(io, { stdout: SILENT, stderr: SILENT }));
  } catch (error) {
    if (!(error instanceof ReportedMaximsError)) throw error;
    throw new MaximsError(error.code, error.message, {
      ...(error.hint === undefined ? {} : { hint: error.hint }),
    });
  }
}

// The exit a manual run maps a report's failed sources to: nothing failed is 0, every failure a
// source with nothing valid to install is 3, anything else 2.
export function exitForFailed(failed: readonly { kind: string }[]): ExitCode {
  if (failed.length === 0) return ExitCode.Ok;
  return failed.every((failure) => failure.kind === "invalid")
    ? ExitCode.NothingResolved
    : ExitCode.SourceUnresolvable;
}
