// The splices edit files the user also owns: a member rendered in the wrong indent style, a comma
// dropped or doubled, a comment lost with the node beside it, or a broken file rewritten as if it
// parsed would each survive a shape check and still wreck the user's config.
import { describe, expect, test } from "bun:test";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { findNodeAtLocation, getNodeValue, type Node } from "jsonc-parser";
import { withTempDir } from "../../tests/shared/temp_dir.ts";
import { ExitCode, MaximsError } from "./exit-codes.ts";
import { appendChild, assertParses, readConfigText, removeChild, replaceValue } from "./jsonc.ts";

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
  test.each([
    ["a truncated file", '{ "a": ['],
    ["an empty file", ""],
    ["a top-level array", "[]"],
    ["a top-level string", '"x"'],
  ])("refuses %s as exit 4 naming the file", (_, text) => {
    let caught: unknown;
    try {
      assertParses(text, path);
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(MaximsError);
    if (!(caught instanceof MaximsError)) return;
    expect(caught.code).toBe(ExitCode.DestinationWriteFailed);
    expect(caught.message).toContain(path);
  });

  test("accepts comments and trailing commas and returns the object root", () => {
    const root = assertParses('// note\n{"a": [1,], /* c */}\n', path);
    expect(getNodeValue(root)).toEqual({ a: [1] });
  });
});

describe("readConfigText", () => {
  test("an absent file is null; a directory in its place is exit 4, not absence", async () => {
    await withTempDir(async (dir) => {
      expect(await readConfigText(join(dir, "missing.json"))).toBeNull();
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
