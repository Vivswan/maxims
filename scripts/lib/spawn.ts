import { execFileSync } from "node:child_process";

// A build or timing step is read as it happens, so its output is inherited rather than captured.
export function runOrThrow(file: string, args: string[], cwd: string): void {
  execFileSync(file, args, { cwd, stdio: ["ignore", "inherit", "inherit"] });
}
