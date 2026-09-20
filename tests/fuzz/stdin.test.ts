// What would drift silently: a hook's stdin whose bytes make the reader reject or hang past its
// budget (a session start that never finishes), a payload that makes the invoker classifier
// THROW instead of answering silence, or a stdout envelope that a JSON-only harness cannot read.
// Every byte here comes from a harness maxims does not control, so the hook path answers for all.
import { expect, test } from "bun:test";
import { EventEmitter } from "node:events";
import fc from "fast-check";
import {
  classifyInvoker,
  readHookStdin,
  renderHookStdout,
  type StdinLike,
  stdoutVariantFor,
} from "../../src/commands/shared/stdin.ts";
import { HARNESS_IDS } from "../../src/contracts/harness-id.ts";
import type { HookStdout } from "../../src/harnesses/contract.ts";
import { HARNESSES } from "../../src/harnesses/registry.ts";
import { PROPERTY_TIMEOUT_MS } from "../shared/property.ts";
import { anyText, asyncOutcome, describeError, fragments, fuzz, outcome, timed } from "./shared.ts";

// The fields the invoker rules read, each in the type that matches and in one that does not, so
// a random record lands on every rule's boundary and on the order that disambiguates them.
const PAYLOAD_FIELDS = {
  hook_event_name: fc.constantFrom("SessionStart", "sessionStart", "PreToolUse", 1, null),
  timestamp: fc.oneof(fc.string(), fc.integer(), fc.constant(null)),
  prompt_id: fc.oneof(fc.string(), fc.constant(null)),
  scratchpad_dir: fc.oneof(fc.string(), fc.constant(null)),
  transcript_path: fc.constantFrom("", "/tmp/t.jsonl", 0, null),
  permission_mode: fc.oneof(fc.string(), fc.constant(null)),
  sessionId: fc.oneof(fc.string(), fc.constant(null)),
  session_id: fc.oneof(fc.string(), fc.constant(null)),
  source: fc.oneof(fc.string(), fc.constant(null)),
  hookName: fc.constantFrom("TaskStart", "taskStart", 1),
  workspaceRoots: fc.oneof(
    fc.array(fc.oneof(fc.string(), fc.integer()), { maxLength: 2 }),
    fc.string(),
  ),
  workspace_roots: fc.oneof(
    fc.array(fc.oneof(fc.string(), fc.integer()), { maxLength: 2 }),
    fc.string(),
  ),
  agent_action_name: fc.constantFrom("pre_user_prompt", "post_user_prompt", 1),
  trajectory_id: fc.oneof(fc.string(), fc.constant(null)),
  cwd: fc.oneof(fc.string(), fc.constant(""), fc.integer(), fc.constant(null)),
};

const payload = fc.record(PAYLOAD_FIELDS, { requiredKeys: [] });
const payloadText = fc.oneof(
  payload.map((record) => JSON.stringify(record)),
  fc.jsonValue({ maxDepth: 3 }).map((value) => JSON.stringify(value)),
  anyText({ maxLength: 300 }),
  fragments(
    ["{", "}", '"hook_event_name"', ":", '"SessionStart"', ",", '"cwd"', '"/"', " ", "\n"],
    {
      maxLength: 20,
    },
  ),
  fc.constant(null),
);

const KNOWN_IDS: readonly string[] = HARNESS_IDS;

function expectClassification(text: string | null): void {
  const result = outcome(() => classifyInvoker(text));
  if (result.kind === "threw") throw new Error(`threw ${describeError(result.error)}`);
  const classification = result.value;
  const blank = text === null || text.trim() === "";
  expect(classification.kind === "none").toBe(blank);
  const variant = outcome(() => stdoutVariantFor(classification, HARNESSES));
  if (variant.kind === "threw") throw new Error(`threw ${describeError(variant.error)}`);
  if (classification.kind === "none") expect(variant.value).toBe("plain");
  if (classification.kind === "unknown-json") expect(variant.value).toBeNull();
  if (classification.kind !== "harness") return;
  expect(KNOWN_IDS).toContain(classification.id);
  if (classification.startDir !== null) expect(classification.startDir).not.toBe("");
}

test(
  "classifyInvoker answers a known harness, unknown JSON or none for any stdin text",
  async () => {
    await fuzz("classifyInvoker", payloadText, expectClassification);
  },
  PROPERTY_TIMEOUT_MS,
);

// A scripted pipe: chunks arrive as bytes split anywhere (inside a multi-byte sequence included)
// or as strings, then the pipe ends, closes, errors, or stays open.
type Ending = "end" | "close" | "error" | "open";
type Script = { chunks: (Uint8Array | string)[]; ending: Ending; tty: boolean };

class FakeStdin extends EventEmitter implements StdinLike {
  isTTY: boolean;
  paused = false;
  constructor(tty: boolean) {
    super();
    this.isTTY = tty;
  }
  pause(): this {
    this.paused = true;
    return this;
  }
}

// A pipe's later events reach whoever is still subscribed: once the read has settled and left,
// an error is the emitter's own throw and no longer the reader's to absorb, so the ending is
// emitted only while the read is still pending (a terminal is never read and never fails).
async function play(stream: FakeStdin, script: Script, read: Promise<unknown>): Promise<void> {
  let settled = false;
  const watched = read.then(() => {
    settled = true;
  });
  for (const chunk of script.chunks) {
    stream.emit("data", typeof chunk === "string" ? chunk : Buffer.from(chunk));
  }
  await Promise.race([watched, Promise.resolve()]);
  if (script.ending === "open" || settled) return;
  if (script.ending === "error") {
    if (!script.tty) stream.emit("error", new Error("EPIPE"));
  } else stream.emit(script.ending);
}

const STREAM_EVENTS = ["data", "end", "close", "error"] as const;

function expectDetached(stream: FakeStdin): void {
  for (const event of STREAM_EVENTS) expect(stream.listenerCount(event)).toBe(0);
}

function decoded(chunks: readonly (Uint8Array | string)[]): string {
  return chunks
    .map((chunk) => (typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8")))
    .join("");
}

const chunk = fc.oneof(
  fc.uint8Array({ maxLength: 64 }),
  payloadText.filter((text) => text !== null).map((text) => String(text)),
  fc.uint8Array({ maxLength: 64 }).map((bytes) => Buffer.from(bytes).toString("utf8")),
);
const script: fc.Arbitrary<Script> = fc.record({
  chunks: fc.array(chunk, { maxLength: 6 }),
  ending: fc.constantFrom("end", "close", "error"),
  tty: fc.boolean(),
});

const FIRST_CHUNK_MS = 20;

test(
  "readHookStdin settles on any closed pipe and hands its text to a classifier that never throws",
  async () => {
    await fuzz("readHookStdin", script, async (played) => {
      const stream = new FakeStdin(played.tty);
      const read = readHookStdin(stream, FIRST_CHUNK_MS);
      await play(stream, played, read);
      const result = await asyncOutcome(() => read);
      if (result.kind === "threw") throw new Error(`rejected ${describeError(result.error)}`);
      const text = result.value;
      // A pipe that failed before any byte is not a terminal: its text names the failure, so the
      // caller reads an unknown invoker and stays silent instead of printing into the harness.
      if (played.tty) expect(text).toBeNull();
      else if (decoded(played.chunks) === "") {
        if (played.ending !== "error") expect(text).toBeNull();
        else {
          expect(text).not.toBeNull();
          expect(classifyInvoker(text)).toEqual({ kind: "unknown-json" });
        }
      } else {
        expect(text).not.toBeNull();
        expect(text).not.toBe("");
      }
      expectClassification(text);
      expectDetached(stream);
    });
  },
  PROPERTY_TIMEOUT_MS,
);

// A pipe the harness never closes: with no bytes the read gives up after the documented 200 ms
// first-chunk wait, and with bytes that never parse after the documented 1000 ms total, so a
// session start is delayed by at most that total plus the runner's own jitter. The budgets are
// the documented figures, not the module's constants, so a constant drifting past the contract
// fails here.
const FIRST_CHUNK_BUDGET_MS = 200;
const TOTAL_BUDGET_MS = 1000;
// Wide enough for a loaded runner's timer lag, narrow enough that a first-chunk wait doubled to
// 400 ms fails the no-bytes row.
const JITTER_MS = 150;
const open: [string, (Uint8Array | string)[], number][] = [
  ["no bytes", [], FIRST_CHUNK_BUDGET_MS],
  ["one unfinished object", ['{"hook_event_name": "SessionStart"'], TOTAL_BUDGET_MS],
  ["invalid utf8 then prose", [new Uint8Array([0xff, 0xfe]), "not json"], TOTAL_BUDGET_MS],
];

test.each(open)(
  "readHookStdin gives up on an open pipe with %s within its budget",
  async (_label, chunks, limitMs) => {
    const stream = new FakeStdin(false);
    const start = performance.now();
    const read = readHookStdin(stream);
    await play(stream, { chunks, ending: "open", tty: false }, read);
    const text = await read;
    const elapsed = performance.now() - start;
    expect(elapsed).toBeLessThan(limitMs + JITTER_MS);
    expect(elapsed).toBeGreaterThanOrEqual(limitMs - 5);
    expect(text).toBe(chunks.length === 0 ? null : decoded(chunks));
    expectClassification(text);
    expectDetached(stream);
  },
  PROPERTY_TIMEOUT_MS,
);

// The total is a fixed deadline, not an inactivity timeout: a pipe that keeps dripping bytes that
// never complete a JSON value still lets the session start at the documented total.
test(
  "readHookStdin holds the total deadline while an open pipe keeps sending",
  async () => {
    const stream = new FakeStdin(false);
    const start = performance.now();
    const read = readHookStdin(stream);
    stream.emit("data", '{"hook_event_name": ');
    const drip = setInterval(() => stream.emit("data", " "), 300);
    try {
      const text = await read;
      const elapsed = performance.now() - start;
      expect(elapsed).toBeLessThan(TOTAL_BUDGET_MS + JITTER_MS);
      expect(elapsed).toBeGreaterThanOrEqual(TOTAL_BUDGET_MS - 5);
      expect(text).toMatch(/^\{"hook_event_name": {1,}$/);
      expectClassification(text);
      expectDetached(stream);
    } finally {
      clearInterval(drip);
    }
  },
  PROPERTY_TIMEOUT_MS,
);

// A pipe that closed after a lone UTF-8 lead byte sent bytes: read as a terminal (null), the hook
// would print plain text into a harness that sent it a payload.
test("readHookStdin hands back the decoded text of a pipe that closed mid-character", async () => {
  const stream = new FakeStdin(false);
  const read = readHookStdin(stream, FIRST_CHUNK_MS);
  await play(stream, { chunks: [new Uint8Array([0xc3])], ending: "end", tty: false }, read);
  expect(await read).toBe("\ufffd");
});

const VARIANTS: HookStdout[] = [
  "plain",
  "json:additionalContext",
  "json:hookSpecificOutput.additionalContext",
  "json:contextModification",
  "json:additional_context",
  "none",
];

// A `json:` variant's name IS the path of the key the harness reads (the contract in
// src/harnesses/contract.ts), so the payload is looked up at that path.
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function payloadAt(envelope: unknown, variant: HookStdout): unknown {
  let node = envelope;
  for (const step of variant.slice("json:".length).split(".")) {
    if (!isRecord(node)) return undefined;
    node = node[step];
  }
  return node;
}

// Every JSON envelope carries the joined lines verbatim at its declared path in one parseable
// object and ends in a newline; silence is exactly the empty string, never `{}` or a bare newline.
test(
  "renderHookStdout is silent or one newline-terminated envelope carrying the lines",
  async () => {
    const lines = fc.array(anyText({ maxLength: 80 }), { maxLength: 5 });
    await fuzz(
      "renderHookStdout",
      fc.tuple(fc.constantFrom(...VARIANTS, null), lines),
      ([variant, text]) => {
        const { value: result, ms } = timed(() => outcome(() => renderHookStdout(variant, text)));
        if (result.kind === "threw") throw new Error(`threw ${describeError(result.error)}`);
        expect(ms).toBeLessThan(100);
        const out = result.value;
        if (variant === null || variant === "none" || text.length === 0) {
          expect(out).toBe("");
          return;
        }
        expect(out.endsWith("\n")).toBe(true);
        const joined = text.join("\n");
        if (variant === "plain") {
          expect(out).toBe(`${joined}\n`);
          return;
        }
        expect(payloadAt(JSON.parse(out), variant)).toBe(joined);
      },
    );
  },
  PROPERTY_TIMEOUT_MS,
);
