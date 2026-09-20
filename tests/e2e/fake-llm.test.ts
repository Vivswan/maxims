// Fails if the fake model endpoint truncates or normalizes a captured request body (a harness
// sends its whole system prompt, and the harness smoke searches it for one rule line), or if one
// of the four wire shapes the installed harness CLIs parse stops ending a turn cleanly.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { type FakeLlm, REPLY_TEXT, startFakeLlm, type Wire } from "./fake-llm.ts";

let fake: FakeLlm;

beforeAll(() => {
  fake = startFakeLlm();
});

afterAll(async () => {
  await fake.close();
});

type Frame = { event: string | null; data: string };

// Each SSE frame is a block of `field: value` lines ended by a blank line; Gemini ends its lines
// with CRLF, the others with LF. A parser discards an event left open at EOF, so a stream whose
// last frame lacks its blank line is refused here rather than read as complete.
function frames(text: string): Frame[] {
  const blocks = text.split(/\r?\n\r?\n/);
  if (blocks.pop() !== "") throw new Error(`unterminated SSE frame at the end of ${text}`);
  return blocks.map((block) => {
    const frame: Frame = { event: null, data: "" };
    for (const line of block.split(/\r?\n/)) {
      if (line.startsWith("event: ")) frame.event = line.slice("event: ".length);
      else if (line.startsWith("data: ")) frame.data += line.slice("data: ".length);
    }
    return frame;
  });
}

function decoded(text: string): { event: string | null; data: unknown }[] {
  return frames(text).map(({ event, data }) => ({
    event,
    data: data === "[DONE]" ? "[DONE]" : JSON.parse(data),
  }));
}

const CREATED = 1_700_000_000;

type Shape = {
  wire: Wire;
  path: string;
  streaming: Record<string, unknown>;
  once: Record<string, unknown>;
  streamed: { event: string | null; data: unknown }[];
  answered: unknown;
};

const anthropicUsage = {
  input_tokens: 10,
  output_tokens: 5,
  cache_creation_input_tokens: 0,
  cache_read_input_tokens: 0,
};

const responsesMessage = {
  type: "message",
  id: "msg_fake",
  status: "completed",
  role: "assistant",
  content: [{ type: "output_text", text: REPLY_TEXT, annotations: [] }],
};

const responsesUsage = {
  input_tokens: 10,
  input_tokens_details: { cached_tokens: 0 },
  output_tokens: 5,
  output_tokens_details: { reasoning_tokens: 0 },
  total_tokens: 15,
};

const chatChunk = (choices: unknown[]) => ({
  id: "chatcmpl-fake",
  object: "chat.completion.chunk",
  created: CREATED,
  model: "gpt-5.4",
  choices,
});

const SHAPES: Shape[] = [
  {
    wire: "anthropic-messages",
    path: "/v1/messages?beta=true",
    streaming: {
      model: "claude-haiku-4-5",
      max_tokens: 64,
      stream: true,
      messages: [{ role: "user", content: "hi" }],
    },
    once: {
      model: "claude-haiku-4-5",
      max_tokens: 64,
      messages: [{ role: "user", content: "hi" }],
    },
    streamed: [
      {
        event: "message_start",
        data: {
          type: "message_start",
          message: {
            id: "msg_fake",
            type: "message",
            role: "assistant",
            content: [],
            model: "claude-haiku-4-5",
            stop_reason: null,
            stop_sequence: null,
            usage: anthropicUsage,
          },
        },
      },
      {
        event: "content_block_start",
        data: { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
      },
      {
        event: "content_block_delta",
        data: {
          type: "content_block_delta",
          index: 0,
          delta: { type: "text_delta", text: REPLY_TEXT },
        },
      },
      { event: "content_block_stop", data: { type: "content_block_stop", index: 0 } },
      {
        event: "message_delta",
        data: {
          type: "message_delta",
          delta: { stop_reason: "end_turn", stop_sequence: null },
          usage: { output_tokens: 5 },
        },
      },
      { event: "message_stop", data: { type: "message_stop" } },
    ],
    answered: {
      id: "msg_fake",
      type: "message",
      role: "assistant",
      model: "claude-haiku-4-5",
      content: [{ type: "text", text: REPLY_TEXT }],
      stop_reason: "end_turn",
      stop_sequence: null,
      usage: anthropicUsage,
    },
  },
  {
    wire: "openai-chat",
    path: "/v1/chat/completions",
    streaming: {
      model: "gpt-5.4",
      stream: true,
      stream_options: { include_usage: true },
      messages: [{ role: "user", content: "hi" }],
    },
    once: { model: "gpt-5.4", messages: [{ role: "user", content: "hi" }] },
    streamed: [
      {
        event: null,
        data: chatChunk([
          {
            index: 0,
            delta: { role: "assistant", content: "" },
            logprobs: null,
            finish_reason: null,
          },
        ]),
      },
      {
        event: null,
        data: chatChunk([
          { index: 0, delta: { content: REPLY_TEXT }, logprobs: null, finish_reason: null },
        ]),
      },
      {
        event: null,
        data: chatChunk([{ index: 0, delta: {}, logprobs: null, finish_reason: "stop" }]),
      },
      {
        event: null,
        data: {
          ...chatChunk([]),
          usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
        },
      },
      { event: null, data: "[DONE]" },
    ],
    answered: {
      id: "chatcmpl-fake",
      object: "chat.completion",
      created: CREATED,
      model: "gpt-5.4",
      choices: [
        {
          index: 0,
          message: { role: "assistant", content: REPLY_TEXT },
          logprobs: null,
          finish_reason: "stop",
        },
      ],
      usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
    },
  },
  {
    wire: "openai-responses",
    path: "/v1/responses",
    streaming: { model: "gpt-5.4", stream: true, input: [{ role: "user", content: "hi" }] },
    once: { model: "gpt-5.4", input: [{ role: "user", content: "hi" }] },
    streamed: [
      {
        event: "response.created",
        data: {
          type: "response.created",
          sequence_number: 0,
          response: {
            id: "resp_fake",
            object: "response",
            created_at: CREATED,
            model: "gpt-5.4",
            status: "in_progress",
            output: [],
          },
        },
      },
      {
        event: "response.in_progress",
        data: {
          type: "response.in_progress",
          sequence_number: 1,
          response: {
            id: "resp_fake",
            object: "response",
            created_at: CREATED,
            model: "gpt-5.4",
            status: "in_progress",
            output: [],
          },
        },
      },
      {
        event: "response.output_item.added",
        data: {
          type: "response.output_item.added",
          sequence_number: 2,
          output_index: 0,
          item: {
            type: "message",
            id: "msg_fake",
            status: "in_progress",
            role: "assistant",
            content: [],
          },
        },
      },
      {
        event: "response.content_part.added",
        data: {
          type: "response.content_part.added",
          sequence_number: 3,
          item_id: "msg_fake",
          output_index: 0,
          content_index: 0,
          part: { type: "output_text", text: "", annotations: [] },
        },
      },
      {
        event: "response.output_text.delta",
        data: {
          type: "response.output_text.delta",
          sequence_number: 4,
          item_id: "msg_fake",
          output_index: 0,
          content_index: 0,
          delta: REPLY_TEXT,
        },
      },
      {
        event: "response.output_text.done",
        data: {
          type: "response.output_text.done",
          sequence_number: 5,
          item_id: "msg_fake",
          output_index: 0,
          content_index: 0,
          text: REPLY_TEXT,
        },
      },
      {
        event: "response.content_part.done",
        data: {
          type: "response.content_part.done",
          sequence_number: 6,
          item_id: "msg_fake",
          output_index: 0,
          content_index: 0,
          part: { type: "output_text", text: REPLY_TEXT, annotations: [] },
        },
      },
      {
        event: "response.output_item.done",
        data: {
          type: "response.output_item.done",
          sequence_number: 7,
          output_index: 0,
          item: responsesMessage,
        },
      },
      {
        event: "response.completed",
        data: {
          type: "response.completed",
          sequence_number: 8,
          response: {
            id: "resp_fake",
            object: "response",
            created_at: CREATED,
            model: "gpt-5.4",
            status: "completed",
            output: [responsesMessage],
            usage: responsesUsage,
          },
        },
      },
    ],
    answered: {
      id: "resp_fake",
      object: "response",
      created_at: CREATED,
      model: "gpt-5.4",
      status: "completed",
      output: [responsesMessage],
      usage: responsesUsage,
    },
  },
  {
    wire: "gemini",
    path: "/v1beta/models/gemini-2.5-flash:streamGenerateContent?alt=sse",
    streaming: { contents: [{ role: "user", parts: [{ text: "hi" }] }] },
    once: { contents: [{ role: "user", parts: [{ text: "hi" }] }] },
    streamed: [
      {
        event: null,
        data: {
          candidates: [
            {
              content: { role: "model", parts: [{ text: REPLY_TEXT }] },
              index: 0,
              finishReason: "STOP",
            },
          ],
          usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 5, totalTokenCount: 15 },
          modelVersion: "gemini-2.5-flash",
        },
      },
    ],
    answered: {
      candidates: [
        {
          content: { role: "model", parts: [{ text: REPLY_TEXT }] },
          index: 0,
          finishReason: "STOP",
        },
      ],
      usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 5, totalTokenCount: 15 },
      modelVersion: "gemini-2.5-flash",
    },
  },
];

// The one-shot Gemini route drops the stream suffix and its query.
function oncePath(shape: Shape): string {
  return shape.wire === "gemini"
    ? shape.path.replace(":streamGenerateContent?alt=sse", ":generateContent")
    : shape.path;
}

describe.each(SHAPES)("$wire", (shape) => {
  test("streams the canned reply in the shape the CLI parses", async () => {
    const response = await fetch(`${fake.baseUrl}${shape.path}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(shape.streaming),
    });
    expect({
      status: response.status,
      contentType: response.headers.get("content-type"),
      frames: decoded(await response.text()),
    }).toEqual({ status: 200, contentType: "text/event-stream", frames: shape.streamed });
  });

  test("answers a one-shot request with the complete message", async () => {
    const response = await fetch(`${fake.baseUrl}${oncePath(shape)}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(shape.once),
    });
    expect({
      status: response.status,
      contentType: response.headers.get("content-type"),
      body: await response.json(),
    }).toEqual({ status: 200, contentType: "application/json", body: shape.answered });
  });
});

// The body is pretty-printed and carries a JSON escape, so a capture that re-serializes what it
// parsed comes back different; the size is past the journal cap of the mocking library this fake
// replaced.
test("captures a 200 KB body byte for byte with the request's headers", async () => {
  const before = fake.requests().length;
  const body = JSON.stringify(
    {
      model: "claude-haiku-4-5",
      max_tokens: 64,
      messages: [{ role: "user", content: `padding ${"x".repeat(200 * 1024)}` }],
    },
    null,
    2,
  ).replace("padding", "pad\\u0064ing");
  const response = await fetch(`${fake.baseUrl}/v1/messages?beta=true`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": "fake",
      "anthropic-version": "2023-06-01",
    },
    body,
  });
  const captured = fake.requests().slice(before);
  expect({
    status: response.status,
    count: captured.length,
    method: captured[0]?.method,
    path: captured[0]?.path,
    apiKey: captured[0]?.headers["x-api-key"],
    contentLength: captured[0]?.headers["content-length"],
    bodyIntact: captured[0]?.body === body,
    bodyBytes: Buffer.byteLength(captured[0]?.body ?? ""),
  }).toEqual({
    status: 200,
    count: 1,
    method: "POST",
    path: "/v1/messages?beta=true",
    apiKey: "fake",
    contentLength: String(Buffer.byteLength(body)),
    bodyIntact: true,
    bodyBytes: Buffer.byteLength(body),
  });
});

test("a route outside the four wires is refused and still captured", async () => {
  const before = fake.requests().length;
  const [hello, other] = await Promise.all([
    fetch(`${fake.baseUrl}/api/hello`, { method: "HEAD" }),
    fetch(`${fake.baseUrl}/v1/messages/count_tokens`, { method: "POST", body: "{}" }),
  ]);
  const captured = fake.requests().slice(before);
  expect({
    statuses: [hello.status, other.status],
    captured: captured.map((request) => [request.method, request.path, request.body]).sort(),
  }).toEqual({
    statuses: [404, 404],
    captured: [
      ["HEAD", "/api/hello", ""],
      ["POST", "/v1/messages/count_tokens", "{}"],
    ],
  });
});

// Gemini CLI's model router asks for JSON against a schema of this shape before every turn and
// retries with backoff while the answer does not parse; a prose reply here is a stalled row.
test("a Gemini structured-output request is answered with an instance of its schema", async () => {
  const response = await fetch(`${fake.baseUrl}/v1beta/models/gemini-2.5-flash:generateContent`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      contents: [{ role: "user", parts: [{ text: "rate this" }] }],
      generationConfig: {
        responseMimeType: "application/json",
        responseJsonSchema: {
          type: "OBJECT",
          properties: {
            complexity_reasoning: { type: "STRING" },
            complexity_score: { type: "INTEGER" },
            route: { type: "STRING", enum: ["flash", "pro"] },
            flags: { type: "ARRAY", items: { type: "STRING" } },
            optional_note: { type: "STRING" },
          },
          required: ["complexity_reasoning", "complexity_score", "route", "flags"],
        },
      },
    }),
  });
  const body = (await response.json()) as {
    candidates: { content: { parts: { text: string }[] } }[];
  };
  expect(JSON.parse(body.candidates[0]?.content.parts[0]?.text ?? "")).toEqual({
    complexity_reasoning: "ok",
    complexity_score: 1,
    route: "flash",
    flags: [],
  });
});

test("the model catalog lists what the smoke rows ask for", async () => {
  const response = await fetch(`${fake.baseUrl}/v1/models`);
  const body = (await response.json()) as { data: { id: string }[] };
  expect({ status: response.status, ids: body.data.map((m) => m.id) }).toEqual({
    status: 200,
    ids: ["claude-haiku-4-5", "gpt-5.4", "gemini-2.5-flash"],
  });
});
