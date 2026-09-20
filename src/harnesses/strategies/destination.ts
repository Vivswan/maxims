import { resolve } from "node:path";
import { ExitCode, MaximsError } from "../../util/exit-codes.ts";
import type { HarnessContext, Scope } from "../contract.ts";

// Every harness path is asserted inside this root: the project for a project install, the home
// directory for a global one. Relative target directories in a definition resolve against it.
export function destinationRoot(scope: Scope, ctx: HarnessContext): string {
  if (scope === "global") return resolve(ctx.home);
  if (ctx.projectRoot === null) {
    throw new MaximsError(
      ExitCode.Usage,
      "a project install needs a project root; run inside a project or pass -g",
    );
  }
  return resolve(ctx.projectRoot);
}
