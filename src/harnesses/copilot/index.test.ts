// Guards the two facts Copilot enforces silently: an instructions file without `applyTo: "**"` is
// path-scoped instead of always-loaded; a hooks file without `version: 1` is ignored, and one missing
// the `bash` or `powershell` key is inert on that platform. Both are pinned as the bytes the writer
// emits. Also guards that the user-level files follow $COPILOT_HOME and that the variable alone never
// counts as an install.
import { expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parse } from "yaml";
import { withTempDir } from "../../../tests/shared/temp_dir.ts";
import { hookSpecFor, type Scope, scopeRoot } from "../contract.ts";
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

test("the hooks file is versioned, carries bash and powershell, and times out in seconds", () => {
  expect(copilot.hook.render(hookSpecFor(copilot))).toBe(
    [
      "{",
      '  "version": 1,',
      '  "hooks": {',
      '    "sessionStart": [',
      "      {",
      '        "type": "command",',
      '        "bash": "npx -y @vivswan/maxims sync --quiet",',
      '        "powershell": "npx -y @vivswan/maxims sync --quiet",',
      '        "timeoutSec": 20',
      "      }",
      "    ]",
      "  }",
      "}",
      "",
    ].join("\n"),
  );
});

test("$COPILOT_HOME moves the user hooks file and instructions dir, even when relative", () => {
  const ctx = { home: "/home/user", projectRoot: null, env: { COPILOT_HOME: "custom-copilot" } };
  const copilotHome = join(process.cwd(), "custom-copilot");
  expect(copilot.hook.path("global", ctx)).toBe(join(copilotHome, "hooks", "maxims.json"));
  expect(join(scopeRoot(copilot, "global", ctx), copilot.targets.global.dir)).toBe(
    join(copilotHome, "instructions"),
  );
});

// A shell that exports $COPILOT_HOME everywhere must not make maxims report Copilot present: the
// directory is the evidence, the variable only says where to look, and a stray file at that path
// is no config directory either.
test("detection follows the config directory, not the exported variable", async () => {
  await withTempDir(async (dir) => {
    const home = join(dir, "home");
    const present = join(dir, "present");
    mkdirSync(present, { recursive: true });
    writeFileSync(join(dir, "a-file"), "");
    expect(copilot.detect({ home, projectRoot: null, env: { COPILOT_HOME: present } })).toBe(true);
    expect(
      copilot.detect({ home, projectRoot: null, env: { COPILOT_HOME: join(dir, "missing") } }),
    ).toBe(false);
    expect(
      copilot.detect({ home, projectRoot: null, env: { COPILOT_HOME: join(dir, "a-file") } }),
    ).toBe(false);
    expect(copilot.detect({ home, projectRoot: null, env: {} })).toBe(false);
    mkdirSync(join(home, ".copilot"), { recursive: true });
    expect(copilot.detect({ home, projectRoot: null, env: {} })).toBe(true);
  });
});
