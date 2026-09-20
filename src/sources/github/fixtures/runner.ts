import type {
  ExecResult,
  GitCallOptions,
  GitCloneOptions,
  GitOutcome,
  GitRunner,
  Runner,
} from "../ladder.ts";

export type ScriptedRunnerOptions = {
  exec?: (binary: string, args: string[]) => ExecResult | Promise<ExecResult>;
  fetch?: (url: string, init: RequestInit) => Response | Promise<Response>;
  git?: GitRunner;
};

export type ScriptedRunner = Runner & { calls: string[] };

// Every operation is absent or offline unless the test scripts it, so a rung the test did not
// mean to reach shows up in `calls` rather than touching the network.
export function scriptedRunner(options: ScriptedRunnerOptions = {}): ScriptedRunner {
  const calls: string[] = [];
  const git = options.git ?? absentGit();
  return {
    calls,
    exec: async (binary, args) => {
      calls.push(`exec ${binary} ${args.join(" ")}`);
      return options.exec === undefined ? ABSENT : options.exec(binary, args);
    },
    fetch: async (url, init) => {
      calls.push(`fetch ${url}`);
      if (options.fetch === undefined) throw networkError();
      return options.fetch(url, init);
    },
    git: {
      lsRemote: (url, patterns, options) => {
        calls.push(`git ls-remote ${url} ${patterns.join(" ")}${describe(options)}`);
        return git.lsRemote(url, patterns, options);
      },
      shallowClone: (url, ref, dir, options) => {
        calls.push(`git clone ${url} ${ref}${describe(options)}`);
        return git.shallowClone(url, ref, dir, options);
      },
    },
  };
}

function describe(options: GitCloneOptions): string {
  const creds = options.credentials;
  const parts: string[] = [
    creds.kind === "header" ? `header=${creds.header}` : `creds=${creds.kind}`,
  ];
  if (options.sparsePath !== undefined) parts.push(`sparse=${options.sparsePath}`);
  return ` [${parts.join(" ")}]`;
}

export const ABSENT: ExecResult = { kind: "absent" };

export function exited(code: number, stdout: string | Uint8Array = "", stderr = ""): ExecResult {
  const bytes = typeof stdout === "string" ? new TextEncoder().encode(stdout) : stdout;
  return { kind: "exited", code, stdout: bytes, stderr };
}

// `gh auth status` answers before any `gh api` call; scripting both at once keeps a test from
// having to know the order the ladder asks in.
export function ghScript(
  onApi: (args: string[]) => ExecResult,
  authenticated = true,
): (binary: string, args: string[]) => ExecResult {
  return (binary, args) => {
    if (binary !== "gh") return ABSENT;
    if (args[0] === "auth")
      return exited(authenticated ? 0 : 1, "", authenticated ? "" : "not logged in");
    return onApi(args);
  };
}

export function httpResponse(
  status: number,
  body: string | Uint8Array = "",
  headers: Record<string, string> = {},
): Response {
  return new Response(typeof body === "string" ? body : new Uint8Array(body), { status, headers });
}

export function networkError(): Error {
  return new TypeError("fetch failed: getaddrinfo ENOTFOUND api.github.com");
}

export function absentGit(): GitRunner {
  return {
    lsRemote: async () => ({ kind: "absent" }),
    shallowClone: async () => ({ kind: "absent" }),
  };
}

export function scriptedGit(script: {
  lsRemote?: (url: string, patterns: string[], options: GitCallOptions) => GitOutcome<string>;
  shallowClone?: (
    url: string,
    ref: string,
    dir: string,
    options: GitCloneOptions,
  ) => GitOutcome<string> | Promise<GitOutcome<string>>;
}): GitRunner {
  const absent = absentGit();
  return {
    lsRemote: async (url, patterns, options) =>
      script.lsRemote === undefined
        ? absent.lsRemote(url, patterns, options)
        : script.lsRemote(url, patterns, options),
    shallowClone: async (url, ref, dir, options) =>
      script.shallowClone === undefined
        ? absent.shallowClone(url, ref, dir, options)
        : script.shallowClone(url, ref, dir, options),
  };
}

// A 200 whose body dies mid-stream, the shape of a connection dropped after the headers arrived.
export function brokenBodyResponse(): Response {
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.error(new TypeError("terminated"));
    },
  });
  return new Response(body, { status: 200 });
}
