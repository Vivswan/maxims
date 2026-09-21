// Guards Zed's one-file rule: it loads the first of nine instruction files that exists and ignores
// the rest, so a block written to AGENTS.md beside a `.rules` file never loads, and an AGENTS.md
// created beside the user's CLAUDE.md would silence theirs. Also guards that the global file
// follows `$XDG_CONFIG_HOME/zed`.
import { expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { scopeRoot, sharedBlockFile } from "../../../src/harnesses/contract.ts";
import { zed } from "../../../src/harnesses/zed/index.ts";
import { withTempDir } from "../../shared/temp_dir.ts";

const repos: [string, string[], string][] = [
  ["a bare repository", [], "AGENTS.md"],
  ["a repository with .rules beside AGENTS.md", [".rules", "AGENTS.md"], ".rules"],
  ["a repository with only CLAUDE.md", ["CLAUDE.md"], "CLAUDE.md"],
  ["a repository with AGENTS.md and CLAUDE.md", ["AGENTS.md", "CLAUDE.md"], "AGENTS.md"],
  [
    "a repository with a .clinerules directory and Copilot instructions",
    [".clinerules/", ".github/copilot-instructions.md", "GEMINI.md"],
    ".github/copilot-instructions.md",
  ],
];

test.each(repos)(
  "the project block goes into the file Zed reads in %s",
  async (_, files, expected) => {
    const target = zed.targets.project;
    if (target?.kind !== "shared-block") throw new Error("expected a shared block");
    await withTempDir((repo) => {
      for (const file of files) {
        if (file.endsWith("/")) {
          mkdirSync(join(repo, file), { recursive: true });
        } else {
          mkdirSync(join(repo, file, ".."), { recursive: true });
          writeFileSync(join(repo, file), "");
        }
      }
      expect(sharedBlockFile(target, repo)).toBe(expected);
    });
  },
);

test("the personal AGENTS.md follows XDG_CONFIG_HOME/zed and defaults to ~/.config/zed", () => {
  const target = zed.targets.global;
  if (target?.kind !== "shared-block") throw new Error("expected a shared block");
  const home = resolve("/home/user");
  expect(join(scopeRoot(zed, "global", { home, projectRoot: null, env: {} }), target.file)).toBe(
    resolve("/home/user/.config/zed/AGENTS.md"),
  );
  const xdg = { home, projectRoot: null, env: { XDG_CONFIG_HOME: resolve("/xdg") } };
  expect(join(scopeRoot(zed, "global", xdg), target.file)).toBe(resolve("/xdg/zed/AGENTS.md"));
  expect(zed.mcp?.path("global", xdg)).toBe(resolve("/xdg/zed/settings.json"));
});
