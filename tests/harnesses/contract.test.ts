// Guards the two resolutions every strategy and hook path shares: a project target with no project
// root must be a usage error, a harness's global root override must win over the maxims home, or
// a Codex or Copilot user with a relocated config dir gets files in the wrong place; and a
// shared-block target with a precedence list must land in the file the harness reads first, or
// the block goes into a file it never opens.
import { expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { type HarnessContext, scopeRoot, sharedBlockFile } from "../../src/harnesses/contract.ts";
import { ExitCode, type MaximsError } from "../../src/util/exit-codes.ts";
import { withTempDir } from "../shared/temp_dir.ts";

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

// A directory bearing a listed name is skipped: Cline's `.clinerules/` is a folder in current
// projects, and a folder holds no block.
test("sharedBlockFile: the first listed regular file wins, else the declared default", async () => {
  const target = {
    kind: "shared-block" as const,
    file: "AGENTS.md",
    precedence: [".rules", ".clinerules", "AGENTS.md", "CLAUDE.md"],
  };
  await withTempDir((root) => {
    expect(sharedBlockFile(target, root)).toBe("AGENTS.md");
    writeFileSync(join(root, "CLAUDE.md"), "");
    expect(sharedBlockFile(target, root)).toBe("CLAUDE.md");
    mkdirSync(join(root, ".clinerules"));
    expect(sharedBlockFile(target, root)).toBe("CLAUDE.md");
    writeFileSync(join(root, "AGENTS.md"), "");
    expect(sharedBlockFile(target, root)).toBe("AGENTS.md");
    writeFileSync(join(root, ".rules"), "");
    expect(sharedBlockFile(target, root)).toBe(".rules");
    expect(sharedBlockFile({ kind: "shared-block", file: "GEMINI.md" }, root)).toBe("GEMINI.md");
  });
});
