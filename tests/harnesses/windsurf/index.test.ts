// Guards what Cascade enforces silently: a rules file without `trigger: always_on` is not injected
// on every message, a `--paths` install is `trigger: glob` with the patterns under `globs`, and the
// `pre_user_prompt` entry names both `command` and `powershell` (a `powershell`-only entry is
// silently skipped on macOS and Linux, and a `command`-only one runs on Windows only through the
// `powershell -Command` fallback) and no timeout field.
import { expect, test } from "bun:test";
import { hookSpecFor } from "../../../src/harnesses/contract.ts";
import { windsurf } from "../../../src/harnesses/windsurf/spec.ts";

test("a project rule file is always-on by frontmatter and glob-triggered under --paths", () => {
  const target = windsurf.targets.project;
  if (target?.kind !== "rules-dir" || target.frontmatter === undefined) {
    throw new Error("expected a rules directory with frontmatter");
  }
  expect(target.frontmatter({})).toBe("---\ntrigger: always_on\n---\n");
  expect(target.frontmatter({ paths: ["src/**", "docs/**"] })).toBe(
    "---\ntrigger: glob\nglobs: src/**,docs/**\n---\n",
  );
});

test("the pre_user_prompt entry carries both shells and no timeout", () => {
  if (windsurf.hook.kind !== "registry") throw new Error("expected a registry hook");
  expect(JSON.stringify(windsurf.hook.handler(hookSpecFor(windsurf)))).toBe(
    '{"command":"npx -y @vivswan/maxims sync --quiet","powershell":"npx -y @vivswan/maxims sync --quiet","show_output":false}',
  );
});
