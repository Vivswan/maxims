// Guards the one scope-to-directory resolution every strategy and hook path shares: a project
// target with no project root must be a usage error, and a harness's global root override must win
// over the maxims home, or a Codex or Copilot user with a relocated config dir gets files in the
// wrong place.
import { expect, test } from "bun:test";
import { ExitCode, type MaximsError } from "../util/exit-codes.ts";
import { type HarnessContext, scopeRoot } from "./contract.ts";

const ctx: HarnessContext = {
  home: "/home/user/.agents/maxims",
  projectRoot: "/home/user/project",
  env: { CODEX_HOME: "/home/user/.config/codex" },
};

test("scopeRoot: project root for project scope, overridable home for global scope", () => {
  expect(scopeRoot({}, "project", ctx)).toBe("/home/user/project");
  expect(scopeRoot({}, "global", ctx)).toBe("/home/user/.agents/maxims");
  const codexLike = { globalRoot: (c: HarnessContext) => c.env.CODEX_HOME ?? c.home };
  expect(scopeRoot(codexLike, "global", ctx)).toBe("/home/user/.config/codex");
});

test("scopeRoot: a project target outside any project is a usage error", () => {
  let caught: unknown;
  try {
    scopeRoot({}, "project", { ...ctx, projectRoot: null });
  } catch (error) {
    caught = error;
  }
  expect((caught as MaximsError).code).toBe(ExitCode.Usage);
});
