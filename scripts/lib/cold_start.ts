// One cold start of a command: a fresh process with its own throwaway HOME, so the number is the
// every-session cost and nothing the developer's real home holds can shorten or lengthen it.
import { tmpdir } from "node:os";
import { join } from "node:path";
import { withScratchDir } from "./scratch.ts";

export interface ColdStart {
  elapsedMs: number;
  exitCode: number | null;
  signalCode: string | undefined;
  stderr: string;
}

// The HOME is rooted at tmpdir(), never RUNNER_TEMP: tests/bench.test.ts finds it through TMPDIR.
export function timeColdStart(command: string[]): Promise<ColdStart> {
  return withScratchDir(
    "maxims-bench-home-",
    (home) => {
      const env = {
        ...process.env,
        HOME: home,
        USERPROFILE: home,
        MAXIMS_HOME: join(home, ".agents", "maxims"),
        NO_COLOR: "1",
      };
      const started = performance.now();
      const proc = Bun.spawnSync(command, {
        env,
        stdin: "ignore",
        stdout: "ignore",
        stderr: "pipe",
      });
      const elapsedMs = performance.now() - started;
      return {
        elapsedMs,
        exitCode: proc.exitCode,
        signalCode: proc.signalCode,
        stderr: proc.stderr.toString(),
      };
    },
    tmpdir(),
  );
}

export function exitDescription(result: ColdStart): string {
  return result.exitCode === null
    ? `was killed by ${result.signalCode}`
    : `exited with code ${result.exitCode}`;
}
