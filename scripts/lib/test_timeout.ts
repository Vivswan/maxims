// A row that runs a chain of git processes (a fixture repository, a clone) spends bun's default
// five seconds on process start-up alone on a cold Windows runner, where each git start costs a
// large fraction of a second. The launcher widens the budget there and keeps bun's own elsewhere.
export const DEFAULT_TEST_TIMEOUT_MS = 5_000;
export const WINDOWS_TEST_TIMEOUT_MS = 30_000;

// The arguments the launcher hands `bun test`: the platform's timeout, unless the caller's own
// arguments already carry one.
export function bunTestArgs(platform: NodeJS.Platform, argv: readonly string[]): string[] {
  const explicit = argv.some((arg) => arg === "--timeout" || arg.startsWith("--timeout="));
  if (explicit) return [...argv];
  const timeout = platform === "win32" ? WINDOWS_TEST_TIMEOUT_MS : DEFAULT_TEST_TIMEOUT_MS;
  return [`--timeout=${timeout}`, ...argv];
}
