// Refuses to run outside scripts/run_tests.ts: a bare `bun test` would inherit the developer's real
// HOME and every test that writes harness config would land in it.
import { realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve, sep } from "node:path";

if (process.env.MAXIMS_TEST_LAUNCHER !== "1") {
  throw new Error(
    "tests run only through `bun run test` (scripts/run_tests.ts), not bare `bun test`",
  );
}

const home = process.env.HOME;
if (home === undefined || home === "") throw new Error("the test launcher must set HOME");
const realHome = realpathSync(resolve(home));
const realTmp = realpathSync(tmpdir());
if (realHome !== realTmp && !realHome.startsWith(realTmp + sep)) {
  throw new Error(`HOME must be under the OS tmpdir (${realTmp}), got ${realHome}`);
}
