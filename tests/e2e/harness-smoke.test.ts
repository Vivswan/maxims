// Fails if an installed harness CLI stops running the session-start hook maxims registered, stops
// loading the rule file maxims wrote where maxims wrote it, or drifts in the redirect, dummy-auth
// or headless knobs the container tier relies on, and if the built bundle stops running its
// install and sync verbs under node. The real rows run only inside the container
// tier (the image sets MAXIMS_CONTAINER_TIER=1); locally they skip by name, and a stub CLI that
// speaks the Claude Code shape proves the smoke's own logic, including its two failure findings.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { type BuiltInHarnessId, HOOK_COMMAND } from "../../src/harnesses/contract.ts";
import { REPO_ROOT } from "../container/runner.ts";
import { CONTAINER_TIER_ENV, inContainerTier } from "../container/tier.ts";
import { type CapturedRequest, startFakeLlm, type Wire, wireFor } from "./fake-llm.ts";

const PROMPT = "Reply with the single word ok.";
const FAKE_TOKEN = "fake-token";
// Cold starts inside the container take a few seconds each; the deadline kill is what turns a CLI
// waiting on a prompt into a named failure instead of a hung suite.
const CLI_DEADLINE_MS = 90_000;
const ROW_TIMEOUT_MS = 150_000;
// After the deadline kill, how long the output pipes get to close before the run is reported
// without them: a hook child outside the killed group could otherwise hold them open.
const KILL_GRACE_MS = 5_000;
const TAIL_CHARS = 800;

type Row = {
  name: string;
  command: readonly string[];
  harness: BuiltInHarnessId;
  wire: Wire;
  // The header whose presence proves the dummy credential reached the wire; its value is never
  // asserted.
  authHeader: string;
  argv: (prompt: string) => string[];
  env: (home: string, baseUrl: string) => Record<string, string>;
  files?: (baseUrl: string) => Record<string, string>;
  succeeded: (stdout: string) => boolean;
};

function jsonLines(stdout: string): Record<string, unknown>[] {
  const lines: Record<string, unknown>[] = [];
  for (const line of stdout.split(/\r?\n/)) {
    if (!line.startsWith("{")) continue;
    try {
      const parsed: unknown = JSON.parse(line);
      if (typeof parsed === "object" && parsed !== null) {
        lines.push(parsed as Record<string, unknown>);
      }
    } catch {
      // stdout may interleave non-JSON lines
    }
  }
  return lines;
}

function wholeJson(stdout: string): Record<string, unknown> | null {
  try {
    const parsed: unknown = JSON.parse(stdout);
    return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

const CLAUDE: Row = {
  name: "claude",
  command: ["claude"],
  harness: "claude-code",
  wire: "anthropic-messages",
  authHeader: "authorization",
  argv: (prompt) => [
    "-p",
    "--model",
    "claude-haiku-4-5",
    "--permission-mode",
    "plan",
    "--output-format",
    "json",
    prompt,
  ],
  env: (_home, baseUrl) => ({
    ANTHROPIC_BASE_URL: baseUrl,
    ANTHROPIC_AUTH_TOKEN: FAKE_TOKEN,
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
    DISABLE_TELEMETRY: "1",
    DISABLE_AUTOUPDATER: "1",
    DISABLE_ERROR_REPORTING: "1",
  }),
  succeeded: (stdout) => wholeJson(stdout)?.subtype === "success",
};

const CODEX: Row = {
  name: "codex",
  command: ["codex"],
  harness: "codex",
  wire: "openai-responses",
  authHeader: "authorization",
  argv: (prompt) => [
    "exec",
    "--json",
    "--skip-git-repo-check",
    "--sandbox",
    "read-only",
    "--dangerously-bypass-hook-trust",
    prompt,
  ],
  env: (home) => ({ CODEX_HOME: join(home, ".codex") }),
  files: (baseUrl) => ({
    ".codex/config.toml": [
      'model = "gpt-5.4"',
      'model_provider = "fake"',
      "check_for_update_on_startup = false",
      "",
      "[model_providers.fake]",
      'name = "fake"',
      `base_url = "${baseUrl}/v1"`,
      'wire_api = "responses"',
      "requires_openai_auth = false",
      `http_headers = { Authorization = "Bearer ${FAKE_TOKEN}" }`,
      "",
    ].join("\n"),
  }),
  succeeded: (stdout) => jsonLines(stdout).some((line) => line.type === "turn.completed"),
};

const GEMINI: Row = {
  name: "gemini",
  command: ["gemini"],
  harness: "gemini-cli",
  wire: "gemini",
  authHeader: "x-goog-api-key",
  argv: (prompt) => ["-p", prompt, "--output-format", "json"],
  env: (_home, baseUrl) => ({
    GEMINI_CLI_TRUST_WORKSPACE: "true",
    GOOGLE_GEMINI_BASE_URL: baseUrl,
    GEMINI_API_KEY: FAKE_TOKEN,
  }),
  files: () => ({
    ".gemini/settings.json": `${JSON.stringify(
      {
        general: { enableAutoUpdate: false },
        privacy: { usageStatisticsEnabled: false },
        security: { auth: { selectedType: "gemini-api-key" } },
      },
      null,
      2,
    )}\n`,
  }),
  succeeded: (stdout) => typeof wholeJson(stdout)?.response === "string",
};

const COPILOT: Row = {
  name: "copilot",
  command: ["copilot"],
  harness: "copilot",
  wire: "openai-chat",
  authHeader: "authorization",
  argv: (prompt) => ["-p", prompt, "-s", "--output-format", "json"],
  env: (home, baseUrl) => ({
    COPILOT_HOME: join(home, ".copilot"),
    COPILOT_OFFLINE: "true",
    COPILOT_PROVIDER_BASE_URL: `${baseUrl}/v1`,
    COPILOT_PROVIDER_TYPE: "openai",
    COPILOT_PROVIDER_API_KEY: FAKE_TOKEN,
    COPILOT_MODEL: "gpt-5.4",
    COPILOT_AUTO_UPDATE: "false",
    COPILOT_ALLOW_ALL: "true",
  }),
  succeeded: (stdout) => jsonLines(stdout).some((line) => line.type === "result"),
};

const OPENCODE: Row = {
  name: "opencode",
  command: ["opencode"],
  harness: "opencode",
  wire: "openai-chat",
  authHeader: "authorization",
  argv: (prompt) => ["run", "--format", "json", prompt],
  env: (home) => ({
    XDG_CONFIG_HOME: join(home, ".config"),
    XDG_DATA_HOME: join(home, ".local", "share"),
    XDG_CACHE_HOME: join(home, ".cache"),
    XDG_STATE_HOME: join(home, ".local", "state"),
    OPENCODE_DISABLE_AUTOUPDATE: "1",
  }),
  files: (baseUrl) => ({
    ".config/opencode/opencode.json": `${JSON.stringify(
      {
        $schema: "https://opencode.ai/config.json",
        autoupdate: false,
        share: "disabled",
        model: "fake/gpt-5.4",
        provider: {
          fake: {
            npm: "@ai-sdk/openai-compatible",
            name: "Fake",
            options: { baseURL: `${baseUrl}/v1`, apiKey: FAKE_TOKEN },
            models: { "gpt-5.4": { name: "gpt-5.4", limit: { context: 128_000, output: 16_000 } } },
          },
        },
      },
      null,
      2,
    )}\n`,
  }),
  succeeded: (stdout) =>
    jsonLines(stdout).some((line) => {
      const part = line.part;
      return (
        line.type === "step_finish" &&
        typeof part === "object" &&
        part !== null &&
        (part as Record<string, unknown>).reason === "stop"
      );
    }),
};

const REAL_ROWS: readonly Row[] = [CLAUDE, CODEX, GEMINI, COPILOT, OPENCODE];

// A harness stand-in in the Claude Code shape: it runs the SessionStart hooks from the settings
// file maxims writes, loads the rules directory maxims writes, and sends both to the Anthropic
// route. MAXIMS_STUB_WITHHOLD names the step it skips, so each smoke finding can be seen red.
const STUB_SOURCE = `
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
const home = process.env.HOME ?? "";
const withhold = process.env.MAXIMS_STUB_WITHHOLD ?? "";
const prompt = process.argv.at(-1) ?? "";
if (withhold !== "hooks") {
  const settings = JSON.parse(readFileSync(join(home, ".claude", "settings.json"), "utf8"));
  const payload = JSON.stringify({
    session_id: "stub",
    transcript_path: join(home, "transcript.jsonl"),
    cwd: process.cwd(),
    hook_event_name: "SessionStart",
    source: "startup",
    prompt_id: "stub",
  });
  for (const group of settings.hooks?.SessionStart ?? []) {
    for (const hook of group.hooks ?? []) {
      if (hook.type !== "command") continue;
      Bun.spawnSync(["sh", "-c", hook.command], {
        stdin: new TextEncoder().encode(payload),
        stdout: "ignore",
        stderr: "inherit",
      });
    }
  }
}
let reminder = "";
if (withhold !== "rules") {
  const dir = join(home, ".claude", "rules");
  for (const name of readdirSync(dir).sort()) {
    const text = readFileSync(join(dir, name), "utf8");
    reminder += "Contents of " + join(dir, name) + ":\\n" + text + "\\n";
  }
}
const response = await fetch(process.env.ANTHROPIC_BASE_URL + "/v1/messages?beta=true", {
  method: "POST",
  headers: {
    "content-type": "application/json",
    authorization: "Bearer " + process.env.ANTHROPIC_AUTH_TOKEN,
    "anthropic-version": "2023-06-01",
  },
  body: JSON.stringify({
    model: "claude-haiku-4-5",
    max_tokens: 64,
    stream: true,
    system: [{ type: "text", text: "You are a stub." }],
    messages: [
      {
        role: "user",
        content: [
          { type: "text", text: "<system-reminder>\\n" + reminder + "</system-reminder>" },
          { type: "text", text: prompt },
        ],
      },
    ],
  }),
});
const stream = await response.text();
if (response.status !== 200 || !stream.includes("event: message_stop")) {
  process.stderr.write("the model stream did not end with message_stop\\n");
  process.exit(1);
}
process.stdout.write(JSON.stringify({ type: "result", subtype: "success", result: "ok" }) + "\\n");
`;

type Verdict = { ok: true } | { ok: false; problems: string[] };
const PASSED: Verdict = { ok: true };

// The CLI under test is the published artifact: the bundle scripts/build.ts produces, run by node
// as `npx` runs it, both for the install and behind the shim. A defect only the bundle has (a
// dependency entry that resolves at build time and not at load) therefore fails the smoke too.
type Scratch = { root: string; stub: string; entry: readonly string[] };
let scratch: Scratch | null = null;

function ready(): Scratch {
  if (scratch === null) throw new Error("the smoke's setup did not run");
  return scratch;
}

beforeAll(() => {
  const launcherHome = process.env.HOME;
  if (launcherHome === undefined) throw new Error("the test launcher must set HOME");
  const node = Bun.which("node");
  if (node === null) throw new Error("node is required: the published bundle targets node");
  const root = mkdtempSync(join(launcherHome, "maxims-smoke-"));
  try {
    const bundle = join(root, "cli.js");
    const build = Bun.spawnSync(
      [
        process.execPath,
        join(REPO_ROOT, "scripts", "build.ts"),
        "--outfile",
        bundle,
        "--size-json",
        join(root, "size.json"),
      ],
      { cwd: REPO_ROOT, stdout: "pipe", stderr: "pipe" },
    );
    if (build.exitCode !== 0) {
      throw new Error(`bundle build failed: ${build.stderr.toString()}${build.stdout.toString()}`);
    }
    // The published package declares its module type beside the bundle; without it an older
    // node reads the ESM bundle as CommonJS and refuses its first import.
    writeFileSync(join(root, "package.json"), `${JSON.stringify({ type: "module" })}\n`);
    const stub = join(root, "stub-cli.ts");
    writeFileSync(stub, STUB_SOURCE);
    scratch = { root, stub, entry: [node, bundle] };
  } catch (error) {
    rmSync(root, { recursive: true, force: true });
    throw error;
  }
});

afterAll(() => {
  if (scratch !== null) rmSync(scratch.root, { recursive: true, force: true });
});

// The hook command names `npx`, which the container cannot run for lack of network; a shim first
// on PATH records what the harness ran and execs the CLI in its place. The paths are baked in
// rather than read from the environment so a harness that trims its hook's env still reaches the
// same log and entry.
function shimSource(log: string): string {
  const quoted = (word: string): string => `'${word.replaceAll("'", "'\\''")}'`;
  return [
    "#!/bin/sh",
    `printf '%s\\n' "$*" >> ${quoted(log)}`,
    'if [ "$1" = "-y" ] && [ "$2" = "@vivswan/maxims" ]; then',
    "  shift 2",
    `  exec ${ready().entry.map(quoted).join(" ")} "$@"`,
    "fi",
    'echo "npx shim: unexpected arguments: $*" >&2',
    "exit 1",
    "",
  ].join("\n");
}

const EXPECTED_SHIM_LINE = HOOK_COMMAND.split(" ").slice(1).join(" ");

type Run = { exitCode: number | null; stdout: string; stderr: string; timedOut: boolean };

function after<T>(ms: number, value: T): { promise: Promise<T>; cancel: () => void } {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const promise = new Promise<T>((resolve) => {
    timer = setTimeout(() => resolve(value), ms);
  });
  return { promise, cancel: () => clearTimeout(timer) };
}

// The deadline covers the exit and the closing of both output pipes: an asynchronous hook child
// (the shell and maxims sync a harness leaves running past its own exit) inherits the pipes, so
// the CLI runs in its own process group and the kill reaches the whole group.
async function runWithDeadline(
  command: readonly string[],
  options: { cwd: string; env: Record<string, string> },
  deadlineMs: number,
): Promise<Run> {
  const proc = Bun.spawn([...command], {
    cwd: options.cwd,
    env: options.env,
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
    detached: true,
  });
  const output = Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
  const settled = Promise.all([proc.exited, output]).then(([, streams]) => streams);
  const deadline = after(deadlineMs, null);
  const streams = await Promise.race([settled, deadline.promise]);
  deadline.cancel();
  if (streams !== null) {
    const [stdout, stderr] = streams;
    return { exitCode: proc.exitCode, stdout, stderr, timedOut: false };
  }
  try {
    process.kill(-proc.pid, "SIGKILL");
  } catch {
    proc.kill("SIGKILL");
  }
  await proc.exited;
  const grace = after(KILL_GRACE_MS, null);
  const late = await Promise.race([output, grace.promise]);
  grace.cancel();
  const [stdout, stderr] = late ?? ["", ""];
  return { exitCode: null, stdout, stderr, timedOut: true };
}

function tail(text: string): string {
  return text.length <= TAIL_CHARS ? text : `...${text.slice(-TAIL_CHARS)}`;
}

function memoryFile(nonce: string): string {
  return [
    "---",
    "name: container-smoke",
    `description: Container smoke rule ${nonce}, reply in one word`,
    "metadata:",
    "  node_type: memory",
    "  type: feedback",
    "---",
    "",
    "**Why:** the rule line must reach the model request of every installed harness.",
    "",
  ].join("\n");
}

// One CLI run against its own fake, home and shim. The rule file and the hook registration are
// written by the maxims CLI, never by the test, so the harness is proven to read what `sync`
// wrote where it wrote it.
async function smoke(row: Row, extraEnv: Record<string, string> = {}): Promise<Verdict> {
  const dir = join(ready().root, `row-${row.name}-${randomUUID().slice(0, 8)}`);
  const home = join(dir, "home");
  const work = join(dir, "work");
  const bin = join(dir, "bin");
  const temp = join(dir, "tmp");
  const source = join(dir, "source");
  const log = join(dir, "shim.log");
  for (const path of [home, work, bin, temp, join(source, "memories")]) {
    mkdirSync(path, { recursive: true });
  }
  const fake = startFakeLlm();
  try {
    const nonce = `maxims-smoke-${randomUUID().replaceAll("-", "").slice(0, 16)}`;
    writeFileSync(join(source, "memories", "container-smoke.md"), memoryFile(nonce));
    writeFileSync(join(bin, "npx"), shimSource(log));
    chmodSync(join(bin, "npx"), 0o755);
    for (const [relative, content] of Object.entries(row.files?.(fake.baseUrl) ?? {})) {
      mkdirSync(dirname(join(home, relative)), { recursive: true });
      writeFileSync(join(home, relative), content);
    }
    const env: Record<string, string> = {
      PATH: `${bin}:${process.env.PATH ?? ""}`,
      HOME: home,
      USERPROFILE: home,
      TMPDIR: temp,
      NO_PROXY: "127.0.0.1,localhost",
      NO_COLOR: "1",
      TERM: "dumb",
      ...row.env(home, fake.baseUrl),
      ...extraEnv,
    };
    const add = await runWithDeadline(
      [...ready().entry, "add", source, "-g", "--rule", "--add-hook", "-a", row.harness, "-y"],
      { cwd: work, env },
      CLI_DEADLINE_MS,
    );
    if (add.exitCode !== 0) {
      return {
        ok: false,
        problems: [`maxims add exited ${add.exitCode}: ${tail(add.stderr)}${tail(add.stdout)}`],
      };
    }
    const run = await runWithDeadline(
      [...row.command, ...row.argv(PROMPT)],
      { cwd: work, env },
      CLI_DEADLINE_MS,
    );
    return judge(row, run, fake.requests(), readLog(log), nonce);
  } finally {
    await fake.close();
  }
}

// Only a log that was never written means the hook never ran; a log that exists but cannot be
// read is an error of the run, not an absent hook.
function readLog(path: string): string[] {
  try {
    return readFileSync(path, "utf8")
      .split("\n")
      .filter((line) => line !== "");
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return [];
    throw error;
  }
}

function judge(
  row: Row,
  run: Run,
  requests: readonly CapturedRequest[],
  hookLines: string[],
  nonce: string,
): Verdict {
  const problems: string[] = [];
  const cli = row.command[row.command.length - 1] ?? row.name;
  const seen = requests.map((r) => `${r.method} ${r.path}`).join(", ");
  const captured = `${requests.length} request(s) captured: ${seen}`;
  if (run.timedOut) {
    problems.push(
      `${cli} timed out after ${CLI_DEADLINE_MS} ms; ${captured}; stderr: ${tail(run.stderr)}`,
    );
  } else if (run.exitCode !== 0) {
    problems.push(
      `${cli} exited ${run.exitCode}; ${captured}; ` +
        `stderr: ${tail(run.stderr)}; stdout: ${tail(run.stdout)}`,
    );
  }
  if (hookLines.length === 0) {
    problems.push(`hook never ran: the npx shim log is empty; ${captured}`);
  } else if (hookLines.some((line) => line !== EXPECTED_SHIM_LINE)) {
    problems.push(
      `hook argv drifted: ${JSON.stringify(hookLines)} (expected "${EXPECTED_SHIM_LINE}")`,
    );
  }
  const onWire = requests.filter((request) => wireFor(request.path) === row.wire);
  const carrier = onWire.find((request) => request.body.includes(nonce));
  if (carrier === undefined) {
    problems.push(
      `rule line absent: none of ${onWire.length} request(s) on the ${row.wire} wire ` +
        `carries ${nonce}; ${captured}`,
    );
  } else if (!(row.authHeader in carrier.headers)) {
    problems.push(`header ${row.authHeader} missing on the request that carried the rule line`);
  }
  if (!row.succeeded(run.stdout)) {
    problems.push(`stdout lacks ${cli}'s success marker: ${tail(run.stdout)}`);
  }
  return problems.length === 0 ? PASSED : { ok: false, problems };
}

function stubRow(): Row {
  return { ...CLAUDE, name: "stub", command: [process.execPath, ready().stub] };
}

describe("the smoke's own logic on a stub CLI", () => {
  test(
    "a stub that runs the hook and loads the rules passes",
    async () => {
      expect(await smoke(stubRow())).toEqual(PASSED);
    },
    ROW_TIMEOUT_MS,
  );

  const withheld: [string, string][] = [
    ["hooks", "hook never ran"],
    ["rules", "rule line absent"],
  ];
  test.each(withheld)(
    "a stub that withholds its %s fails on that finding alone",
    async (step, finding) => {
      expect(await smoke(stubRow(), { MAXIMS_STUB_WITHHOLD: step })).toEqual({
        ok: false,
        problems: [expect.stringMatching(new RegExp(`^${finding}:`))],
      });
    },
    ROW_TIMEOUT_MS,
  );
});

const inContainer = inContainerTier(process.env);

describe("installed harness CLIs against the fake endpoint", () => {
  for (const row of REAL_ROWS) {
    const binary = row.command[0] ?? row.name;
    if (!inContainer) {
      const reason = `${CONTAINER_TIER_ENV}=1 is set only by the container tier`;
      const notice = `${row.name}: skipped, ${reason}`;
      test.skip(notice, () => {});
      continue;
    }
    test(
      row.name,
      async () => {
        if (Bun.which(binary) === null) {
          throw new Error(
            `${binary} is not on PATH; the container image installs it, so its absence is a defect`,
          );
        }
        expect(await smoke(row)).toEqual(PASSED);
      },
      ROW_TIMEOUT_MS,
    );
  }
});
