// Guards the two resolutions every strategy and hook path shares: a project target with no project
// root must be a usage error, a harness's global root override must win over the maxims home, or
// a Codex or Copilot user with a relocated config dir gets files in the wrong place; and a
// shared-block target with a precedence list must land in the file the harness reads first, or
// the block goes into a file it never opens.
import { expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { type HarnessContext, scopeRoot, sharedBlockFile } from "../../src/harnesses/contract.ts";
import { ExitCode } from "../../src/util/exit-codes.ts";
import { outcome } from "../shared/outcome.ts";
import { withTempDir } from "../shared/temp_dir.ts";

const ctx: HarnessContext = {
  home: "/home/user/.agents/maxims",
  projectRoot: "/home/user/project",
  cwd: "/home/user/project",
  env: { CODEX_HOME: "/home/user/.config/codex" },
};

test("scopeRoot: project root for project scope, overridable home for global scope", () => {
  expect(scopeRoot({}, "project", ctx)).toBe("/home/user/project");
  expect(scopeRoot({}, "global", ctx)).toBe("/home/user/.agents/maxims");
  const codexLike = { globalRoot: (c: HarnessContext) => c.env.CODEX_HOME ?? c.home };
  expect(scopeRoot(codexLike, "global", ctx)).toBe("/home/user/.config/codex");
});

test("scopeRoot: a project target outside any project is a usage error", () => {
  expect(outcome(() => scopeRoot({}, "project", { ...ctx, projectRoot: null }))).toMatchObject({
    kind: "threw",
    error: { name: "MaximsError", code: ExitCode.Usage },
  });
});

// A directory bearing a listed name is skipped: Cline's `.clinerules/` is a folder in current
// projects, and a folder holds no block. A name under a regular file is skipped too: Bun's
// statSync throws ENOTDIR for it even with throwIfNoEntry off, and a project with a `.github`
// FILE would otherwise crash every Copilot-style precedence walk.
test("sharedBlockFile: the first listed regular file wins, else the declared default", async () => {
  const target = {
    kind: "shared-block" as const,
    file: "AGENTS.md",
    precedence: [
      ".rules",
      ".clinerules",
      ".github/copilot-instructions.md",
      "AGENTS.md",
      "CLAUDE.md",
    ],
  };
  await withTempDir((root) => {
    const chosen = () => outcome(() => sharedBlockFile(target, root));
    expect(chosen()).toEqual({ kind: "value", value: "AGENTS.md" });
    writeFileSync(join(root, "CLAUDE.md"), "");
    expect(chosen()).toEqual({ kind: "value", value: "CLAUDE.md" });
    mkdirSync(join(root, ".clinerules"));
    writeFileSync(join(root, ".github"), "");
    expect(chosen()).toEqual({ kind: "value", value: "CLAUDE.md" });
    writeFileSync(join(root, "AGENTS.md"), "");
    expect(chosen()).toEqual({ kind: "value", value: "AGENTS.md" });
    writeFileSync(join(root, ".rules"), "");
    expect(chosen()).toEqual({ kind: "value", value: ".rules" });
    expect(sharedBlockFile({ kind: "shared-block", file: "GEMINI.md" }, root)).toBe("GEMINI.md");
  });
});
