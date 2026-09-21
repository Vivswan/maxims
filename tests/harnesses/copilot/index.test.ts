// Guards the two facts Copilot enforces silently: an instructions file without `applyTo: "**"` is
// path-scoped instead of always-loaded; a hooks file without `version: 1` is ignored, and one missing
// the `bash` or `powershell` key is inert on that platform. Both are pinned as the bytes the writer
// emits, at the paths Copilot reads. Also guards that the user-level files follow $COPILOT_HOME and
// that the variable alone never counts as an install.
import { expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parse } from "yaml";
import { type HarnessContext, type Scope, scopeRoot } from "../../../src/harnesses/contract.ts";
import { copilot } from "../../../src/harnesses/copilot/index.ts";
import { hasHook, planFileHookWrite } from "../../../src/harnesses/hook-writer.ts";
import { planRulesDirWrite } from "../../../src/harnesses/strategies/rules-dir.ts";
import { assertInsideRoot } from "../../../src/util/fs.ts";
import { withTempDir } from "../../shared/temp_dir.ts";

const ctx: HarnessContext = { home: "/home/user", projectRoot: "/home/user/project", env: {} };
const block =
  "<!-- maxims:begin @example-user/doctrine sha=1 -->\n<!-- maxims:end @example-user/doctrine -->\n";

function rulesDir(scope: Scope) {
  const target = copilot.targets[scope];
  if (target?.kind !== "rules-dir") throw new Error("Copilot writes an instructions directory");
  return target;
}

const frontmatters: [Scope, string[] | undefined, string][] = [
  ["project", undefined, '"**"'],
  ["global", undefined, '"**"'],
  ["project", [], '"**"'],
  ["project", ["src/**", "docs/**"], "src/**,docs/**"],
];

// Copilot reads `applyTo` only from a `---`-delimited YAML block; a bare `applyTo:` line is body
// text, so the delimiters are part of the pinned bytes.
test.each(frontmatters)(
  "the %s instructions frontmatter applies to every file unless paths narrow it (%p)",
  (scope, paths, expected) => {
    const rendered = rulesDir(scope).frontmatter?.({ paths }) ?? "";
    expect(rendered).toBe(`---\napplyTo: ${expected}\n---\n`);
    expect(parse(rendered.slice("---\n".length, -"---\n".length))).toEqual({
      applyTo: expected.replaceAll('"', ""),
    });
  },
);

const files: [Scope, string, string, string][] = [
  [
    "project",
    "/home/user/project",
    "/home/user/project/.github/instructions/maxims-example-user-doctrine.instructions.md",
    "/home/user/project/.github/hooks/maxims.json",
  ],
  [
    "global",
    "/home/user",
    "/home/user/.copilot/instructions/maxims-example-user-doctrine.instructions.md",
    "/home/user/.copilot/hooks/maxims.json",
  ],
];

test.each(files)(
  "the %s instructions file and hooks file land where Copilot reads them",
  (scope, root, rulePath, hookPath) => {
    const target = rulesDir(scope);
    expect(
      planRulesDirWrite({
        def: copilot,
        target,
        scope,
        ctx,
        sourceSlug: "example-user-doctrine",
        block,
      }),
    ).toEqual([
      {
        kind: "write",
        path: assertInsideRoot(root, rulePath),
        content: `---\napplyTo: "**"\n---\n${block}`,
      },
    ]);
    if (!hasHook(copilot, "file")) throw new Error("Copilot writes a hooks file");
    const [written] = planFileHookWrite({
      def: copilot,
      scope,
      ctx,
      wanted: true,
      current: null,
    }).changes;
    expect(written).toEqual({
      kind: "write",
      path: assertInsideRoot(root, hookPath),
      content: [
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
    });
  },
);

test("$COPILOT_HOME moves the user hooks file and instructions dir, even when relative", () => {
  const relative = {
    home: "/home/user",
    projectRoot: null,
    env: { COPILOT_HOME: "custom-copilot" },
  };
  const copilotHome = join(process.cwd(), "custom-copilot");
  if (!hasHook(copilot, "file")) throw new Error("Copilot writes a hooks file");
  expect(copilot.hook.path("global", relative)).toBe(join(copilotHome, "hooks", "maxims.json"));
  expect(join(scopeRoot(copilot, "global", relative), rulesDir("global").dir)).toBe(
    join(copilotHome, "instructions"),
  );
});

// A shell that exports $COPILOT_HOME everywhere must not make maxims report Copilot present: the
// directory is the evidence, the variable only says where to look, and a stray file at that path
// is no config directory either.
test("detection follows the config directory, not the exported variable", async () => {
  await withTempDir((dir) => {
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
