// A real git remote on the loopback interface: `git daemon` serving every repository under one
// base path, so the bundle's fetch ladder (ls-remote, then the sparse shallow clone) runs against
// a remote the row can stop, empty or rewind. `git://` is the one transport git serves without a
// web server or ssh, and the ladder admits it (GIT_ALLOW_PROTOCOL lists it).
import { statSync } from "node:fs";
import { join } from "node:path";
import type { Subprocess } from "bun";

export type GitDaemon = {
  port: number;
  url(name: string): string;
  stop(): Promise<void>;
};

export type GitDaemonProbe = { kind: "available" } | { kind: "unavailable"; reason: string };

// `git daemon` is a separate helper binary some distributions leave out of the git package, so a
// suite that needs it asks once, up front, and skips with the reason instead of failing every row.
// Only a confirmed absence skips: a git that cannot be asked, or a helper path that cannot be
// inspected, is a broken machine and throws rather than passing as a skip.
export function probeGitDaemon(): GitDaemonProbe {
  const result = Bun.spawnSync(["git", "--exec-path"], { stdout: "pipe", stderr: "pipe" });
  if (result.exitCode !== 0) {
    throw new Error(
      `git --exec-path exited ${result.exitCode}: ${result.stderr.toString().trim()}`,
    );
  }
  const execPath = result.stdout.toString("utf8").trim();
  const helper = join(execPath, process.platform === "win32" ? "git-daemon.exe" : "git-daemon");
  try {
    statSync(helper);
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      return { kind: "unavailable", reason: `${helper} is not installed` };
    }
    throw error;
  }
  return { kind: "available" };
}

const HOST = "127.0.0.1";
const BIND_ATTEMPTS = 5;
const READY_TIMEOUT_MS = 5000;

export async function withGitDaemon<T>(
  basePath: string,
  fn: (daemon: GitDaemon) => Promise<T>,
): Promise<T> {
  const daemon = await startGitDaemon(basePath);
  try {
    return await fn(daemon);
  } finally {
    await daemon.stop();
  }
}

// The kernel picks a free port for a throwaway listener and the daemon then binds that number;
// another process may take it in between, so a daemon that dies on its bind is started again on a
// fresh number.
function freePort(): number {
  const listener = Bun.listen({ hostname: HOST, port: 0, socket: { data() {} } });
  const port = listener.port;
  listener.stop(true);
  return port;
}

async function startGitDaemon(basePath: string): Promise<GitDaemon> {
  let lastFailure = "";
  for (let attempt = 0; attempt < BIND_ATTEMPTS; attempt += 1) {
    const started = await spawnDaemon(basePath, freePort());
    if (started.kind === "ready") return started.daemon;
    lastFailure = started.stderr;
    if (!started.stderr.includes("Address already in use")) break;
  }
  throw new Error(`git daemon did not start under ${basePath}:\n${lastFailure}`);
}

type Spawned = { kind: "ready"; daemon: GitDaemon } | { kind: "failed"; stderr: string };

// Readiness is the daemon's own word: under --verbose it logs "Ready to rumble" once it listens,
// so a port another process answers on is never mistaken for ours.
async function spawnDaemon(basePath: string, port: number): Promise<Spawned> {
  const child: Subprocess<"ignore", "ignore", "pipe"> = Bun.spawn(
    [
      "git",
      "daemon",
      "--verbose",
      `--listen=${HOST}`,
      `--port=${port}`,
      `--base-path=${basePath}`,
      "--export-all",
      "--reuseaddr",
      basePath,
    ],
    { stdin: "ignore", stdout: "ignore", stderr: "pipe" },
  );
  const stop = async (): Promise<void> => {
    if (child.exitCode === null) child.kill();
    await child.exited;
  };
  const stderr = child.stderr.getReader();
  const decoder = new TextDecoder();
  let seen = "";
  const deadline = Date.now() + READY_TIMEOUT_MS;
  while (!seen.includes("Ready to rumble")) {
    const remaining = deadline - Date.now();
    if (remaining <= 0) {
      await stop();
      return {
        kind: "failed",
        stderr: `${seen}\n(no readiness line within ${READY_TIMEOUT_MS} ms)`,
      };
    }
    const chunk = await Promise.race([
      stderr.read(),
      Bun.sleep(remaining).then(() => ({ done: true, value: undefined }) as const),
    ]);
    if (chunk.done) {
      await stop();
      return { kind: "failed", stderr: seen || `git daemon exited ${child.exitCode}` };
    }
    seen += decoder.decode(chunk.value, { stream: true });
  }
  // The daemon logs every connection; nobody reads those lines, so the pipe is drained rather
  // than left to fill and block the daemon.
  void drain(stderr);
  return { kind: "ready", daemon: { port, url: (name) => `git://${HOST}:${port}/${name}`, stop } };
}

async function drain(reader: ReadableStreamDefaultReader<Uint8Array>): Promise<void> {
  for (;;) {
    const { done } = await reader.read();
    if (done) return;
  }
}
