// Guards the splice edits every JSON config write relies on: a hand-formatted JSONC file with
// comments beside the commas, compact siblings, one-line arrays, trailing commas, and CRLF must
// come back byte-identical once our child leaves, whatever position it held.
import { expect, test } from "bun:test";
import { findNodeAtLocation } from "jsonc-parser";
import { ExitCode, MaximsError } from "../../util/exit-codes.ts";
import { appendChild, assertParses, removeChild, replaceValue } from "./jsonc-edit.ts";

const VALUE = { command: "npx", args: ["-y", "maxims", "mcp-serve"] };

function add(text: string, path: string[], key: string | null, value: unknown): string {
  const container = findNodeAtLocation(assertParses(text, "t"), path);
  if (container === undefined) throw new Error(`no container at ${path.join(".")}`);
  const next = appendChild(text, container, key, value);
  assertParses(next, "t");
  return next;
}

function remove(text: string, path: string[], match: (value: unknown) => boolean): string {
  const container = findNodeAtLocation(assertParses(text, "t"), path);
  if (container === undefined) throw new Error(`no container at ${path.join(".")}`);
  const child = (container.children ?? []).find((node) =>
    container.type === "object" ? match(node.children?.[0]?.value) : match(node.value),
  );
  if (child === undefined) throw new Error("no child to remove");
  const next = removeChild(text, container, child);
  assertParses(next, "t");
  return next;
}

const V = '{"command":"npx","args":["-y","maxims","mcp-serve"]}';
const PRETTY_V =
  '{\n      "command": "npx",\n      "args": [\n        "-y",\n        "maxims",\n        "mcp-serve"\n      ]\n    }';
const M = `"maxims": ${V}`;
const PRETTY_M = `"maxims": ${PRETTY_V}`;

// [label, before, after adding our property under mcpServers, after removing it again]. The
// last column is the first unless a comment inside a once-empty map keeps the map open.
const properties: [string, string, string, string | null][] = [
  [
    "pretty, after a compact sibling and a line comment",
    '{\n  "mcpServers": {\n    // keep me\n    "fs": { "command": "x" }\n  },\n  "theme": "dark"\n}\n',
    `{\n  "mcpServers": {\n    // keep me\n    "fs": { "command": "x" },\n    ${PRETTY_M}\n  },\n  "theme": "dark"\n}\n`,
    null,
  ],
  [
    "a block comment between the last comma and the sibling",
    '{\n  "mcpServers": {\n    "a": {}, /* keep, note */ "fs": {}\n  }\n}\n',
    `{\n  "mcpServers": {\n    "a": {}, /* keep, note */ "fs": {}, ${M}\n  }\n}\n`,
    null,
  ],
  [
    "a trailing comma after the last sibling",
    '{\n  "mcpServers": {\n    "fs": {},\n  }\n}\n',
    `{\n  "mcpServers": {\n    "fs": {},\n    ${PRETTY_M},\n  }\n}\n`,
    null,
  ],
  [
    "an empty map holding a comment, in a multi-line file",
    '{\n  "mcpServers": { /* none yet */ }\n}\n',
    `{\n  "mcpServers": { /* none yet */\n    ${PRETTY_M}\n  }\n}\n`,
    '{\n  "mcpServers": { /* none yet */\n  }\n}\n',
  ],
  [
    "a single-line file",
    '{"mcpServers":{"fs":{}},"theme":"dark"}',
    `{"mcpServers":{"fs":{},${M}},"theme":"dark"}`,
    null,
  ],
  [
    "CRLF line endings",
    '{\r\n  "mcpServers": {\r\n    "fs": {}\r\n  }\r\n}\r\n',
    `{\r\n  "mcpServers": {\r\n    "fs": {},\r\n    ${PRETTY_M.split("\n").join("\r\n")}\r\n  }\r\n}\r\n`,
    null,
  ],
];

test.each(properties)(
  "a property appended under %s comes back out byte-identically",
  (_, before, after, restored) => {
    expect(add(before, ["mcpServers"], "maxims", VALUE)).toBe(after);
    expect(remove(after, ["mcpServers"], (key) => key === "maxims")).toBe(restored ?? before);
  },
);

// Our property in positions we did not write it to: first, middle, only, and beside comments.
const removals: [string, string, string][] = [
  [
    "first of three",
    '{\n  "s": {\n    "maxims": {},\n    "a": {},\n    "b": {}\n  }\n}\n',
    '{\n  "s": {\n    "a": {},\n    "b": {}\n  }\n}\n',
  ],
  ["middle, compact", '{"s":{"a":{}, "maxims":{}, "b":{}}}', '{"s":{"a":{}, "b":{}}}'],
  ["only child, pretty", '{\n  "s": {\n    "maxims": {}\n  }\n}\n', '{\n  "s": {}\n}\n'],
  [
    "only child beside a comment",
    '{\n  "s": {\n    // keep\n    "maxims": {}\n  }\n}\n',
    '{\n  "s": {\n    // keep\n  }\n}\n',
  ],
  ["only child with a trailing comma", '{"s":{"maxims":{},}}', '{"s":{}}'],
  [
    "only child with a trailing comma, pretty",
    '{\n  "s": {\n    "maxims": {},\n  }\n}\n',
    '{\n  "s": {}\n}\n',
  ],
  [
    "only child with a comment before its trailing comma",
    '{"s":{"maxims":{} /* keep */,}}',
    '{"s":{/* keep */}}',
  ],
  [
    "a comment after our comma",
    '{"s":{"maxims":{} /* keep, note */,"other":{}}}',
    '{"s":{ /* keep, note */"other":{}}}',
  ],
  [
    "last, with a comment between the comma and us",
    '{"s":{"other":{}, /* keep */ "maxims":{}}}',
    '{"s":{"other":{} /* keep */ }}',
  ],
];

test.each(removals)(
  "removing our property when it is %s keeps every other byte",
  (_, before, after) => {
    expect(remove(before, ["s"], (key) => key === "maxims")).toBe(after);
  },
);

const elements: [string, string, string][] = [
  ["a one-line array", '{ "i": ["a", "b"] }\n', '{ "i": ["a", "b", "x"] }\n'],
  [
    "a multi-line array",
    '{\n  "i": [\n    "a"\n  ]\n}\n',
    '{\n  "i": [\n    "a",\n    "x"\n  ]\n}\n',
  ],
  ["an empty array on one line", '{ "i": [] }\n', '{ "i": ["x"] }\n'],
  ["an empty array in a multi-line file", '{\n  "i": []\n}\n', '{\n  "i": [\n    "x"\n  ]\n}\n'],
  ["an empty array with a comment", '{ "i": [ /* keep */ ] }\n', '{ "i": [ /* keep */ "x"] }\n'],
];

test.each(elements)(
  "an element appended to %s comes back out byte-identically",
  (_, before, after) => {
    expect(add(before, ["i"], null, "x")).toBe(after);
    expect(remove(after, ["i"], (value) => value === "x")).toBe(before);
  },
);

test("replacing our value keeps its layout: compact stays compact, pretty stays pretty", () => {
  const compact = '{"s":{"maxims":{"command":"old"},"fs":{}}}';
  const pretty =
    '{\n  "s": {\n    "maxims": {\n      "command": "old"\n    },\n    "fs": {}\n  }\n}\n';
  for (const [text, expected] of [
    [compact, `{"s":{"maxims":${V},"fs":{}}}`],
    [pretty, `{\n  "s": {\n    ${PRETTY_M},\n    "fs": {}\n  }\n}\n`],
  ]) {
    const value = findNodeAtLocation(assertParses(text, "t"), ["s", "maxims"]);
    if (value === undefined) throw new Error("fixture lacks maxims");
    expect(replaceValue(text, value, VALUE)).toBe(expected);
  }
});

test("a splice whose result would not parse is refused (exit 4) instead of written", () => {
  let caught: unknown;
  try {
    assertParses('{"a": }', "t");
  } catch (error) {
    caught = error;
  }
  expect(caught).toBeInstanceOf(MaximsError);
  expect(caught).toMatchObject({ code: ExitCode.DestinationWriteFailed });
});
