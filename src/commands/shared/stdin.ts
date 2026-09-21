import { StringDecoder } from "node:string_decoder";
import type { HarnessDefinition, HarnessId, HookStdout } from "../../harnesses/contract.ts";

export type InvokerClassification =
  | { kind: "harness"; id: HarnessId; startDir: string | null }
  | { kind: "unknown-json" }
  | { kind: "none" };

type Payload = Record<string, unknown>;

type InvokerRule = {
  id: HarnessId;
  matches: (payload: Payload) => boolean;
  startDir: (payload: Payload) => string | null;
};

const isString = (value: unknown): value is string => typeof value === "string";

function stringAt(payload: Payload, key: string): string | null {
  const value = payload[key];
  return isString(value) && value !== "" ? value : null;
}

function firstOf(payload: Payload, key: string): string | null {
  const value = payload[key];
  if (!Array.isArray(value)) return null;
  const [first] = value;
  return isString(first) && first !== "" ? first : null;
}

const sessionStart = (payload: Payload): boolean => payload.hook_event_name === "SessionStart";

// Every SessionStart payload shares `session_id`, `transcript_path`, `cwd` and `hook_event_name`,
// so the rules read the field each harness alone adds; the order is what disambiguates, and each
// definition's `fixtures/hook-stdin.json` is the test that keeps it honest.
const INVOKER_RULES: readonly InvokerRule[] = [
  {
    id: "gemini-cli",
    matches: (payload) => sessionStart(payload) && isString(payload.timestamp),
    startDir: (payload) => stringAt(payload, "cwd"),
  },
  {
    id: "claude-code",
    matches: (payload) =>
      sessionStart(payload) && ("prompt_id" in payload || "scratchpad_dir" in payload),
    startDir: (payload) => stringAt(payload, "cwd"),
  },
  {
    id: "dsh",
    matches: (payload) => sessionStart(payload) && payload.transcript_path === "",
    startDir: (payload) => stringAt(payload, "cwd"),
  },
  {
    id: "codex",
    matches: (payload) => sessionStart(payload) && "permission_mode" in payload,
    startDir: (payload) => stringAt(payload, "cwd"),
  },
  {
    id: "copilot",
    matches: (payload) => isString(payload.sessionId) && typeof payload.timestamp === "number",
    startDir: (payload) => stringAt(payload, "cwd"),
  },
  {
    id: "cline",
    matches: (payload) => payload.hookName === "TaskStart",
    startDir: (payload) => firstOf(payload, "workspaceRoots"),
  },
  {
    id: "cursor",
    matches: (payload) => payload.hook_event_name === "sessionStart",
    startDir: (payload) => firstOf(payload, "workspace_roots"),
  },
  // Windsurf has no session start; the hook rides the prompt action, which names no directory.
  {
    id: "windsurf",
    matches: (payload) =>
      payload.agent_action_name === "pre_user_prompt" && isString(payload.trajectory_id),
    startDir: (payload) => stringAt(payload, "cwd"),
  },
  // Devin names no event and no directory: a session id and the start reason are all it sends,
  // so it is judged last, once every payload that names its event has had its turn.
  {
    id: "devin",
    matches: (payload) =>
      !("hook_event_name" in payload) && isString(payload.session_id) && isString(payload.source),
    startDir: (payload) => stringAt(payload, "cwd"),
  },
];

// Null text means a terminal or an empty pipe: a human ran the command. A JSON object no rule
// recognizes is a harness this build does not know, and it gets silence rather than a guess.
export function classifyInvoker(text: string | null): InvokerClassification {
  if (text === null || text.trim() === "") return { kind: "none" };
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    return { kind: "unknown-json" };
  }
  if (!isPayload(json)) return { kind: "unknown-json" };
  const rule = INVOKER_RULES.find((candidate) => candidate.matches(json));
  if (rule === undefined) return { kind: "unknown-json" };
  return { kind: "harness", id: rule.id, startDir: rule.startDir(json) };
}

function isPayload(value: unknown): value is Payload {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

// The protocol the invoker reads is the definition's declaration, never a table here; a harness
// this build has no definition for gets silence, since printing plain text into a JSON-only
// reader would surface as a hook error at every session start.
export function stdoutVariantFor(
  classification: InvokerClassification,
  harnesses: readonly HarnessDefinition[],
): HookStdout | null {
  if (classification.kind === "none") return "plain";
  if (classification.kind === "unknown-json") return null;
  const def = harnesses.find((candidate) => candidate.id === classification.id);
  if (def === undefined || def.hook.kind === "none" || def.hook.kind === "custom") return null;
  return def.hook.stdout;
}

// Nothing to say prints nothing, whatever the envelope: a harness that reads JSON only (Gemini)
// must never see an empty object where silence was meant.
export function renderHookStdout(variant: HookStdout | null, lines: readonly string[]): string {
  if (variant === null || lines.length === 0) return "";
  const text = lines.join("\n");
  switch (variant) {
    case "none":
      return "";
    case "plain":
      return `${text}\n`;
    case "json:additionalContext":
      return `${JSON.stringify({ additionalContext: text })}\n`;
    case "json:hookSpecificOutput.additionalContext":
      return `${JSON.stringify({
        hookSpecificOutput: { hookEventName: "SessionStart", additionalContext: text },
      })}\n`;
    case "json:contextModification":
      return `${JSON.stringify({ cancel: false, contextModification: text })}\n`;
    case "json:additional_context":
      return `${JSON.stringify({ additional_context: text })}\n`;
    default: {
      const unhandled: never = variant;
      throw new Error(`unhandled hook stdout variant ${String(unhandled)}`);
    }
  }
}

export type StdinLike = {
  isTTY?: boolean;
  on(event: "data", listener: (chunk: Buffer | string) => void): unknown;
  on(event: "end" | "close" | "error", listener: () => void): unknown;
  removeListener(event: "data", listener: (chunk: Buffer | string) => void): unknown;
  removeListener(event: "end" | "close" | "error", listener: () => void): unknown;
  pause?: () => unknown;
};

export const HOOK_STDIN_FIRST_CHUNK_MS = 200;
const HOOK_STDIN_TOTAL_MS = 1000;

// A hook's stdin is a pipe the harness may never close, so the read waits a short while for the
// first chunk, then only until the text parses as one JSON value; a terminal is never read at
// all. Whatever arrives is returned as text and classified elsewhere. A pipe that fails before
// any text arrived is not a terminal: it hands back text that cannot be JSON, so the caller
// classifies an unknown invoker and stays silent rather than printing plain text into it.
export function readHookStdin(
  stream: StdinLike,
  firstChunkMs = HOOK_STDIN_FIRST_CHUNK_MS,
): Promise<string | null> {
  if (stream.isTTY === true) return Promise.resolve(null);
  return new Promise((resolve) => {
    const decoder = new StringDecoder("utf8");
    let text = "";
    let settled = false;
    const finish = (value: string | null): void => {
      if (settled) return;
      settled = true;
      clearTimeout(firstTimer);
      clearTimeout(totalTimer);
      stream.removeListener("data", onData);
      stream.removeListener("end", onEnd);
      stream.removeListener("close", onEnd);
      stream.removeListener("error", onError);
      stream.pause?.();
      resolve(value);
    };
    // The decoder holds an unfinished UTF-8 sequence back for the next chunk; once the pipe is done
    // none comes, and a pipe that sent only a lead byte would otherwise read as an empty one.
    const settle = (whenEmpty: string | null): void => {
      const all = text + decoder.end();
      finish(all === "" ? whenEmpty : all);
    };
    const onEnd = (): void => settle(null);
    const onError = (): void => settle(STDIN_FAILED);
    const onData = (chunk: Buffer | string): void => {
      clearTimeout(firstTimer);
      text += typeof chunk === "string" ? chunk : decoder.write(chunk);
      if (parsesAsJson(text)) finish(text);
    };
    const firstTimer = setTimeout(() => finish(null), firstChunkMs);
    const totalTimer = setTimeout(() => settle(null), HOOK_STDIN_TOTAL_MS);
    stream.on("data", onData);
    stream.on("end", onEnd);
    stream.on("close", onEnd);
    stream.on("error", onError);
  });
}

const STDIN_FAILED = "stdin could not be read";

function parsesAsJson(text: string): boolean {
  try {
    JSON.parse(text);
    return true;
  } catch {
    return false;
  }
}
