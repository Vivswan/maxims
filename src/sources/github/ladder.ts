import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import debug from "debug";
import { type SimpleGit, type SimpleGitOptions, simpleGit } from "simple-git";
import { DEFAULT_GIT_REF, type LastError } from "../../state/schema.ts";
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

// What identity a git call may carry. `none` clears the headers and credential helpers the user's
// own gitconfig would add for the URL, so an anonymous fetch is anonymous even on a machine that is
// logged in. `header` is one complete header line applied to that URL only, so an `insteadOf`
// rewrite to another host cannot carry it along; it is the only way a token reaches git, and it
// never appears in a URL or an argument. `sparsePath` undefined checks out the whole tree.
export type GitCredentials =
  | { kind: "none" }
  | { kind: "inherited" }
  | { kind: "header"; header: string };
export type GitCallOptions = { credentials: GitCredentials };
export type GitCloneOptions = GitCallOptions & { sparsePath?: string };

export interface GitRunner {
  lsRemote(url: string, patterns: string[], options: GitCallOptions): Promise<GitOutcome<string>>;
  shallowClone(
    url: string,
    ref: string,
    dir: string,
    options: GitCloneOptions,
  ): Promise<GitOutcome<string>>;
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
  archiveUrl(repo: RepoCoordinate, ref: string): string;
};

export const DEFAULT_GH_HOST = "github.com";
const TENANCY_SUFFIX = ".ghe.com";

// gh's host classes (go-gh pkg/auth IsTenancy, IsEnterprise): github.com and every ghe.com tenant
// share one class, every other host is an enterprise server.
function isDotcomClass(host: string): boolean {
  return host === DEFAULT_GH_HOST || host.endsWith(TENANCY_SUFFIX);
}

// gh's URL shapes (go-gh pkg/api restPrefix): the github.com class serves its API from an `api.`
// subdomain, an enterprise server under its own /api/v3. Archives come from codeload for github.com
// alone; a tenant has no documented archive host, so the REST tarball endpoint, which redirects to
// wherever the tenant stores them, is asked instead; an enterprise server serves them under the
// repository's own path.
export function endpointsFor(host: string): Endpoints {
  const ghHost = host.toLowerCase();
  const isDotCom = ghHost === DEFAULT_GH_HOST;
  const apiBase = isDotcomClass(ghHost) ? `https://api.${ghHost}` : `https://${ghHost}/api/v3`;
  return {
    ghHost,
    apiBase,
    gitUrl: ({ owner, repo }) => `https://${ghHost}/${owner}/${repo}.git`,
    archiveUrl: ({ owner, repo }, ref) => {
      const encoded = encodeURIComponent(ref);
      if (isDotCom) return `https://codeload.github.com/${owner}/${repo}/tar.gz/${encoded}`;
      if (isDotcomClass(ghHost)) return `${apiBase}/repos/${owner}/${repo}/tarball/${encoded}`;
      return `https://${ghHost}/${owner}/${repo}/archive/${encoded}.tar.gz`;
    },
  };
}

// `warn` carries what a person should hear about the fetched content (an entry skipped, a token
// not applied). `rung` carries which transport failed and why, a diagnostic for the caller to
// keep or drop; what the ladder finally throws is the one failure the engine records.
export type LadderOptions = {
  runner: Runner;
  endpoints: Endpoints;
  warn: WarnSink;
  rung: WarnSink;
  timeoutMs: number;
  token: string | undefined;
};

export type LadderRequest = { auth: boolean };
export type TreeRequest = LadderRequest & { sparsePath?: string };

// A sparse cone of the repository root would hold only its top-level files, so a memory path that
// names the root (".", "./", "") is the same request as a full checkout.
export function sparsePathFor(scope: {
  memoryPath: string;
  fullDepth: boolean;
}): string | undefined {
  if (scope.fullDepth) return undefined;
  const trimmed = scope.memoryPath.replace(/^(\.\/)+/, "").replace(/\/+$/, "");
  return trimmed === "" || trimmed === "." ? undefined : trimmed;
}

export interface Ladder {
  resolveRef(repo: RepoCoordinate, ref: string, request: LadderRequest): Promise<string>;
  fetchTree(
    repo: RepoCoordinate,
    sha: string,
    destDir: string,
    request: TreeRequest,
  ): Promise<void>;
}

export const DEFAULT_FETCH_TIMEOUT_SECONDS = 60;
const EXEC_MAX_BYTES = 256 * 1024 * 1024;
const FULL_SHA = /^[0-9a-f]{40}$/;

export function fetchTimeoutMs(env: NodeJS.ProcessEnv): number {
  const raw = env.MAXIMS_FETCH_TIMEOUT?.trim() ?? "";
  const seconds = /^\d+$/.test(raw) ? Number(raw) : DEFAULT_FETCH_TIMEOUT_SECONDS;
  return (seconds > 0 ? seconds : DEFAULT_FETCH_TIMEOUT_SECONDS) * 1000;
}

// gh's own names and precedence: GH_TOKEN and GITHUB_TOKEN authenticate the github.com class, the
// two ENTERPRISE names every other host. A token is offered only to the host class it was named
// for, so a github.com token never reaches an enterprise server and an enterprise token never
// reaches a tenant.
const DOTCOM_TOKEN_NAMES = ["GH_TOKEN", "GITHUB_TOKEN"];
const ENTERPRISE_TOKEN_NAMES = ["GH_ENTERPRISE_TOKEN", "GITHUB_ENTERPRISE_TOKEN"];

export function tokenFor(env: NodeJS.ProcessEnv, host: string): string | undefined {
  const names = isDotcomClass(host) ? DOTCOM_TOKEN_NAMES : ENTERPRISE_TOKEN_NAMES;
  for (const name of names) {
    const token = env[name]?.trim();
    if (token !== undefined && token !== "") return token;
  }
  return undefined;
}

export type RungOutcome<T> =
  | { kind: "ok"; value: T }
  | { kind: "skipped" }
  | { kind: "failed"; failure: FetchFailure };

// A `fallback` rung runs only when the rung before it could not be tried at all (its binary is
// absent) or failed for a reason a second transport can fix; a network failure is not one, so it
// stops the ladder rather than paying for a second request that will fail the same way.
export type Rung<T> = { run: () => Promise<RungOutcome<T>>; fallback?: boolean };

// Anonymous by default: without `auth` no gh command runs and no token leaves the process. The
// answer to `gh auth status` is remembered per ladder because a session's login state cannot change
// between two rungs, and every gh command names the host so an inherited GH_HOST cannot redirect it.
export function createLadder(options: LadderOptions): Ladder {
  const { runner, endpoints, warn, rung, timeoutMs } = options;
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
  const bearer = (request: LadderRequest): Record<string, string> =>
    request.auth && options.token !== undefined ? { Authorization: `Bearer ${options.token}` } : {};
  const gitOptions = (request: LadderRequest): GitCallOptions => {
    if (!request.auth) return { credentials: { kind: "none" } };
    if (options.token === undefined) return { credentials: { kind: "inherited" } };
    return {
      credentials: { kind: "header", header: `Authorization: Bearer ${options.token}` },
    };
  };
  const ghRung = <T>(
    args: string[],
    onSuccess: (stdout: Uint8Array) => RungOutcome<T> | Promise<RungOutcome<T>>,
  ): Rung<T> => ({
    run: async () => {
      if (!(await ghAvailable())) return { kind: "skipped" };
      return ghOutcome(await runner.exec("gh", ["api", ...host, ...args]), onSuccess);
    },
  });

  return {
    resolveRef: (repo, ref, request) =>
      climb(rung, [
        ...(request.auth
          ? [
              ghRung(
                [api(repo, "commits", ref), "--jq", ".sha"],
                (stdout): RungOutcome<string> => parseSha(new TextDecoder().decode(stdout)),
              ),
            ]
          : []),
        lsRemoteRung(runner, endpoints.gitUrl(repo), ref, gitOptions(request)),
        {
          fallback: true,
          run: async () => {
            const url = `${endpoints.apiBase}/${api(repo, "commits", ref)}`;
            const headers = { Accept: "application/vnd.github.sha", ...bearer(request) };
            const body = await http(runner, url, headers, timeoutMs);
            if (body.kind !== "ok") return body;
            return parseSha(new TextDecoder().decode(body.value));
          },
        },
      ]),
    fetchTree: (repo, sha, destDir, request) =>
      climb(rung, [
        ...(request.auth
          ? [ghRung([api(repo, "tarball", sha)], (stdout) => extract(stdout, destDir, warn))]
          : []),
        cloneRung(runner, endpoints.gitUrl(repo), sha, destDir, {
          ...gitOptions(request),
          sparsePath: request.sparsePath,
        }),
        {
          fallback: true,
          run: async () => {
            const url = endpoints.archiveUrl(repo, sha);
            const body = await http(runner, url, bearer(request), timeoutMs);
            if (body.kind !== "ok") return body;
            return extract(body.value, destDir, warn);
          },
        },
      ]),
  };
}

export function lsRemoteRung(
  runner: Runner,
  url: string,
  ref: string,
  options: GitCallOptions,
): Rung<string> {
  return {
    run: async () => {
      const candidates = refCandidates(ref);
      const patterns = candidates.flatMap((name) => [name, `${name}^{}`]);
      const result = await runner.git.lsRemote(url, patterns, options);
      return gitOutcome("git ls-remote", result, (text) => parseLsRemote(text, ref, candidates));
    },
  };
}

export function cloneRung(
  runner: Runner,
  url: string,
  sha: string,
  destDir: string,
  options: GitCloneOptions,
): Rung<undefined> {
  return {
    run: async () => {
      await emptyDir(destDir);
      const result = await runner.git.shallowClone(url, sha, destDir, options);
      return gitOutcome("git clone", result, (head) =>
        head === sha
          ? { kind: "ok", value: undefined }
          : failed("invalid", `git clone checked out ${head}, expected ${sha}`),
      );
    },
  };
}

// The most actionable failure wins when every rung fails: a rate limit or a login problem tells
// the user what to do, while a network error is the one everything else degrades into.
const FAILURE_PRIORITY: FetchFailureKind[] = ["ratelimit", "auth", "missing", "invalid", "network"];

// A rung may only end in an outcome: whatever it throws instead is a failure of that rung, never
// the end of the ladder, because a hook that dies here loses the last-good store for nothing.
export async function climb<T>(rung: WarnSink, rungs: Rung<T>[]): Promise<T> {
  const failures: FetchFailure[] = [];
  let previous: RungOutcome<T> | undefined;
  for (const step of rungs) {
    if (step.fallback === true && previous !== undefined && !allowsFallback(previous)) continue;
    const outcome = await step
      .run()
      .catch(
        (cause: unknown): RungOutcome<T> =>
          failed("invalid", cause instanceof Error ? cause.message : String(cause)),
      );
    previous = outcome;
    if (outcome.kind === "ok") return outcome.value;
    if (outcome.kind === "skipped") continue;
    rung(outcome.failure.message);
    failures.push(outcome.failure);
  }
  const kind = FAILURE_PRIORITY.find((candidate) => failures.some((f) => f.kind === candidate));
  const matching = failures.filter((f) => f.kind === kind);
  const chosen = matching.find((f) => f.retryAfterSeconds !== undefined) ?? matching[0];
  throw chosen ?? new FetchFailure("invalid", "no fetch method is available on this machine");
}

function allowsFallback<T>(previous: RungOutcome<T>): boolean {
  return !(previous.kind === "failed" && previous.failure.kind === "network");
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
  result: ExecResult,
  onSuccess: (stdout: Uint8Array) => RungOutcome<T> | Promise<RungOutcome<T>>,
): RungOutcome<T> | Promise<RungOutcome<T>> {
  if (result.kind === "absent") return { kind: "skipped" };
  if (result.code !== 0)
    return failed(classifyGh(result.stderr), `gh api: ${firstLine(result.stderr)}`);
  return onSuccess(result.stdout);
}

function gitOutcome<T>(
  label: string,
  result: GitOutcome<string>,
  onSuccess: (value: string) => RungOutcome<T>,
): RungOutcome<T> {
  if (result.kind === "absent") return { kind: "skipped" };
  if (result.kind === "failed") {
    const line = redactUserinfo(firstLine(result.message));
    return failed(classifyGit(result.message), `${label}: ${line}`);
  }
  return onSuccess(result.value);
}

// Git anonymizes URLs in most of its own messages but not in all of them; a remote's `user:pass@`
// never belongs in a warning or a stored error.
export function redactUserinfo(text: string): string {
  return text.replace(/(\/\/)[^\s/@]+@/g, "$1");
}

// The body is read inside the same guard as the request: a connection that drops mid-body is a
// network failure like any other, not an exception that escapes the ladder.
async function http(
  runner: Runner,
  url: string,
  headers: Record<string, string>,
  timeoutMs: number,
): Promise<RungOutcome<Uint8Array>> {
  try {
    const response = await runner.fetch(url, {
      headers: { "User-Agent": "maxims", ...headers },
      redirect: "follow",
      signal: AbortSignal.timeout(timeoutMs),
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
  if (ref === DEFAULT_GIT_REF || ref.startsWith("refs/")) return [ref];
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
  ["network", /block timeout reached|failed to connect|ssl|tls/i],
  ["network", /early EOF|unexpected disconnect|remote end hung up|RPC failed|transfer closed/i],
  ["network", /index-pack failed|invalid index-pack output|recv failure|send failure/i],
  ["network", /empty reply from server/i],
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

// Every git tracing switch goes too: a trace line carries the full remote URL, password included,
// and git's stderr is what a failure message is made of.
const TRACE_ENV = /^(GIT_TRACE|GIT_CURL_VERBOSE)/i;

// LFS pointers stay pointers: a smudge would download every large file in a repo whose memories
// are a few kilobytes of text. GIT_ALLOW_PROTOCOL is the one protocol setting a user's gitconfig
// cannot override, so `ext::` and other command-running transports stay closed whatever it says.
export function childEnvironment(base: NodeJS.ProcessEnv = process.env): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(base)) {
    if (value === undefined || SCRUBBED_ENV.has(key.toUpperCase()) || TRACE_ENV.test(key)) continue;
    env[key] = value;
  }
  return {
    ...env,
    GIT_TERMINAL_PROMPT: "0",
    GIT_LFS_SKIP_SMUDGE: "1",
    GIT_ALLOW_PROTOCOL: "https:http:ssh:git:file",
    GCM_INTERACTIVE: "never",
    GH_PROMPT_DISABLED: "1",
    GH_NO_UPDATE_NOTIFIER: "1",
    NO_COLOR: "1",
  };
}

const execFileAsync = promisify(execFile);

export function systemRunner(env: NodeJS.ProcessEnv = process.env): Runner {
  const timeoutMs = fetchTimeoutMs(env);
  const childEnv = childEnvironment(env);
  return {
    exec: async (binary, args) => {
      try {
        const { stdout, stderr } = await execFileAsync(binary, args, {
          encoding: "buffer",
          env: childEnv,
          maxBuffer: EXEC_MAX_BYTES,
          timeout: timeoutMs,
          shell: false,
        });
        return { kind: "exited", code: 0, stdout, stderr: stderr.toString("utf8") };
      } catch (cause) {
        return execFailure(binary, cause);
      }
    },
    fetch: (url, init) => fetch(url, init),
    git: simpleGitRunner({ env: gitEnvironment(env), timeoutMs }),
  };
}

// What git alone gets, beyond the common scrub: no GitHub token, because git never reads one and
// simple-git would echo it to its debug log, and an ssh that fails instead of asking, because
// GIT_TERMINAL_PROMPT=0 says nothing to OpenSSH's own passphrase and host-key questions.
const TOKEN_ENV: ReadonlySet<string> = new Set([
  "GITHUB_TOKEN",
  "GH_TOKEN",
  "GH_ENTERPRISE_TOKEN",
  "GITHUB_ENTERPRISE_TOKEN",
]);

function shellQuote(word: string): string {
  return `'${word.replace(/'/g, `'\\''`)}'`;
}

export function gitEnvironment(base: NodeJS.ProcessEnv = process.env): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(childEnvironment(base))) {
    if (!TOKEN_ENV.has(key.toUpperCase())) env[key] = value;
  }
  return { ...env, GIT_SSH_COMMAND: batchSshCommand(base) };
}

// ssh honors the FIRST occurrence of an option, so BatchMode goes right after the program word of
// whatever ssh command the user configured, ahead of any option of theirs; a program path spelled
// with quotes is one word. A bare GIT_SSH is a literal program path, spaces and dollar signs and
// all, so it is single-quoted before it joins a command line the shell will split and expand.
function batchSshCommand(base: NodeJS.ProcessEnv): string {
  const program = base.GIT_SSH?.trim();
  const command =
    base.GIT_SSH_COMMAND?.trim() ||
    (program === undefined || program === "" ? "ssh" : shellQuote(program));
  const word = leadingShellWord(command);
  return `${word} -o BatchMode=yes${command.slice(word.length)}`;
}

// The first word of a POSIX command line: quotes of either kind and backslash escapes glue pieces
// together, and the word ends at the first unquoted whitespace.
function leadingShellWord(command: string): string {
  let quote: string | null = null;
  for (let index = 0; index < command.length; index += 1) {
    const char = command[index] ?? "";
    if (quote === null) {
      if (/\s/.test(char)) return command.slice(0, index);
      if (char === "'" || char === '"') quote = char;
      else if (char === "\\") index += 1;
    } else if (char === quote) {
      quote = null;
    } else if (quote === '"' && char === "\\") {
      index += 1;
    }
  }
  return command;
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

export type GitRunnerOptions = {
  binary?: string;
  env?: Record<string, string>;
  timeoutMs?: number;
};

// `protocol.allow=never` closes `ext::` and any other transport that runs a command named in a
// URL; the listed ones are re-opened one by one. A `core.askPass` from the user's own gitconfig
// would still open a prompt with the environment scrubbed, so it is emptied per command. The
// inherited config-path variables and these constants pass simple-git's unsafe plugin because
// they are the caller's own, not values read from a source.
const GIT_CONFIG = [
  "core.askPass=",
  "credential.interactive=false",
  "protocol.allow=never",
  "protocol.https.allow=always",
  "protocol.http.allow=always",
  "protocol.ssh.allow=always",
  "protocol.git.allow=always",
  "protocol.file.allow=always",
];

// A sparse cone of `sparsePath` is declared before the checkout, so the checkout's one blob
// prefetch pulls only the memory folder; `--filter=blob:none` keeps the fetch itself to one tree.
// simple-git's debug channel is switched off for the whole process: under `DEBUG=simple-git:*` it
// prints every spawn's arguments and environment, which is where a remote URL's password or an
// inherited token would appear.
export function simpleGitRunner(options: GitRunnerOptions = {}): GitRunner {
  debug.disable();
  const binary = options.binary ?? "git";
  const env = options.env ?? gitEnvironment();
  const timeoutMs = options.timeoutMs ?? DEFAULT_FETCH_TIMEOUT_SECONDS * 1000;
  const client = (config: string[], baseDir?: string, callEnv = env): SimpleGit => {
    const settings: Partial<SimpleGitOptions> = {
      binary,
      config: [...GIT_CONFIG, ...config],
      timeout: { block: timeoutMs },
      unsafe: {
        allowUnsafeConfigPaths: true,
        allowUnsafeConfigEnvCount: true,
        allowUnsafeAskPass: true,
        allowUnsafeProtocolOverride: true,
        allowUnsafeSshCommand: true,
      },
    };
    if (baseDir !== undefined) settings.baseDir = baseDir;
    return simpleGit(settings).env(callEnv);
  };
  // An anonymous call hands git the URL it would have reached anyway, minus any `user:password@`
  // the user's `insteadOf` rule wrote into it: git would send those as Basic auth after a 401.
  const target = async (url: string, credentials: GitCredentials): Promise<string> =>
    credentials.kind === "none" ? withoutUserinfo(await effectiveUrl(client([]), url)) : url;
  return {
    lsRemote: (url, patterns, call) =>
      gitAttempt(binary, async () => {
        const remote = await target(url, call.credentials);
        return withCredentials(url, remote, call.credentials, env, (config, callEnv) =>
          client(config, undefined, callEnv).listRemote([remote, ...patterns]),
        );
      }),
    shallowClone: (url, ref, dir, call) =>
      gitAttempt(binary, async () => {
        const remote = await target(url, call.credentials);
        return withCredentials(url, remote, call.credentials, env, async (config, callEnv) => {
          await mkdir(dir, { recursive: true });
          const git = client(config, dir, callEnv);
          await git.raw(["init", "--quiet"]);
          await git.raw(["remote", "add", "origin", remote]);
          await git.raw(["fetch", "--quiet", "--depth", "1", "--filter=blob:none", "origin", ref]);
          if (call.sparsePath !== undefined) {
            await git.raw(["sparse-checkout", "set", "--cone", "--", call.sparsePath]);
          }
          await git.raw(["checkout", "--quiet", "--detach", "FETCH_HEAD"]);
          return (await git.revparse(["HEAD"])).trim();
        });
      }),
  };
}

// Only http(s) carries credentials in its URL that git would replay; an ssh user is the login the
// transport needs, and an scp-like remote is not a URL at all.
function withoutUserinfo(url: string): string {
  if (!/^https?:\/\//i.test(url)) return url;
  try {
    const parsed = new URL(url);
    parsed.username = "";
    parsed.password = "";
    return parsed.toString();
  } catch {
    return url;
  }
}

// The user's `insteadOf` rules may send a URL somewhere else entirely; an anonymous call resolves
// that destination itself and resets its credentials too, so what the user configured for the
// mirror does not leave on a fetch they asked to be anonymous. A token stays with the URL it was
// given, and the rewrite, if any, is git's to apply.
async function effectiveUrl(git: SimpleGit, url: string): Promise<string> {
  const expanded = (await git.raw(["ls-remote", "--get-url", url])).trim();
  return expanded === "" ? url : expanded;
}

// Credentials reach git through a private include file, never an argument or the environment:
// simple-git echoes both to its debug log. The file scopes its entries to the exact URL, which is
// the longest match git can find, so it outranks any `http.<prefix>.extraheader` or
// `credential.<prefix>.helper` the user's gitconfig carries; an empty value resets that list. The
// scope also means a URL rewritten by the user's own `insteadOf` no longer matches, and the
// header stays home. An anonymous call also pins its destination with an `insteadOf` of the exact
// URL onto itself: the longest matching rule wins, so a shorter user rule that would write
// credentials back into the URL is not applied a second time. And it runs in a private HOME,
// because libcurl answers a 401 from `~/.netrc` on its own, outside every git setting.
async function withCredentials<T>(
  url: string,
  remote: string,
  credentials: GitCredentials,
  env: Record<string, string>,
  action: (config: string[], env: Record<string, string>) => Promise<T>,
): Promise<T> {
  if (credentials.kind === "inherited") return action([], env);
  const dir = await mkdtemp(join(tmpdir(), "maxims-git-"));
  try {
    const file = join(dir, "config");
    await writeFile(file, credentialConfig(url, remote, credentials), { mode: 0o600 });
    const callEnv = credentials.kind === "none" ? await privateHome(env, join(dir, "home")) : env;
    return await action([`include.path=${file}`], callEnv);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

export function credentialConfig(
  url: string,
  remote: string,
  credentials: Exclude<GitCredentials, { kind: "inherited" }>,
): string {
  const lines = [...new Set([url, remote])].flatMap((scope) => [
    `[http ${gitConfigString(scope)}]`,
    "\textraheader =",
    ...(credentials.kind === "header" ? [`\textraheader = ${credentials.header}`] : []),
    `[credential ${gitConfigString(scope)}]`,
    "\thelper =",
  ]);
  if (credentials.kind === "none") {
    lines.push(`[url ${gitConfigString(remote)}]`, `\tinsteadOf = ${gitConfigString(remote)}`);
  }
  lines.push("");
  return lines.join("\n");
}

// Quoting is what lets a remote carry a backslash or a quote: unquoted, a backslash starts an
// escape git may not know (the `\r` of a Windows path) and the whole file is refused, and `#` or
// `;` would start a comment. Backslash and double quote are the escapes a subsection name and a
// quoted value both need.
function gitConfigString(value: string): string {
  return `"${value.replace(/[\\"]/g, "\\$&")}"`;
}

// HOME is libcurl's only pointer to `.netrc`, and also git's for `~/.gitconfig`, `~/.config`, every
// `~`-relative path in them, and ssh's for `~/.ssh`. The private HOME mirrors the real one entry by
// entry through symlinks, minus the netrc files, so all of those keep resolving. A HOME that cannot
// be mirrored fails the call outright: proceeding without the user's proxy or CA settings would
// only surface later as a network error that points nowhere.
async function privateHome(
  env: Record<string, string>,
  home: string,
): Promise<Record<string, string>> {
  await mkdir(home, { recursive: true });
  const realHome = env.HOME ?? homedir();
  for (const name of await readdir(realHome)) {
    if (NETRC_FILES.has(name.toLowerCase())) continue;
    await symlink(join(realHome, name), join(home, name));
  }
  return { ...env, HOME: home, USERPROFILE: home };
}

const NETRC_FILES: ReadonlySet<string> = new Set([".netrc", "_netrc"]);

async function gitAttempt(
  binary: string,
  action: () => Promise<string>,
): Promise<GitOutcome<string>> {
  try {
    return { kind: "ok", value: await action() };
  } catch (cause) {
    const message = cause instanceof Error ? cause.message : String(cause);
    if (isAbsentBinary(binary, message)) return { kind: "absent" };
    return { kind: "failed", message };
  }
}

// A missing executable surfaces as the runtime's spawn failure naming the binary, which simple-git
// hands over as the error's `Error:` line followed by its stack. Only that first line is matched,
// and only whole, so an ENOENT or a spawn-like phrase inside git's own output (a repository path,
// a remote URL, even one carrying a newline) stays a failure of the command, not an absent git.
//   node                     spawn <binary> ENOENT
//   bun, path given          ENOENT: no such file or directory, posix_spawn '<binary>'
//                            (uv_spawn on Windows)
//   bun, bare name off PATH  Executable not found in $PATH: "<binary>"
export function isAbsentBinary(binary: string, message: string): boolean {
  const escaped = binary.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const spellings = [
    `spawn ${escaped} ENOENT`,
    `ENOENT: no such file or directory, (posix|uv)_spawn '${escaped}'`,
    `Executable not found in \\$PATH: "${escaped}"`,
  ];
  return new RegExp(`^(Error: )?(${spellings.join("|")})(\n|$)`).test(message);
}
