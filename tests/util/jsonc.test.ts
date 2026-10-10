// The splices edit files the user also owns: a member rendered in the wrong indent style, a comma
// dropped or doubled, a comment lost with the node beside it, or a broken file rewritten as if it
// parsed would each survive a shape check and still wreck the user's config.
import { describe, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { findNodeAtLocation, getNodeValue, type Node } from "jsonc-parser";
import { ExitCode, MaximsError } from "../../src/util/exit-codes.ts";
import {
  appendChild,
  assertParses,
  type JsonDialect,
  jsonReader,
  parseJsonDocument,
  readConfigText,
  removeChild,
  replaceValue,
} from "../../src/util/jsonc.ts";
import { outcome } from "../shared/outcome.ts";
import { withTempDir } from "../shared/temp_dir.ts";

const path = "/home/user/project/example.json";

function at(text: string, location: (string | number)[]): Node {
  const node = findNodeAtLocation(assertParses(text, path), location);
  if (node === undefined) throw new Error(`fixture lacks ${location.join(".")}`);
  return node;
}

describe("appendChild", () => {
  const cases: {
    name: string;
    text: string;
    container: (string | number)[];
    key: string | null;
    value: unknown;
    after: string;
  }[] = [
    {
      name: "a property after the last one, in the file's four-space indent",
      text: '{\n    "a": 1\n}\n',
      container: [],
      key: "b",
      value: { c: [1] },
      after: '{\n    "a": 1,\n    "b": {\n        "c": [\n            1\n        ]\n    }\n}\n',
    },
    {
      name: "an element after the last one, in the file's tab indent",
      text: '{\n\t"list": [\n\t\t"x"\n\t]\n}\n',
      container: ["list"],
      key: null,
      value: "y",
      after: '{\n\t"list": [\n\t\t"x",\n\t\t"y"\n\t]\n}\n',
    },
    {
      name: "a property into an empty object opens it onto its own lines",
      text: '{"a": {}}',
      container: ["a"],
      key: "b",
      value: 1,
      after: '{"a": {\n  "b": 1\n}}',
    },
    {
      name: "an element into an empty list keeps the comment and the bracket's own space",
      text: '{"list": [ /* keep */ ]}',
      container: ["list"],
      key: null,
      value: 1,
      after: '{"list": [ /* keep */\n  1\n ]}',
    },
    {
      name: "an element into an empty list already broken onto lines adds no second break",
      text: '{\n  "l": [\n  ]\n}\n',
      container: ["l"],
      key: null,
      value: 1,
      after: '{\n  "l": [\n    1\n  ]\n}\n',
    },
    {
      name: "an element after a line comment in an empty list ends on the comment's own break",
      text: '{"l": [\n// keep\n]}',
      container: ["l"],
      key: null,
      value: 1,
      after: '{"l": [\n// keep\n  1\n]}',
    },
    {
      name: "a line comment's trailing space stays on the comment, not on the new element's line",
      text: '{"l": [\n// keep \n]}',
      container: ["l"],
      key: null,
      value: 1,
      after: '{"l": [\n// keep \n  1\n]}',
    },
    {
      name: "a bracket glued to a comment in a list already on several lines stays glued",
      text: '{"l": [\n/* keep */]}',
      container: ["l"],
      key: null,
      value: 1,
      after: '{"l": [\n/* keep */\n  1]}',
    },
    {
      name: "a block-comment header does not pass for the indent unit",
      text: '/*\n * settings\n */\n{\n    "a": 1\n}\n',
      container: [],
      key: "b",
      value: { c: 2 },
      after: '/*\n * settings\n */\n{\n    "a": 1,\n    "b": {\n        "c": 2\n    }\n}\n',
    },
    {
      name: "a first member sharing the comment's line does not supply the unit either",
      text: '/*\n * settings\n */ {"a": 1,\n    "b": 2\n}\n',
      container: [],
      key: "c",
      value: { d: 3 },
      after: '/*\n * settings\n */ {"a": 1,\n    "b": 2,\n    "c": {\n        "d": 3\n    }\n}\n',
    },
    {
      name: "a CRLF file gains CRLF lines only",
      text: '{\r\n  "a": 1\r\n}\r\n',
      container: [],
      key: "b",
      value: [1],
      after: '{\r\n  "a": 1,\r\n  "b": [\r\n    1\r\n  ]\r\n}\r\n',
    },
    {
      name: "an element after the last one in a one-line list stays on that line",
      text: '{"l": ["a"]}',
      container: ["l"],
      key: null,
      value: "b",
      after: '{"l": ["a", "b"]}',
    },
    {
      name: "a property after the last one in a one-line object stays on that line",
      text: '{"o": {"k": 1}}',
      container: ["o"],
      key: "j",
      value: 2,
      after: '{"o": {"k": 1, "j": 2}}',
    },
    {
      name: "a one-line list with the user's bracket padding keeps the padding",
      text: '{"l": [ "a" ]}',
      container: ["l"],
      key: null,
      value: "b",
      after: '{"l": [ "a", "b" ]}',
    },
  ];

  test.each(cases)("$name", ({ text, container, key, value, after }) => {
    expect(appendChild(text, at(text, container), key, value)).toBe(after);
  });
});

describe("removeChild", () => {
  const cases: {
    name: string;
    text: string;
    container: (string | number)[];
    index: number;
    after: string;
  }[] = [
    {
      name: "the first element takes the comma after it and the whitespace run",
      text: '{"l": [1, 2, 3]}',
      container: ["l"],
      index: 0,
      after: '{"l": [2, 3]}',
    },
    {
      name: "a middle property alone on its line takes the line",
      text: '{\n  "a": 1,\n  "b": 2,\n  "c": 3\n}\n',
      container: [],
      index: 1,
      after: '{\n  "a": 1,\n  "c": 3\n}\n',
    },
    {
      name: "the last element takes the comma before it",
      text: '{"l": [1, 2, 3]}',
      container: ["l"],
      index: 2,
      after: '{"l": [1, 2]}',
    },
    {
      name: "the last element keeps a comment between the comma and itself",
      text: '{"l": [1, /* keep */ 2]}',
      container: ["l"],
      index: 1,
      after: '{"l": [1 /* keep */]}',
    },
    {
      name: "a lone element collapses its container",
      text: '{"l": [\n    1\n  ]}',
      container: ["l"],
      index: 0,
      after: '{"l": []}',
    },
    {
      name: "a lone element leaves a commented container open",
      text: '{"l": [\n  // keep\n  1\n]}',
      container: ["l"],
      index: 0,
      after: '{"l": [\n  // keep\n]}',
    },
    {
      name: "a lone element in a container already broken onto lines leaves the user's break",
      text: '{"l": [\n/* keep */\n  1\n]}',
      container: ["l"],
      index: 0,
      after: '{"l": [\n/* keep */\n]}',
    },
    {
      name: "a line comment with trailing spaces still keeps the break that ends it",
      text: '{"l": [// keep \n  1\n]}',
      container: ["l"],
      index: 0,
      after: '{"l": [// keep \n]}',
    },
    {
      name: "a `//` inside a string on the line above is not a line comment",
      text: '{"url": "https://example.com", "l": [/* keep */\n  1\n]}',
      container: ["l"],
      index: 0,
      after: '{"url": "https://example.com", "l": [/* keep */]}',
    },
    {
      name: "a lone property with a trailing comma collapses its container",
      text: '{"o": {"k": 1,}}',
      container: ["o"],
      index: 0,
      after: '{"o": {}}',
    },
  ];

  test.each(cases)("$name", ({ text, container, index, after }) => {
    const parent = at(text, container);
    const child = parent.children?.[index];
    if (child === undefined) throw new Error("fixture lacks the child");
    expect(removeChild(text, parent, child)).toBe(after);
  });
});

// Add then remove hands back the input on every shape the appended text still tells apart: the
// break appended after a lone member and the break removed with it come from two different rules,
// and a mismatch keeps a line break the user never wrote or drops one they did.
describe("appendChild then removeChild", () => {
  const shapes = [
    "[\n/* keep */]",
    "[\n/* keep */ ]",
    "[\n/* keep */\n]",
    "[\n  /* keep */\n]",
    "[ /* keep */ ]",
    "[/* keep */]",
    "[\n// keep\n]",
    "[\n// keep \n]",
    "[\n  // keep\n  ]",
    "{/* keep */}",
    '["a"]',
    '{"k": 1}',
    '[ "a" ]',
  ];

  test.each(shapes)("%j comes back byte for byte", (shape) => {
    const before = `{"c": ${shape}}`;
    const key = shape.startsWith("{") ? "k2" : null;
    const added = appendChild(before, at(before, ["c"]), key, 1);
    const container = at(added, ["c"]);
    const child = container.children?.at(-1);
    if (child === undefined) throw new Error("append left no child");
    expect(removeChild(added, container, child)).toBe(before);
  });
});

describe("replaceValue", () => {
  test("the new value takes the old node's span and continues at its line indent", () => {
    const text = '{\n  "hooks": [\n    {"old": true}\n  ]\n}\n';
    const node = at(text, ["hooks", 0]);
    expect(replaceValue(text, node, { command: "x", async: true })).toBe(
      '{\n  "hooks": [\n    {\n      "command": "x",\n      "async": true\n    }\n  ]\n}\n',
    );
  });
});

describe("assertParses", () => {
  // The value read back from the returned root, or "refused" for an exit 4 naming the file.
  const cases: [string, string, Record<string, unknown> | "refused"][] = [
    [
      "comments and a trailing comma give the object root",
      '// note\n{"a": [1,], /* c */}\n',
      { a: [1] },
    ],
    ["a truncated file", '{ "a": [', "refused"],
    ["an empty file", "", "refused"],
    ["a top-level array", "[]", "refused"],
    ["a top-level string", '"x"', "refused"],
  ];

  test.each(cases)("%s", (_, text, expected) => {
    const verdict = outcome(() => getNodeValue(assertParses(text, path)));
    if (expected !== "refused") {
      expect(verdict).toEqual({ kind: "value", value: expected });
      return;
    }
    const error = verdict.kind === "threw" ? verdict.error : verdict;
    expect(error).toBeInstanceOf(MaximsError);
    expect((error as MaximsError).code).toBe(ExitCode.DestinationWriteFailed);
    expect((error as MaximsError).message).toContain(path);
  });
});

describe("readConfigText", () => {
  test("an absent or whitespace-only file is null; a directory in its place is exit 4, not absence", async () => {
    await withTempDir(async (dir) => {
      expect(await readConfigText(join(dir, "missing.json"))).toBeNull();
      writeFileSync(join(dir, "touched.json"), " \n");
      expect(await readConfigText(join(dir, "touched.json"))).toBeNull();
      mkdirSync(join(dir, "config.json"));
      let caught: unknown;
      try {
        await readConfigText(join(dir, "config.json"));
      } catch (error) {
        caught = error;
      }
      expect(caught).toBeInstanceOf(MaximsError);
      if (caught instanceof MaximsError) expect(caught.code).toBe(ExitCode.DestinationWriteFailed);
    });
  });
});

// The dialects are what the vendors' own parsers take, which nothing here enforces for us: a
// `JSON.parse` vendor (Claude Code, Codex via serde_json) rejects a comment and a trailing comma,
// Gemini CLI strips comments first and still rejects the comma, OpenCode takes both. A judgment
// looser than the vendor's registers a hook into a file the vendor then skips; a stricter one
// refuses a file the vendor loads. The position is the one a user opens the file at.
describe("parseJsonDocument judges a file as its vendor's parser would", () => {
  type Found = { comment?: string; comma?: string };
  const texts: [string, string, unknown, Found][] = [
    ["plain JSON", '{\n  "a": 1\n}\n', { a: 1 }, {}],
    [
      "a line comment",
      '{\n  // mine\n  "a": 1\n}\n',
      { a: 1 },
      { comment: "a comment at line 2, column 3" },
    ],
    [
      "a block comment",
      '{ "a": /* c */ 1 }',
      { a: 1 },
      { comment: "a comment at line 1, column 8" },
    ],
    [
      "a trailing comma",
      '{\n  "a": [1,]\n}\n',
      { a: [1] },
      { comma: "a trailing comma at line 2, column 10" },
    ],
    [
      "a comment and a later trailing comma",
      '// top\n{ "a": 1, }\n',
      { a: 1 },
      { comment: "a comment at line 1, column 1", comma: "a trailing comma at line 2, column 9" },
    ],
    [
      "a trailing comma in a CR-only file",
      '{\r  "a": 1,\r}',
      { a: 1 },
      { comma: "a trailing comma at line 2, column 9" },
    ],
    [
      "a slash inside a string",
      '{ "url": "https://example.com", "a": 1 }',
      { url: "https://example.com", a: 1 },
      {},
    ],
    ["a comma inside a string before the brace", '{ "a": "x," }', { a: "x," }, {}],
  ];
  const dialects: [JsonDialect, (found: Found) => string | undefined][] = [
    ["json", (found) => found.comment ?? found.comma],
    ["json-with-comments", (found) => found.comma],
    ["jsonc", () => undefined],
  ];
  const rows = texts.flatMap(([name, text, value, found]) =>
    dialects.map(([dialect, offence]) => ({ name, text, value, dialect, reason: offence(found) })),
  );

  test.each(rows)("$name read as $dialect", ({ text, value, dialect, reason }) => {
    const document = parseJsonDocument(text, jsonReader(dialect, "Vendor"));
    if (reason === undefined) {
      if (document.kind !== "root") throw new Error(`refused: ${JSON.stringify(document)}`);
      expect(getNodeValue(document.root)).toEqual(value);
      return;
    }
    const spelled =
      dialect === "json" ? "strict JSON" : "JSON with comments and no trailing commas";
    expect(document).toEqual({ kind: "dialect", reason: `${reason}; Vendor reads ${spelled}` });
  });

  test("a file nothing parses is a syntax reading in every dialect, with the first error's offset", () => {
    for (const dialect of ["json", "json-with-comments", "jsonc"] as const) {
      expect(parseJsonDocument('{ "a": [', jsonReader(dialect, "Vendor"))).toEqual({
        kind: "syntax",
        reason: "CloseBracketExpected at offset 8",
      });
    }
  });

  test("assertParses refuses a dialect offence naming the file, the construct and the vendor", () => {
    const verdict = outcome(() =>
      assertParses('{ "a": 1, }', path, jsonReader("json", "Claude Code")),
    );
    expect(verdict).toMatchObject({
      kind: "threw",
      error: {
        name: "MaximsError",
        code: ExitCode.DestinationWriteFailed,
        message: `cannot edit ${path}: a trailing comma at line 1, column 9; Claude Code reads strict JSON`,
      },
    });
  });
});
