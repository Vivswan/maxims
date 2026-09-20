import { execFile } from "node:child_process";
import { mkdir, rm } from "node:fs/promises";
import { promisify } from "node:util";
import { type SimpleGit, simpleGit } from "simple-git";
import { DEFAULT_GITHUB_REF, type LastError } from "../../state/schema.ts";
import type { WarnSink } from "../tree.ts";
import { extractTarball } from "./tarball.ts";

export type RepoCoordinate = { owner: string; repo: string };

export type FetchFailureKind = LastError["kind"];

export class FetchFailure extends Error {
  readonly kind: FetchFailureKind;
  readonly retryAfterSeconds: number | undefined;

  constructor(kind: FetchFailureKind, message: string, retryAfterSeconds?: number) {
    super(message);
    this.name = "FetchFailure";
    this.kind = kind;
    this.retryAfterSeconds = retryAfterSeconds;
  }
}

export type ExecResult =
  | { kind: "exited"; code: number; stdout: Uint8Array; stderr: string }
  | { kind: "absent" };

export type GitOutcome<T> =
  | { kind: "ok"; value: T }
  | { kind: "absent" }
  | { kind: "failed"; message: string };

export interface GitRunner {
  lsRemote(url: string, patterns: string[]): Promise<GitOutcome<string>>;
  shallowClone(url: string, ref: string, dir: string): Promise<GitOutcome<string>>;
}

export interface Runner {
  exec(binary: string, args: string[]): Promise<ExecResult>;
  fetch(url: string, init: RequestInit): Promise<Response>;
  git: GitRunner;
}

export type Endpoints = {
  ghHost: string;
  apiBase: string;
  gitUrl(repo: RepoCoordinate): string;
  codeloadUrl(repo: RepoCoordinate, ref: string): string;
};

export const GITHUB_ENDPOINTS: Endpoints = {
  ghHost: "github.com",
  apiBase: "https://api.github.com",
  gitUrl: ({ owner, repo }) => `https://github.com/${owner}/${repo}.git`,
  codeloadUrl: ({ owner, repo }, ref) =>
    `https://codeload.github.com/${owner}/${repo}/tar.gz/${ref}`,
};

export type LadderOptions = {
  runner: Runner;
  endpoints: Endpoints;
  warn: WarnSink;
};

export interface Ladder {
  resolveRef(repo: RepoCoordinate, ref: string): Promise<string>;
  fetchTree(repo: RepoCoordinate, sha: string, destDir: string): Promise<void>;
}

const FULL_SHA = /^[0-9a-f]{40}$/;
const HTTP_TIMEOUT_MS = 60_000;
const EXEC_TIMEOUT_MS = 120_000;
const EXEC_MAX_BYTES = 256 * 1024 * 1024;

type RungOutcome<T> =
  | { kind: "ok"; value: T }
  | { kind: "skipped" }
  | { kind: "failed"; failure: FetchFailure };

type Rung<T> = () => Promise<RungOutcome<T>>;

// Rungs are tried in order and every failure falls through; the answer to `gh auth status` is
// remembered per ladder because a session's login state cannot change between two rungs. Every gh
// command names the host, or an inherited GH_HOST would quietly serve the repo from elsewhere.
export function createLadder(options: LadderOptions): Ladder {
  const { runner, endpoints, warn } = options;
  const host = ["--hostname", endpoints.ghHost];
  let ghReady: Promise<boolean> | undefined;
  const ghAvailable = (): Promise<boolean> => {
    ghReady ??= runner
      .exec("gh", ["auth", "status", ...host])
      .then((result) => result.kind === "exited" && result.code === 0);
    return ghReady;
  };
  const api = (repo: RepoCoordinate, kind: string, ref: string): string =>
    `repos/${repo.owner}/${repo.repo}/${kind}/${encodeURIComponent(ref)}`;

  return {
    resolveRef: (repo, ref) =>
      climb(warn, [
        async () => {
          if (!(await ghAvailable())) return { kind: "skipped" };
          const result = await runner.exec("gh", [
            "api",
            ...host,
            api(repo, "commits", ref),
            "--jq",
            ".sha",
          ]);
          return ghOutcome("gh api", result, (stdout) =>
            parseSha(new TextDecoder().decode(stdout)),
          );
        },
        async () => {
          const candidates = refCandidates(ref);
          const patterns = candidates.flatMap((name) => [name, `${name}^{}`]);
          const result = await runner.git.lsRemote(endpoints.gitUrl(repo), patterns);
          return gitOutcome("git ls-remote", result, (text) =>
            parseLsRemote(text, ref, candidates),
          );
        },
        async () => {
          const url = `${endpoints.apiBase}/${api(repo, "commits", ref)}`;
          const body = await http(runner, url, { Accept: "application/vnd.github.sha" });
          if (body.kind !== "ok") return body;
          return parseSha(new TextDecoder().decode(body.value));
        },
      ]),
    fetchTree: (repo, sha, destDir) =>
      climb(warn, [
        async () => {
          if (!(await ghAvailable())) return { kind: "skipped" };
          const result = await runner.exec("gh", ["api", ...host, api(repo, "tarball", sha)]);
          return ghOutcome("gh api", result, (stdout) => extract(stdout, destDir, warn));
        },
        async () => {
          await emptyDir(destDir);
          const result = await runner.git.shallowClone(endpoints.gitUrl(repo), sha, destDir);
          return gitOutcome("git clone", result, (head) =>
            head === sha
              ? { kind: "ok", value: undefined }
              : failed("invalid", `git clone checked out ${head}, expected ${sha}`),
          );
        },
        async () => {
          const body = await http(runner, endpoints.codeloadUrl(repo, sha), {});
          if (body.kind !== "ok") return body;
          return extract(body.value, destDir, warn);
        },
      ]),
  };
}

// The most actionable failure wins when every rung fails: a rate limit or a login problem tells
// the user what to do, while a network error is the one everything else degrades into.
const FAILURE_PRIORITY: FetchFailureKind[] = ["ratelimit", "auth", "missing", "invalid", "network"];

// A rung may only end in an outcome: whatever it throws instead is a failure of that rung, never
// the end of the ladder, because a hook that dies here loses the last-good store for nothing.
async function climb<T>(warn: WarnSink, rungs: Rung<T>[]): Promise<T> {
  const failures: FetchFailure[] = [];
  for (const rung of rungs) {
    const outcome = await rung().catch(
      (cause: unknown): RungOutcome<T> =>
        failed("invalid", cause instanceof Error ? cause.message : String(cause)),
    );
    if (outcome.kind === "ok") return outcome.value;
    if (outcome.kind === "skipped") continue;
    warn(outcome.failure.message);
    failures.push(outcome.failure);
  }
  const kind = FAILURE_PRIORITY.find((candidate) => failures.some((f) => f.kind === candidate));
  const matching = failures.filter((f) => f.kind === kind);
  const chosen = matching.find((f) => f.retryAfterSeconds !== undefined) ?? matching[0];
  throw chosen ?? new FetchFailure("invalid", "no fetch method is available on this machine");
}

// A rung that failed half-way leaves files a later rung would otherwise merge into its own tree.
async function emptyDir(dir: string): Promise<void> {
  await rm(dir, { recursive: true, force: true });
  await mkdir(dir, { recursive: true });
}

function failed<T>(
  kind: FetchFailureKind,
  message: string,
  retryAfterSeconds?: number,
): RungOutcome<T> {
  return { kind: "failed", failure: new FetchFailure(kind, message, retryAfterSeconds) };
}

function ghOutcome<T>(
  label: string,
  result: ExecResult,
  onSuccess: (stdout: Uint8Array) => RungOutcome<T> | Promise<RungOutcome<T>>,
): RungOutcome<T> | Promise<RungOutcome<T>> {
  if (result.kind === "absent") return { kind: "skipped" };
  if (result.code !== 0)
    return failed(classifyGh(result.stderr), `${label}: ${firstLine(result.stderr)}`);
  return onSuccess(result.stdout);
}

function gitOutcome<T>(
  label: string,
  result: GitOutcome<string>,
  onSuccess: (value: string) => RungOutcome<T>,
): RungOutcome<T> {
  if (result.kind === "absent") return { kind: "skipped" };
  if (result.kind === "failed") {
    return failed(classifyGit(result.message), `${label}: ${firstLine(result.message)}`);
  }
  return onSuccess(result.value);
}

// The body is read inside the same guard as the request: a connection that drops mid-body is a
// network failure like any other, not an exception that escapes the ladder.
async function http(
  runner: Runner,
  url: string,
  headers: Record<string, string>,
): Promise<RungOutcome<Uint8Array>> {
  try {
    const response = await runner.fetch(url, {
      headers: { "User-Agent": "maxims", ...headers },
      redirect: "follow",
      signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
    });
    if (response.ok) return { kind: "ok", value: new Uint8Array(await response.arrayBuffer()) };
    const classified = classifyResponse(response);
    await response.body?.cancel().catch(() => undefined);
    return failed(classified.kind, `${url}: HTTP ${response.status}`, classified.retryAfterSeconds);
  } catch (cause) {
    return failed("network", `${url}: ${cause instanceof Error ? cause.message : String(cause)}`);
  }
}

async function extract(
  bytes: Uint8Array,
  destDir: string,
  warn: WarnSink,
): Promise<RungOutcome<undefined>> {
  try {
    await emptyDir(destDir);
    await extractTarball(bytes, destDir, warn);
    return { kind: "ok", value: undefined };
  } catch (cause) {
    const detail = cause instanceof Error ? cause.message : String(cause);
    return failed("invalid", `tarball could not be extracted: ${firstLine(detail)}`);
  }
}

function parseSha(text: string): RungOutcome<string> {
  const sha = text.trim().toLowerCase();
  if (FULL_SHA.test(sha)) return { kind: "ok", value: sha };
  return failed("invalid", `expected a commit sha, got ${JSON.stringify(text.trim())}`);
}

// ls-remote patterns match a ref's tail, so `main` alone would also match `refs/heads/feature/main`;
// only fully qualified names are asked for, tags before branches as `git rev-parse` orders them.
function refCandidates(ref: string): string[] {
  if (ref === DEFAULT_GITHUB_REF || ref.startsWith("refs/")) return [ref];
  return [`refs/tags/${ref}`, `refs/heads/${ref}`];
}

// An annotated tag lists twice: the tag object under its name and the commit under `<name>^{}`.
// The peeled line is what a pin must record, so it wins whenever present.
function parseLsRemote(text: string, ref: string, candidates: string[]): RungOutcome<string> {
  const rows = new Map<string, string>();
  for (const line of text.split("\n")) {
    const [sha, name] = line.split("\t");
    if (sha !== undefined && name !== undefined) rows.set(name, sha);
  }
  for (const name of candidates) {
    const sha = rows.get(`${name}^{}`) ?? rows.get(name);
    if (sha !== undefined) return parseSha(sha);
  }
  return failed("missing", `ref ${ref} does not exist on the remote`);
}

// Patterns are tried top to bottom, so a 403 that mentions the rate limit is a rate limit before it
// is an auth failure, and a "not found" from git is a missing repo before it is a network fault.
const GH_PATTERNS: [FetchFailureKind, RegExp][] = [
  ["ratelimit", /rate limit/i],
  ["missing", /HTTP 404|No commit found for SHA/i],
  ["auth", /HTTP 40[13]/],
  ["network", /no such host|dial tcp|timed? ?out|connection refused|network is unreachable/i],
  ["network", /TLS handshake|could not resolve|connection reset|broken pipe|\bEOF\b/i],
  ["network", /context deadline exceeded|server misbehaving|error connecting to/i],
];

const GIT_PATTERNS: [FetchFailureKind, RegExp][] = [
  ["ratelimit", /returned error: 429|rate limit/i],
  ["missing", /repository not found|not found|does not appear to be a git repository/i],
  ["missing", /couldn't find remote ref|remote branch .* not found/i],
  ["auth", /authentication failed|could not read username|permission denied/i],
  ["auth", /invalid username or|error: 40[13]|unable to get password from user/i],
  ["network", /could not resolve host|unable to access|connection (refused|timed out|reset)/i],
  ["network", /network is unreachable|could not read from remote repository|timed out/i],
  ["network", /block timeout reached/i],
  ["network", /failed to connect|ssl|tls/i],
];

export function classifyGh(stderr: string): FetchFailureKind {
  return classifyText(GH_PATTERNS, stderr);
}

export function classifyGit(message: string): FetchFailureKind {
  return classifyText(GIT_PATTERNS, message);
}

function classifyText(patterns: [FetchFailureKind, RegExp][], text: string): FetchFailureKind {
  return patterns.find(([, pattern]) => pattern.test(text))?.[0] ?? "invalid";
}

// GitHub signals a primary rate limit as 403 with `x-ratelimit-remaining: 0` and a secondary one
// with `Retry-After`; both are recorded for the staleness notice and neither is ever slept on. A 422
// from the commits endpoint is "No commit found for SHA", so it is a missing ref, not bad input.
export function classifyResponse(response: Response): {
  kind: FetchFailureKind;
  retryAfterSeconds?: number;
} {
  const status = response.status;
  const retryAfter = response.headers.get("retry-after");
  const remaining = response.headers.get("x-ratelimit-remaining");
  if (status === 429 || (status === 403 && (retryAfter !== null || remaining === "0"))) {
    return {
      kind: "ratelimit",
      retryAfterSeconds: retryAfterSeconds(retryAfter, response.headers.get("x-ratelimit-reset")),
    };
  }
  if (status === 404 || status === 422) return { kind: "missing" };
  if (status === 401 || status === 403) return { kind: "auth" };
  return { kind: "invalid" };
}

function retryAfterSeconds(retryAfter: string | null, reset: string | null): number | undefined {
  if (retryAfter !== null) {
    if (/^\d+$/.test(retryAfter.trim())) return Number(retryAfter.trim());
    const at = Date.parse(retryAfter);
    if (!Number.isNaN(at)) return Math.max(0, Math.ceil((at - Date.now()) / 1000));
  }
  if (reset !== null && /^\d+$/.test(reset.trim())) {
    return Math.max(0, Number(reset.trim()) - Math.floor(Date.now() / 1000));
  }
  return undefined;
}

function firstLine(text: string): string {
  return (
    text
      .split(/\r?\n/)
      .find((line) => line.trim() !== "")
      ?.trim() ?? "(no output)"
  );
}

// Everything a child could use to open a prompt, a pager, or an editor is dropped from its
// environment: a hook runs with no terminal to answer, and simple-git refuses such variables anyway.
// The repository-selection variables go too, or a `GIT_DIR` inherited from a git hook would point
// the clone rung's init and checkout at the caller's own repository instead of the temp dir.
const SCRUBBED_ENV: ReadonlySet<string> = new Set([
  "EDITOR",
  "VISUAL",
  "PAGER",
  "GIT_EDITOR",
  "GIT_SEQUENCE_EDITOR",
  "GIT_PAGER",
  "GIT_ASKPASS",
  "SSH_ASKPASS",
  "GIT_SSH",
  "GIT_SSH_COMMAND",
  "GIT_PROXY_COMMAND",
  "GIT_TEMPLATE_DIR",
  "GIT_EXTERNAL_DIFF",
  "GIT_DIR",
  "GIT_WORK_TREE",
  "GIT_INDEX_FILE",
  "GIT_OBJECT_DIRECTORY",
  "GIT_ALTERNATE_OBJECT_DIRECTORIES",
  "GIT_COMMON_DIR",
  "GIT_NAMESPACE",
  "GIT_PREFIX",
]);

export function childEnvironment(base: NodeJS.ProcessEnv = process.env): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(base)) {
    if (value !== undefined && !SCRUBBED_ENV.has(key.toUpperCase())) env[key] = value;
  }
  return {
    ...env,
    GIT_TERMINAL_PROMPT: "0",
    GCM_INTERACTIVE: "never",
    GH_PROMPT_DISABLED: "1",
    GH_NO_UPDATE_NOTIFIER: "1",
    NO_COLOR: "1",
  };
}

const execFileAsync = promisify(execFile);

export function systemRunner(): Runner {
  return {
    exec: async (binary, args) => {
      try {
        const { stdout, stderr } = await execFileAsync(binary, args, {
          encoding: "buffer",
          env: childEnvironment(),
          maxBuffer: EXEC_MAX_BYTES,
          timeout: EXEC_TIMEOUT_MS,
        });
        return { kind: "exited", code: 0, stdout, stderr: stderr.toString("utf8") };
      } catch (cause) {
        return execFailure(binary, cause);
      }
    },
    fetch: (url, init) => fetch(url, init),
    git: simpleGitRunner(),
  };
}

type ExecError = Error & {
  code?: string | number | null;
  killed?: boolean;
  stdout?: Buffer;
  stderr?: Buffer;
};

function execFailure(binary: string, cause: unknown): ExecResult {
  const error = cause as ExecError;
  if (error.code === "ENOENT") return { kind: "absent" };
  const stderr = error.stderr?.toString("utf8") ?? "";
  if (error.killed === true) {
    return { kind: "exited", code: -1, stdout: new Uint8Array(), stderr: `${binary} timed out` };
  }
  const code = typeof error.code === "number" ? error.code : 1;
  return {
    kind: "exited",
    code,
    stdout: error.stdout ?? new Uint8Array(),
    stderr: stderr || error.message,
  };
}

// `--filter=blob:none` keeps the fetch to one tree; the checkout then prefetches the missing blobs
// in a single round trip. A `core.askPass` from the user's own gitconfig would still open a prompt
// with the environment scrubbed, so it is emptied per command; the inherited config-path variables
// and that constant are allowed through simple-git's unsafe plugin because both are the caller's own.
export function simpleGitRunner(binary = "git"): GitRunner {
  const env = childEnvironment();
  const client = (baseDir?: string): SimpleGit =>
    simpleGit({
      ...(baseDir === undefined ? {} : { baseDir }),
      binary,
      config: ["core.askPass=", "credential.interactive=false"],
      timeout: { block: EXEC_TIMEOUT_MS },
      unsafe: {
        allowUnsafeConfigPaths: true,
        allowUnsafeConfigEnvCount: true,
        allowUnsafeAskPass: true,
      },
    }).env(env);
  return {
    lsRemote: (url, patterns) => gitAttempt(binary, () => client().listRemote([url, ...patterns])),
    shallowClone: (url, ref, dir) =>
      gitAttempt(binary, async () => {
        await mkdir(dir, { recursive: true });
        const git = client(dir);
        await git.raw(["init", "--quiet"]);
        await git.raw(["remote", "add", "origin", url]);
        await git.raw(["fetch", "--quiet", "--depth", "1", "--filter=blob:none", "origin", ref]);
        await git.raw(["checkout", "--quiet", "--detach", "FETCH_HEAD"]);
        return (await git.revparse(["HEAD"])).trim();
      }),
  };
}

// A missing executable surfaces as the spawn failure naming the binary; an ENOENT anywhere else in
// git's own output (a repository path, a remote URL) is a failure of the command, not an absent git.
async function gitAttempt(
  binary: string,
  action: () => Promise<string>,
): Promise<GitOutcome<string>> {
  try {
    return { kind: "ok", value: await action() };
  } catch (cause) {
    const message = cause instanceof Error ? cause.message : String(cause);
    const escaped = binary.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const spawnFailed = new RegExp(`spawn ${escaped} ENOENT|posix_spawn '${escaped}'`);
    if (spawnFailed.test(message)) return { kind: "absent" };
    return { kind: "failed", message };
  }
}
