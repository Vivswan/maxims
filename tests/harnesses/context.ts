// The example machine the harness tests plan against. Its roots are spelled through `resolve` so
// a plan, which resolves every path it writes, agrees with them on either separator.
import { resolve } from "node:path";
import type { HarnessContext } from "../../src/harnesses/contract.ts";

export const exampleHome = resolve("/home/user");
export const exampleProjectRoot = resolve("/home/user/project");
export const exampleContext: HarnessContext = {
  home: exampleHome,
  projectRoot: exampleProjectRoot,
  cwd: exampleProjectRoot,
  env: {},
};
