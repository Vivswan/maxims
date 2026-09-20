// Guards the Cursor facts nothing else enforces: a rule file is loaded only as `.mdc` with
// `alwaysApply: true` in its frontmatter, and a project hook lands in the project's own
// `.cursor/hooks.json` rather than the user's.
import { expect, test } from "bun:test";
import { parse } from "yaml";
import { ExitCode, MaximsError } from "../../util/exit-codes.ts";
import { hookSpecFor } from "../contract.ts";
import { cursor } from "./index.ts";

const ctx = { home: "/home/user", projectRoot: "/home/user/project", env: {} };

function frontmatterOf(text: string): Record<string, unknown> {
  const match = /^---\n([\s\S]*?)---\n$/.exec(text);
  if (match === null) throw new Error(`no frontmatter block in ${JSON.stringify(text)}`);
  return parse(match[1] ?? "");
}

test("the project rule is an .mdc whose frontmatter applies it to every session", () => {
  const target = cursor.targets.project;
  if (target?.kind !== "rules-dir") throw new Error("Cursor writes a rules directory");
  expect(target.fileName("example-skills")).toBe("maxims-example-skills.mdc");
  expect(frontmatterOf(target.frontmatter?.({}) ?? "")).toMatchObject({ alwaysApply: true });
  expect(frontmatterOf(target.frontmatter?.({ paths: ["src/**/*.ts"] }) ?? "")).toMatchObject({
    alwaysApply: false,
    globs: ["src/**/*.ts"],
  });
});

test("the hook handler is one command entry in seconds under the scope's hooks.json", () => {
  if (cursor.hook.kind !== "registry") throw new Error("Cursor registers a command hook");
  expect(cursor.hook.path("project", ctx)).toBe("/home/user/project/.cursor/hooks.json");
  expect(cursor.hook.path("global", ctx)).toBe("/home/user/.cursor/hooks.json");
  expect(cursor.hook.handler(hookSpecFor(cursor))).toEqual({
    type: "command",
    command: "npx -y @vivswan/maxims sync --quiet",
    timeout: 20,
  });
  let caught: unknown;
  try {
    cursor.hook.path("project", { ...ctx, projectRoot: null });
  } catch (error) {
    caught = error;
  }
  expect(caught).toBeInstanceOf(MaximsError);
  expect(caught).toMatchObject({ code: ExitCode.Usage });
});
