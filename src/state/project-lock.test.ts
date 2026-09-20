// Guards the project lock as a committed, shared file: two machines writing the same intent must
// produce identical bytes (key order, field order, indentation, trailing newline), a machine-local
// fact (an absolute path, a fetch timestamp) must be refused so it never lands in a repository,
// and a hand edit that breaks the shape must be refused whole rather than half obeyed.
import { describe, expect, test } from "bun:test";
import { type MemoryName, parseMemoryName } from "../memory/contract.ts";
import { type ProjectLock, parseProjectLock, serializeProjectLock } from "./project-lock.ts";

function memoryName(candidate: string): MemoryName {
  const name = parseMemoryName(candidate);
  if (name === null) throw new Error(`test fixture name is not kebab-case: ${candidate}`);
  return name;
}

// Sources and rename keys are given out of order on purpose: the serializer must sort them.
const LOCK: ProjectLock = {
  version: 1,
  sources: {
    "https://gitlab.example.com/team/rules.git#v2": {
      from: { type: "git", url: "https://gitlab.example.com/team/rules.git" },
      pin: "v2",
      select: "*",
      rule: false,
      harnesses: ["codex"],
      auth: true,
    },
    "./memories": {
      from: { type: "local", path: "./memories", live: true },
      select: [memoryName("short-rule")],
      rule: true,
      harnesses: ["claude-code"],
      memoryPath: "rules",
      fullDepth: true,
      copy: true,
      paths: ["src/**"],
    },
    "@example-user/rules": {
      from: { type: "github", repo: "example-user/rules" },
      select: [memoryName("rubber-duck-before-every-commit")],
      rename: {
        [memoryName("zeta")]: memoryName("zeta-local"),
        [memoryName("gate-exit-conditions-the-merge")]: memoryName("gate-exit-local"),
      },
      rule: true,
      harnesses: ["claude-code", "codex"],
      allowHidden: true,
    },
  },
  disabled: [memoryName("alpha"), memoryName("beta")],
};

const SERIALIZED = [
  "{",
  '  "version": 1,',
  '  "sources": {',
  '    "./memories": {',
  '      "from": {',
  '        "type": "local",',
  '        "path": "./memories",',
  '        "live": true',
  "      },",
  '      "select": [',
  '        "short-rule"',
  "      ],",
  '      "rule": true,',
  '      "harnesses": [',
  '        "claude-code"',
  "      ],",
  '      "memoryPath": "rules",',
  '      "fullDepth": true,',
  '      "copy": true,',
  '      "paths": [',
  '        "src/**"',
  "      ]",
  "    },",
  '    "@example-user/rules": {',
  '      "from": {',
  '        "type": "github",',
  '        "repo": "example-user/rules"',
  "      },",
  '      "select": [',
  '        "rubber-duck-before-every-commit"',
  "      ],",
  '      "rename": {',
  '        "gate-exit-conditions-the-merge": "gate-exit-local",',
  '        "zeta": "zeta-local"',
  "      },",
  '      "rule": true,',
  '      "harnesses": [',
  '        "claude-code",',
  '        "codex"',
  "      ],",
  '      "allowHidden": true',
  "    },",
  '    "https://gitlab.example.com/team/rules.git#v2": {',
  '      "from": {',
  '        "type": "git",',
  '        "url": "https://gitlab.example.com/team/rules.git"',
  "      },",
  '      "pin": "v2",',
  '      "select": "*",',
  '      "rule": false,',
  '      "harnesses": [',
  '        "codex"',
  "      ],",
  '      "auth": true',
  "    }",
  "  },",
  '  "disabled": [',
  '    "alpha",',
  '    "beta"',
  "  ]",
  "}",
  "",
].join("\n");

describe("project lock", () => {
  test("serializes to sorted, two-space, newline-terminated bytes and round-trips", () => {
    const bytes = serializeProjectLock(LOCK);
    expect(bytes).toBe(SERIALIZED);
    const parsed = parseProjectLock(bytes);
    expect(parsed).toEqual({ ok: "parsed", lock: LOCK });
    if (parsed.ok !== "parsed") return;
    expect(serializeProjectLock(parsed.lock)).toBe(bytes);
  });

  const corrupt: { title: string; text: string; issue: RegExp }[] = [
    { title: "not JSON", text: "{", issue: /JSON/ },
    {
      title: "a newer version",
      text: SERIALIZED.replace('"version": 1', '"version": 2'),
      issue: /^version/,
    },
    {
      title: "a key that is not the source's canonical key",
      text: SERIALIZED.replace('"@example-user/rules": {', '"@Example-User/rules": {'),
      issue: /sources\.@Example-User\/rules: source key must be @example-user\/rules/,
    },
    {
      title: "a pinned key whose entry lost its pin",
      text: SERIALIZED.replace('      "pin": "v2",\n', ""),
      issue: /source key must be https:\/\/gitlab\.example\.com\/team\/rules\.git$/,
    },
    {
      title: "an absolute local path",
      text: SERIALIZED.replaceAll("./memories", "/home/user/memories"),
      issue: /from\.path: expected a path relative to the project/,
    },
    {
      title: "a Windows drive path, whichever platform reads the lock",
      text: SERIALIZED.replaceAll("./memories", "C:/memories"),
      issue: /from\.path: expected a path relative to the project/,
    },
    {
      title: "a Windows drive-relative path",
      text: SERIALIZED.replaceAll("./memories", "C:memories"),
      issue: /from\.path: expected a path relative to the project/,
    },
    {
      title: "two github keys that differ only in case",
      text: SERIALIZED.replace(
        '    "https://gitlab.example.com/team/rules.git#v2": {',
        [
          '    "@Example-User/rules": {',
          '      "from": {',
          '        "type": "github",',
          '        "repo": "Example-User/rules"',
          "      },",
          '      "select": "*",',
          '      "rule": true,',
          '      "harnesses": [',
          '        "codex"',
          "      ]",
          "    },",
          '    "https://gitlab.example.com/team/rules.git#v2": {',
        ].join("\n"),
      ),
      issue:
        /sources\.@Example-User\/rules: names the same GitHub repository as @example-user\/rules/,
    },
    {
      title: "a pin on a local source",
      text: SERIALIZED.replace(
        '        "live": true\n      },\n',
        '        "live": true\n      },\n      "pin": "v1",\n',
      ),
      issue: /pin/,
    },
    {
      title: "an empty memory folder",
      text: SERIALIZED.replace('"memoryPath": "rules"', '"memoryPath": ""'),
      issue: /memoryPath/,
    },
    {
      title: "a fetch timestamp",
      text: SERIALIZED.replace(
        '      "pin": "v2",\n',
        '      "pin": "v2",\n      "fetchedAt": "2026-08-27T04:12:09.113Z",\n',
      ),
      issue: /fetchedAt/,
    },
    {
      title: "a destination",
      text: SERIALIZED.replace(
        '      "pin": "v2",\n',
        '      "pin": "v2",\n      "destination": { "scope": "global" },\n',
      ),
      issue: /destination/,
    },
    {
      title: "an unsorted disabled list",
      text: SERIALIZED.replace('"alpha",\n    "beta"', '"beta",\n    "alpha"'),
      issue: /^disabled\.1: must be sorted after beta/,
    },
    {
      title: "a ref carrying the marker terminator",
      text: SERIALIZED.replace('"pin": "v2"', '"pin": "v2-->"').replace(
        "rules.git#v2",
        "rules.git#v2-->",
      ),
      issue: /pin: a ref cannot contain -->/,
    },
  ];
  test.each(corrupt)("is corrupt: $title", ({ text, issue }) => {
    const result = parseProjectLock(text);
    expect(result.ok).toBe("corrupt");
    if (result.ok !== "corrupt") return;
    expect(result.issues.some((line) => issue.test(line))).toBe(true);
  });
});
