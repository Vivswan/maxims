import { ExitCode, MaximsError } from "../util/exit-codes.ts";
import type { EngineBundle } from "./types.ts";

// The bin's engine: the sync, remove and list runners, the harness registry and the source
// resolvers, loaded only when a verb runs so `--help` and `--version` never pay for them. This
// build carries none of them yet, so every verb that reaches the engine stops here with a clear
// message instead of a missing-module stack trace.
export function loadEngine(): Promise<EngineBundle> {
  return Promise.reject(
    new MaximsError(ExitCode.Usage, "this build of maxims carries no sync engine", {
      hint: "install a release that includes it",
    }),
  );
}
