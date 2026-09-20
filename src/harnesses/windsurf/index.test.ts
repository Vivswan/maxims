// Guards what Cascade enforces silently: a rules file without `trigger: always_on` is not injected
// on every message, `--paths` has no documented form so it is refused rather than written as
// always-on, the `pre_user_prompt` entry names both `command` and `powershell` (an entry with one
// is skipped on the other platform) and no timeout field, and the global block goes into the
// single `global_rules.md` under `~/.codeium/windsurf/memories`.
import { expect, test } from "bun:test";
import { join } from "node:path";
import { ExitCode, MaximsError } from "../../util/exit-codes.ts";
import { hookSpecFor, scopeRoot } from "../contract.ts";
import { windsurf } from "./index.ts";

const ctx = { home: "/home/user", projectRoot: "/home/user/project", env: {} };

test("a project rule file is always-on by frontmatter and refuses a path filter", () => {
  const target = windsurf.targets.project;
  if (target?.kind !== "rules-dir" || target.frontmatter === undefined) {
    throw new Error("expected a rules directory with frontmatter");
  }
  expect(target.frontmatter({})).toBe("---\ntrigger: always_on\n---\n");
  expect(target.fileName("example-user-doctrine")).toBe("maxims-example-user-doctrine.md");
  let caught: unknown;
  try {
    target.frontmatter({ paths: ["src/**"] });
  } catch (error) {
    caught = error;
  }
  expect(caught).toBeInstanceOf(MaximsError);
  if (!(caught instanceof MaximsError)) throw new Error("expected a MaximsError");
  expect(caught.code).toBe(ExitCode.Usage);
});

test("the pre_user_prompt entry carries both shells and no timeout", () => {
  if (windsurf.hook.kind !== "registry") throw new Error("expected a registry hook");
  expect(JSON.stringify(windsurf.hook.handler(hookSpecFor(windsurf)))).toBe(
    '{"command":"npx -y @vivswan/maxims sync --quiet","powershell":"npx -y @vivswan/maxims sync --quiet","show_output":false}',
  );
  expect(windsurf.hook.path("project", ctx)).toBe("/home/user/project/.windsurf/hooks.json");
  expect(windsurf.hook.path("global", ctx)).toBe("/home/user/.codeium/windsurf/hooks.json");
});

test("the global block goes into the one memories file Cascade reads", () => {
  const target = windsurf.targets.global;
  if (target?.kind !== "shared-block") throw new Error("expected a shared block");
  expect(join(scopeRoot(windsurf, "global", ctx), target.file)).toBe(
    "/home/user/.codeium/windsurf/memories/global_rules.md",
  );
});
