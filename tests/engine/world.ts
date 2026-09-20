import { mkdirSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { type ExitCode, MaximsError } from "../../src/util/exit-codes.ts";
import { withTempDir, withTempHome } from "../shared/temp_dir.ts";
import { fixtureRoot } from "./harness.ts";

export type World = { home: string; dir: string; userHome: string; project: string };

// A temp maxims home, a user home holding `.fixture/`, and a git project holding `.fixture/`.
export async function world<T>(fn: (world: World) => Promise<T>): Promise<T> {
  // Roots are recorded by their real path, so a fixture under a symlinked temp dir names them so.
  return withTempHome((rawHome) =>
    withTempDir(async (rawDir) => {
      const home = realpathSync(rawHome);
      const dir = realpathSync(rawDir);
      const userHome = join(dir, "user");
      const project = join(dir, "project");
      mkdirSync(join(userHome, ".fixture"), { recursive: true });
      mkdirSync(join(project, ".git"), { recursive: true });
      mkdirSync(join(project, ".fixture"), { recursive: true });
      return fn({ home, dir, userHome, project });
    }),
  );
}

export const TWO_MEMORIES = {
  "always-review": { description: "Review before every commit." },
  "keep-tests-green": { description: "Never merge red." },
};

export function globalRulesFile(userHome: string, slug: string): string {
  return join(
    fixtureRoot("global", { home: userHome, projectRoot: null, env: {} }),
    "rules",
    `maxims-${slug}.md`,
  );
}

export async function expectExit(run: Promise<unknown>, code: ExitCode): Promise<MaximsError> {
  try {
    await run;
  } catch (error) {
    if (error instanceof MaximsError && error.code === code) return error;
    throw error;
  }
  throw new Error(`expected exit ${code}`);
}
