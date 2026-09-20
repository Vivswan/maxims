// Guards the two facts Copilot enforces silently: an instructions file without `applyTo: "**"` is
// path-scoped instead of always-loaded, and a hooks file without `version: 1` or the `bash` key is
// ignored by the CLI and the cloud agent. Both are pinned as the bytes the writer will emit.
import { expect, test } from "bun:test";
import { join } from "node:path";
import { parse } from "yaml";
import { hookSpecFor, type Scope } from "../contract.ts";
import { copilot } from "./index.ts";

const frontmatters: [Scope, string[] | undefined, string][] = [
  ["project", undefined, '"**"'],
  ["global", undefined, '"**"'],
  ["project", [], '"**"'],
  ["project", ["src/**", "docs/**"], "src/**,docs/**"],
];

test.each(frontmatters)(
  "the %s instructions frontmatter applies to every file unless paths narrow it (%p)",
  (scope, paths, expected) => {
    const rendered = copilot.targets[scope].frontmatter({ paths });
    expect(rendered).toBe(`applyTo: ${expected}\n`);
    expect(parse(rendered)).toEqual({ applyTo: expected.replaceAll('"', "") });
  },
);

test("the hooks file is versioned, keyed by `bash`, and times out in seconds", () => {
  expect(copilot.hook.render(hookSpecFor(copilot))).toBe(
    [
      "{",
      '  "version": 1,',
      '  "hooks": {',
      '    "sessionStart": [',
      "      {",
      '        "type": "command",',
      '        "bash": "npx -y maxims sync --quiet",',
      '        "timeoutSec": 20',
      "      }",
      "    ]",
      "  }",
      "}",
      "",
    ].join("\n"),
  );
});

test("$COPILOT_HOME moves the user hooks file, even when relative", () => {
  const ctx = { home: "/home/user", projectRoot: null, env: { COPILOT_HOME: "custom-copilot" } };
  expect(copilot.hook.path("global", ctx)).toBe(
    join(process.cwd(), "custom-copilot", "hooks", "maxims.json"),
  );
});
