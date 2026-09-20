// A stand-in for the four model endpoints the installed harness CLIs talk to, served in-process
// on a loopback port so a CLI run needs no network and no credential. Every request is kept
// with its raw body: the harness smoke searches those bodies for the rule line maxims installed,
// so nothing here parses a body into a shape that could drop or reorder text.
//
// One canned reply answers every route. The frame sequences follow what the vendors' own
// clients require to end a turn cleanly; a CLI that hangs or errors on them is the drift the
// container tier exists to catch.
export const REPLY_TEXT = "The fake model endpoint answered.";

export type Wire = "anthropic-messages" | "openai-chat" | "openai-responses" | "gemini";

export type CapturedRequest = {
  method: string;
  path: string;
  headers: Record<string, string>;
  body: string;
};

export type FakeLlm = {
  baseUrl: string;
  requests: () => readonly CapturedRequest[];
  close: () => Promise<void>;
};

const MODELS = ["claude-haiku-4-5", "gpt-5.4", "gemini-2.5-flash"] as const;
const CREATED = 1_700_000_000;
const INPUT_TOKENS = 10;
const OUTPUT_TOKENS = 5;

const GEMINI_ROUTE = /^\/v1beta\/models\/([^/:]+):(generateContent|streamGenerateContent)$/;

// Gemini alone carries the model and the streaming choice in its path; the other wires read
// `model` and `stream` from the body.
type Route =
  | { wire: "anthropic-messages" | "openai-chat" | "openai-responses" }
  | { wire: "gemini"; model: string; streaming: boolean };

// Paths are matched without their query (Claude appends `?beta=true`, Gemini `?alt=sse`).
function routeFor(path: string): Route | null {
  const bare = path.split("?")[0] ?? "";
  if (bare === "/v1/messages") return { wire: "anthropic-messages" };
  if (bare === "/v1/chat/completions") return { wire: "openai-chat" };
  if (bare === "/v1/responses") return { wire: "openai-responses" };
  const gemini = GEMINI_ROUTE.exec(bare);
  if (gemini === null) return null;
  return {
    wire: "gemini",
    model: gemini[1] ?? "",
    streaming: gemini[2] === "streamGenerateContent",
  };
}

export function wireFor(path: string): Wire | null {
  return routeFor(path)?.wire ?? null;
}

export function startFakeLlm(): FakeLlm {
  const captured: CapturedRequest[] = [];
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      const url = new URL(request.url);
      const path = `${url.pathname}${url.search}`;
      const body = await request.text();
      captured.push({
        method: request.method,
        path,
        headers: Object.fromEntries(request.headers),
        body,
      });
      return answer(request.method, url.pathname, body);
    },
  });
  return {
    baseUrl: `http://127.0.0.1:${server.port}`,
    requests: () => captured,
    close: () => server.stop(true),
  };
}

function answer(method: string, pathname: string, body: string): Response {
  if (method === "GET" && pathname === "/v1/models") {
    return json({
      object: "list",
      data: MODELS.map((id) => ({ id, object: "model", created: CREATED, owned_by: "fake" })),
    });
  }
  const route = routeFor(pathname);
  if (method !== "POST" || route === null) {
    return json({ error: { type: "not_found_error", message: `no route for ${pathname}` } }, 404);
  }
  const parsed = parseBody(body);
  if (parsed === null) {
    return json({ error: { type: "invalid_request_error", message: "body is not JSON" } }, 400);
  }
  switch (route.wire) {
    case "anthropic-messages":
      return reply(parsed, model(parsed), anthropicStream, anthropicMessage);
    case "openai-chat":
      return reply(parsed, model(parsed), chatStream, chatCompletion);
    case "openai-responses":
      return reply(parsed, model(parsed), responsesStream, responsesResponse);
    case "gemini": {
      const chunk = geminiChunk(route.model, geminiReplyText(parsed));
      return route.streaming ? sse([geminiFrame(chunk)]) : json(chunk);
    }
  }
}

type Body = Record<string, unknown>;

function parseBody(body: string): Body | null {
  try {
    const value: unknown = JSON.parse(body);
    return typeof value === "object" && value !== null && !Array.isArray(value)
      ? (value as Body)
      : null;
  } catch {
    return null;
  }
}

function model(body: Body): string {
  return typeof body.model === "string" ? body.model : "fake-model";
}

function reply(
  body: Body,
  modelId: string,
  stream: (modelId: string) => string[],
  once: (modelId: string) => unknown,
): Response {
  return body.stream === true ? sse(stream(modelId)) : json(once(modelId));
}

function json(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function sse(frames: string[]): Response {
  return new Response(frames.join(""), {
    status: 200,
    headers: { "content-type": "text/event-stream", "cache-control": "no-cache" },
  });
}

function namedFrame(event: Record<string, unknown> & { type: string }): string {
  return `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`;
}

function dataFrame(value: unknown): string {
  return `data: ${typeof value === "string" ? value : JSON.stringify(value)}\n\n`;
}

// Anthropic Messages, as Claude Code reads it.

const ANTHROPIC_USAGE = {
  input_tokens: INPUT_TOKENS,
  output_tokens: OUTPUT_TOKENS,
  cache_creation_input_tokens: 0,
  cache_read_input_tokens: 0,
};

function anthropicMessage(modelId: string): unknown {
  return {
    id: "msg_fake",
    type: "message",
    role: "assistant",
    model: modelId,
    content: [{ type: "text", text: REPLY_TEXT }],
    stop_reason: "end_turn",
    stop_sequence: null,
    usage: ANTHROPIC_USAGE,
  };
}

function anthropicStream(modelId: string): string[] {
  return [
    {
      type: "message_start",
      message: {
        id: "msg_fake",
        type: "message",
        role: "assistant",
        content: [],
        model: modelId,
        stop_reason: null,
        stop_sequence: null,
        usage: ANTHROPIC_USAGE,
      },
    },
    { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
    { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: REPLY_TEXT } },
    { type: "content_block_stop", index: 0 },
    {
      type: "message_delta",
      delta: { stop_reason: "end_turn", stop_sequence: null },
      usage: { output_tokens: OUTPUT_TOKENS },
    },
    { type: "message_stop" },
  ].map(namedFrame);
}

// OpenAI chat completions, as Copilot CLI (BYOK) and OpenCode read it.

const CHAT_USAGE = {
  prompt_tokens: INPUT_TOKENS,
  completion_tokens: OUTPUT_TOKENS,
  total_tokens: INPUT_TOKENS + OUTPUT_TOKENS,
};

function chatCompletion(modelId: string): unknown {
  return {
    id: "chatcmpl-fake",
    object: "chat.completion",
    created: CREATED,
    model: modelId,
    choices: [
      {
        index: 0,
        message: { role: "assistant", content: REPLY_TEXT },
        logprobs: null,
        finish_reason: "stop",
      },
    ],
    usage: CHAT_USAGE,
  };
}

function chatStream(modelId: string): string[] {
  const chunk = (choices: unknown[], extra: Record<string, unknown> = {}) => ({
    id: "chatcmpl-fake",
    object: "chat.completion.chunk",
    created: CREATED,
    model: modelId,
    choices,
    ...extra,
  });
  const choice = (delta: Record<string, unknown>, finish: string | null) => ({
    index: 0,
    delta,
    logprobs: null,
    finish_reason: finish,
  });
  return [
    chunk([choice({ role: "assistant", content: "" }, null)]),
    chunk([choice({ content: REPLY_TEXT }, null)]),
    chunk([choice({}, "stop")]),
    chunk([], { usage: CHAT_USAGE }),
    "[DONE]",
  ].map(dataFrame);
}

// OpenAI Responses, as Codex reads it.

const RESPONSES_USAGE = {
  input_tokens: INPUT_TOKENS,
  input_tokens_details: { cached_tokens: 0 },
  output_tokens: OUTPUT_TOKENS,
  output_tokens_details: { reasoning_tokens: 0 },
  total_tokens: INPUT_TOKENS + OUTPUT_TOKENS,
};

const RESPONSES_MESSAGE = {
  type: "message",
  id: "msg_fake",
  status: "completed",
  role: "assistant",
  content: [{ type: "output_text", text: REPLY_TEXT, annotations: [] }],
};

function responsesEnvelope(modelId: string, status: "in_progress" | "completed"): unknown {
  return {
    id: "resp_fake",
    object: "response",
    created_at: CREATED,
    model: modelId,
    status,
    output: status === "completed" ? [RESPONSES_MESSAGE] : [],
    ...(status === "completed" ? { usage: RESPONSES_USAGE } : {}),
  };
}

function responsesResponse(modelId: string): unknown {
  return responsesEnvelope(modelId, "completed");
}

function responsesStream(modelId: string): string[] {
  const at = { item_id: "msg_fake", output_index: 0, content_index: 0 };
  const events: (Record<string, unknown> & { type: string })[] = [
    { type: "response.created", response: responsesEnvelope(modelId, "in_progress") },
    { type: "response.in_progress", response: responsesEnvelope(modelId, "in_progress") },
    {
      type: "response.output_item.added",
      output_index: 0,
      item: { ...RESPONSES_MESSAGE, status: "in_progress", content: [] },
    },
    {
      type: "response.content_part.added",
      ...at,
      part: { type: "output_text", text: "", annotations: [] },
    },
    { type: "response.output_text.delta", ...at, delta: REPLY_TEXT },
    { type: "response.output_text.done", ...at, text: REPLY_TEXT },
    {
      type: "response.content_part.done",
      ...at,
      part: { type: "output_text", text: REPLY_TEXT, annotations: [] },
    },
    { type: "response.output_item.done", output_index: 0, item: RESPONSES_MESSAGE },
    { type: "response.completed", response: responsesEnvelope(modelId, "completed") },
  ];
  return events.map((event, sequence_number) => namedFrame({ ...event, sequence_number }));
}

// Gemini generateContent, as Gemini CLI reads it. One chunk carries the whole reply, the finish
// reason and the usage; the stream variant wraps it in a CRLF-terminated data frame.
//
// Gemini CLI routes every turn through a classifier call that asks for JSON against a response
// schema and retries with backoff while the text does not parse, which dominates the run. A
// structured-output request therefore gets an instance of its schema instead of the prose reply.

function geminiReplyText(body: Body): string {
  const config = body.generationConfig;
  if (typeof config !== "object" || config === null) return REPLY_TEXT;
  const { responseMimeType, responseJsonSchema, responseSchema } = config as Body;
  if (responseMimeType !== "application/json") return REPLY_TEXT;
  return JSON.stringify(instanceOf(responseJsonSchema ?? responseSchema));
}

// The smallest value a JSON schema admits: every required property (all of them when the schema
// names none), the first enum member, an empty array, and neutral scalars. Gemini spells types in
// upper case (`Type.OBJECT`), JSON Schema in lower case; both are read.
function instanceOf(schema: unknown): unknown {
  if (typeof schema !== "object" || schema === null) return {};
  const node = schema as Body;
  if (Array.isArray(node.enum) && node.enum.length > 0) return node.enum[0];
  if (Array.isArray(node.anyOf) && node.anyOf.length > 0) return instanceOf(node.anyOf[0]);
  const type = String(Array.isArray(node.type) ? node.type[0] : node.type).toLowerCase();
  switch (type) {
    case "string":
      return "ok";
    case "integer":
    case "number":
      return 1;
    case "boolean":
      return true;
    case "array":
      return [];
    case "null":
      return null;
    default: {
      const properties =
        typeof node.properties === "object" && node.properties !== null
          ? (node.properties as Record<string, unknown>)
          : {};
      const required = Array.isArray(node.required)
        ? node.required.filter((name): name is string => typeof name === "string")
        : Object.keys(properties);
      return Object.fromEntries(required.map((name) => [name, instanceOf(properties[name])]));
    }
  }
}

function geminiChunk(modelId: string, text: string): unknown {
  return {
    candidates: [{ content: { role: "model", parts: [{ text }] }, index: 0, finishReason: "STOP" }],
    usageMetadata: {
      promptTokenCount: INPUT_TOKENS,
      candidatesTokenCount: OUTPUT_TOKENS,
      totalTokenCount: INPUT_TOKENS + OUTPUT_TOKENS,
    },
    modelVersion: modelId,
  };
}

function geminiFrame(value: unknown): string {
  return `data: ${JSON.stringify(value)}\r\n\r\n`;
}
