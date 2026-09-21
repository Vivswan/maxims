// Guards what Cascade enforces silently: a rules file without `trigger: always_on` is not injected
// on every message, a `--paths` install is `trigger: glob` with the patterns under `globs`, the
// `pre_user_prompt` entry names both `command` and `powershell` (an entry with one is skipped on
// the other platform) and no timeout field, and the global block goes into the single
// `global_rules.md` under `~/.codeium/windsurf/memories`.
import { expect, test } from "bun:test";
import { join, resolve } from "node:path";
import { hookSpecFor, scopeRoot } from "../../../src/harnesses/contract.ts";
import { windsurf } from "../../../src/harnesses/windsurf/index.ts";

const ctx = { home: resolve("/home/user"), projectRoot: resolve("/home/user/project"), env: {} };

test("a project rule file is always-on by frontmatter and glob-triggered under --paths", () => {
  const target = windsurf.targets.project;
  if (target?.kind !== "rules-dir" || target.frontmatter === undefined) {
    throw new Error("expected a rules directory with frontmatter");
  }
  expect(target.frontmatter({})).toBe("---\ntrigger: always_on\n---\n");
  expect(target.fileName("example-user-doctrine")).toBe("maxims-example-user-doctrine.md");
  expect(target.frontmatter({ paths: ["src/**", "docs/**"] })).toBe(
    "---\ntrigger: glob\nglobs: src/**,docs/**\n---\n",
  );
});

test("the pre_user_prompt entry carries both shells and no timeout", () => {
  if (windsurf.hook.kind !== "registry") throw new Error("expected a registry hook");
  expect(JSON.stringify(windsurf.hook.handler(hookSpecFor(windsurf)))).toBe(
    '{"command":"npx -y @vivswan/maxims sync --quiet","powershell":"npx -y @vivswan/maxims sync --quiet","show_output":false}',
  );
  expect(windsurf.hook.path("project", ctx)).toBe(
    resolve("/home/user/project/.windsurf/hooks.json"),
  );
  expect(windsurf.hook.path("global", ctx)).toBe(
    resolve("/home/user/.codeium/windsurf/hooks.json"),
  );
});

test("the global block goes into the one memories file Cascade reads", () => {
  const target = windsurf.targets.global;
  if (target?.kind !== "shared-block") throw new Error("expected a shared block");
  expect(join(scopeRoot(windsurf, "global", ctx), target.file)).toBe(
    resolve("/home/user/.codeium/windsurf/memories/global_rules.md"),
  );
});
