import { execFileSync } from "node:child_process";

// A build or timing step is read as it happens, so its output is inherited rather than captured.
export function runOrThrow(file: string, args: string[], cwd: string): void {
  execFileSync(file, args, { cwd, stdio: ["ignore", "inherit", "inherit"] });
}

export interface CaptureOptions {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
}

// execFileSync kills the child once its captured output passes 1 MiB unless told otherwise, and
// a tracked-file listing has no such bound.
export function captureOrThrow(file: string, args: string[], options: CaptureOptions = {}): string {
  return execFileSync(file, args, {
    ...options,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    maxBuffer: Number.POSITIVE_INFINITY,
  });
}
