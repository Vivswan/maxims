// Guards the two facts Copilot enforces silently: an instructions file without `applyTo: "**"` is
// path-scoped instead of always-loaded; a hooks file without `version: 1` is ignored, and one missing
// the `bash` or `powershell` key is inert on that platform. Both are pinned as the bytes the writer
// emits, at the paths Copilot reads.
import { expect, test } from "bun:test";
import { parse } from "yaml";
import type { Scope, SourceSlug } from "../../../src/harnesses/contract.ts";
import { copilot } from "../../../src/harnesses/copilot/spec.ts";
import { hasHook, planFileHookWrite } from "../../../src/harnesses/hook-writer.ts";
import { planRulesDirWrite } from "../../../src/harnesses/strategies/rules-dir.ts";
import { assertInsideRoot } from "../../../src/util/fs.ts";
import { exampleContext as ctx } from "../context.ts";

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
        sourceSlug: "example-user-doctrine" as SourceSlug,
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
