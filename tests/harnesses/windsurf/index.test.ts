// Guards what Cascade enforces silently: a rules file without `trigger: always_on` is not injected
// on every message, a `--paths` install is `trigger: glob` with the patterns under `globs`, the
// `pre_user_prompt` entry names both `command` and `powershell` (a `powershell`-only entry is
// silently skipped on macOS and Linux, and a `command`-only one runs on Windows only through the
// `powershell -Command` fallback) and no timeout field, the workspace entry goes into
// `.devin/hooks.json` (Cascade reads the legacy `.windsurf/hooks.json` only while the newer file
// is absent or defines no hooks), the global block goes into the single `global_rules.md` under
// `~/.codeium/windsurf/memories`, and no MCP file is named, since Cascade's `mcp_config.json`
// lives at `~/.config/devin/mcp_config.json` on macOS and Linux (under `$XDG_CONFIG_HOME/devin`
// when that variable is set) and at `%APPDATA%\devin\mcp_config.json` on Windows, outside this
// definition's global root `~/.codeium/windsurf` on every platform.
import { expect, test } from "bun:test";
import { join, resolve } from "node:path";
import { hookSpecFor, type SourceSlug, scopeRoot } from "../../../src/harnesses/contract.ts";
import { windsurf } from "../../../src/harnesses/windsurf/spec.ts";

const ctx = { home: resolve("/home/user"), projectRoot: resolve("/home/user/project"), env: {} };

test("a project rule file is always-on by frontmatter and glob-triggered under --paths", () => {
  const target = windsurf.targets.project;
  if (target?.kind !== "rules-dir" || target.frontmatter === undefined) {
    throw new Error("expected a rules directory with frontmatter");
  }
  expect(target.frontmatter({})).toBe("---\ntrigger: always_on\n---\n");
  expect(target.fileName("example-user-doctrine" as SourceSlug)).toBe(
    "maxims-example-user-doctrine.md",
  );
  expect(target.frontmatter({ paths: ["src/**", "docs/**"] })).toBe(
    "---\ntrigger: glob\nglobs: src/**,docs/**\n---\n",
  );
});

test("the pre_user_prompt entry carries both shells and no timeout", () => {
  if (windsurf.hook.kind !== "registry") throw new Error("expected a registry hook");
  expect(JSON.stringify(windsurf.hook.handler(hookSpecFor(windsurf)))).toBe(
    '{"command":"npx -y @vivswan/maxims sync --quiet","powershell":"npx -y @vivswan/maxims sync --quiet","show_output":false}',
  );
  expect(windsurf.hook.path("project", ctx)).toBe(resolve("/home/user/project/.devin/hooks.json"));
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

test("no MCP file is named: Cascade keeps mcp_config.json outside the global root", () => {
  expect(windsurf.mcp).toBeUndefined();
});
